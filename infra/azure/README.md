# M0-13 Azure Terraform

`bootstrap` defines S4 state, recovery and immutable canonical release records in separate storage accounts. `environment` defines the S2/S3 network, App and Judge VMs, retained App disk, runtime Key Vault, Flex Consumption controller and independent heartbeat alert. Each root defines a subscription budget with 50%, 80% and 100% actual-spend alerts.

## Offline verification

Use Terraform 1.13.5. The dependency locks pin AzureRM 4.59.0. The checked-in input examples are synthetic and the test files mock AzureRM.

```sh
terraform fmt -check -recursive infra/azure
for root in bootstrap environment; do
  terraform -chdir="infra/azure/$root" init -backend=false -lockfile=readonly
  terraform -chdir="infra/azure/$root" validate
  terraform -chdir="infra/azure/$root" test -var-file=offline.tfvars.example
done
bash infra/azure/environment/tests/check-retained-disk.sh
```

The disk test seeds state through the mock provider in a disposable directory and checks that retargeting that state or planning disk replacement fails. The offline checks cover Terraform configuration and plan constraints. Azure resource eligibility, operator reachability, role propagation, timer execution and alert delivery require Phase B evidence.

## App and Judge bootstrap

The VM custom data renders separate cloud-init configurations from `cloud-init/`. The installer verifies the pinned Linux amd64 K3s binary before enabling the systemd service. Both roles wait for the host firewall. App runs the server, Traefik and ServiceLB and uses its verified retained disk for local volumes. Judge runs the tainted agent and requires an independently issued, CA-pinned agent token in a root-only file. The protected delivery and rotation procedure requires live Phase B verification. [K3s release and checksums](https://github.com/k3s-io/k3s/releases/tag/v1.35.10%2Bk3s1) · [K3s token roles and formats](https://docs.k3s.io/cli/token)

Set `compute.app_data_uuid` to the approved ext4 filesystem UUID for the App disk at Azure LUN 0. Initialize a fresh disk explicitly during authorized provisioning. The App disk check rejects an absent or mismatched device and the bootstrap performs no formatting. Reattach an existing approved disk as-is and confirm its identity before restarting the App K3s service, which requires the verified mount. Pod traffic to metadata and direct management ports is blocked at the host. The authenticated Kubernetes ClusterIP remains available for required system add-ons. App host IMDS is restricted to the poller and secret loader service accounts. Live placement, boot, mount recovery, join and traffic checks belong to the S3 rehearsal. [Azure Linux disk device aliases](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/azure-virtual-machine-utilities)

Run the bootstrap checks from the repository root after backend-disabled initialization. The Terraform output and container inputs below use synthetic fixtures.

```sh
(
  set -eu
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  terraform -chdir=infra/azure/environment test -var-file=offline.tfvars.example -json -verbose > "$fixture_dir/plan.json"
  python3 infra/azure/cloud-init/tests/extract-cloud-config.py "$fixture_dir" < "$fixture_dir/plan.json"
  python3 -B infra/azure/cloud-init/tests/host_fixtures.py
  docker build -t astra-bootstrap-check infra/azure/cloud-init/tests
  for role in app judge; do
    docker run --rm --network none --cap-add NET_ADMIN \
      --mount "type=bind,src=$fixture_dir,dst=/fixtures,readonly" \
      --mount "type=bind,src=$PWD/infra/azure/cloud-init/tests,dst=/tests,readonly" \
      astra-bootstrap-check python3 /tests/verify-rendered.py "/fixtures/$role.yaml"
  done
)
```

## Scope and activation

- Initial S4 bootstrap starts with protected local state before migration to the matching Blob backend. The output `state_backend` supplies the approved account, tenant, dedicated slot container and key for backend initialization. Check the initialized backend against that output and the approved target before planning. Keep backend inputs and state out of Git. Entra state operators are scoped to their assigned slot containers. Supply reviewed Storage firewall source IPs or subnets for receipt access. Provisioning identities must exclude storage `listKeys` access so AzureRM cannot save storage account keys in state.
- S2 and S3 use independently approved subscriptions and separate state. The provider checks the tenant and subscription, and the first state write binds the target identity. Compute and controller exposure start disabled. Before a later compute plan, verify the controller and monitor are armed, validate the recorded startup approval for the exact VM IDs and confirm Azure Policy and custom power-role propagation. Terraform compares the supplied approval's controller, target and expiry. The controller's own startup record and liveness are checked in the authorized live phase.
- The power roles use a dedicated workload resource group reserved by an enforced Azure Policy for the two planned VM names. This lets the controller and emergency operator have deallocation capability before either VM exists. S3 and emergency access are deallocate-only. The controller uses its own private storage account, separate from S4 state and release data.
- Static IPv4 addresses provide explicit VM egress. Judge accepts only the App peer's cluster traffic. App HTTPS uses explicit tester CIDRs. A dedicated NAT gateway supplies the Flex Consumption subnet's public egress for Azure APIs and telemetry while controller storage uses Private Link. Verify the gateway's eligibility and standing cost in Phase B. Workload admission and controller application deployment follow in subsequent Phase A tasks. [Flex Consumption networking](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options)
- The App data disk is a separately managed resource protected against destruction and replacement while declared. Routine staging shutdown uses VM deallocation. S3 deletion of the retained disk requires the separately approved cleanup and inventory procedure.
