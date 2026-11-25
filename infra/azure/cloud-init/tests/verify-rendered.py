"""Validate one synthetic render inside a disposable Ubuntu container."""

import os
import subprocess
import sys
from pathlib import Path

import yaml


config_path = Path(sys.argv[1])
node = config_path.stem
if node not in {"app", "judge"}:
    raise SystemExit("Expected a synthetic App or Judge bootstrap fixture")
subprocess.run(["cloud-init", "schema", "-c", config_path], check=True)
config = yaml.safe_load(config_path.read_text())

files = {item["path"]: item for item in config["write_files"]}
k3s = yaml.safe_load(files["/etc/rancher/k3s/config.yaml"]["content"])
if {"token", "agent-token", "kubeconfig"} & k3s.keys():
    raise SystemExit("Unexpected inline credential in k3s config")
for path in ["/etc/rancher/k3s/app-agent-secret", "/etc/rancher/k3s/judge-agent-token"]:
    if path in files:
        raise SystemExit("Credential file must be materialized by the trusted node path")

service = files["/etc/systemd/system/astra-k3s.service"]["content"]
if "Requires=astra-host-firewall.service" not in service or "After=cloud-final.service network-online.target astra-host-firewall.service" not in service:
    raise SystemExit("K3s start must be ordered after cloud-init and the required firewall")

if node == "app":
    if "BindsTo=srv-astracode-data.mount" not in service or "app-disk before-k3s" not in service:
        raise SystemExit("Missing App mount dependency and identity check")
    disk_uuid = files["/etc/astracode/app-data-uuid"]["content"].strip()
    device_unit = subprocess.check_output(
        ["systemd-escape", "--path", "--suffix=device", f"/dev/disk/by-uuid/{disk_uuid}"],
        text=True,
    ).strip()
    disk_gate = files["/etc/systemd/system/astra-app-disk.service"]["content"]
    if f"Requires={device_unit}" not in disk_gate or f"After={device_unit}" not in disk_gate:
        raise SystemExit("App disk gate must wait for the approved device on reboot")
    if k3s["default-local-storage-path"] != "/srv/astracode/data/local-path":
        raise SystemExit("App Local Path Provisioner must use the verified mount")
    if "svccontroller.k3s.cattle.io/enablelb=true" not in k3s["node-label"]:
        raise SystemExit("App is the only ServiceLB candidate")
    chart_config = yaml.safe_load(files["/var/lib/rancher/k3s/server/manifests/traefik-config.yaml"]["content"])
    values = yaml.safe_load(chart_config["spec"]["valuesContent"])
    if values["nodeSelector"] != {"astracode.io/node-role": "app"}:
        raise SystemExit("Traefik must be pinned to App")
else:
    if "srv-astracode-data.mount" in service or "agent-token-file" in k3s:
        raise SystemExit("Judge must use only its agent credential and no App disk")
    if k3s["node-taint"] != ["astracode.io/node-role=judge:NoSchedule"]:
        raise SystemExit("Missing dedicated Judge taint")

if not Path("/.dockerenv").exists():
    raise SystemExit("Systemd and firewall fixtures must run only in the disposable container")
for path, item in files.items():
    fixture_file = Path(path)
    fixture_file.parent.mkdir(parents=True, exist_ok=True)
    fixture_file.write_text(item["content"])
    fixture_file.chmod(int(item["permissions"], 8))

subprocess.run(["install", "-m", "0755", "/usr/bin/true", "/usr/local/bin/k3s"], check=True)
units = [path for path in files if path.startswith("/etc/systemd/system/")]
subprocess.run(["systemd-analyze", "verify", "--man=no", *units], check=True)

if node == "app":
    for user in ("astra-poller", "astra-secret-loader"):
        subprocess.run(["useradd", "--system", user], check=True)
check_bin = Path("/tmp/check-only")
check_bin.mkdir()
(check_bin / "nft").write_text(
    "#!/bin/sh\ncat >/tmp/fixture.nft\nexec /usr/sbin/nft --check -f /tmp/fixture.nft\n"
)
(check_bin / "nft").chmod(0o755)
subprocess.run(
    ["/usr/local/libexec/astra/host-firewall"],
    env={**os.environ, "PATH": f"{check_bin}:{os.environ['PATH']}"},
    check=True,
)
rules = Path("/tmp/fixture.nft").read_text()
if ("meta skuid" in rules) != (node == "app") or "ip daddr 169.254.169.254 drop" not in rules:
    raise SystemExit("Unexpected host metadata policy for the node role")
