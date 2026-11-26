locals {
  bootstrap_root = "${path.module}/../cloud-init"
  disk_uuid      = lower(coalesce(var.compute.app_data_uuid, "00000000-0000-0000-0000-000000000000"))
  # Match systemd-escape --path for /dev/disk/by-uuid/<uuid>.
  disk_device_unit = "dev-disk-by\\x2duuid-${replace(local.disk_uuid, "-", "\\x2d")}.device"
  # K3s's adjacent default IPv4 Pod and Service ranges occupy 10.42.0.0/15.
  kubernetes_cidrs = { pods = "10.42.0.0/16", services = "10.43.0.0/16" }
  api_service_ip   = cidrhost(local.kubernetes_cidrs.services, 1)
  network_bounds = {
    for name, cidr in merge(local.kubernetes_cidrs, { vnet = var.network.vnet_cidr }) : name => [
      for host in [0, -1] : sum([
        for i, octet in split(".", cidrhost(cidr, host)) : tonumber(octet) * pow(256, 3 - i)
      ])
    ]
  }

  bootstrap_common = {
    "/usr/local/libexec/astra/configuration.py"      = [file("${path.module}/../lifecycle/configuration.py"), "0644"]
    "/usr/local/libexec/astra/install-platform"      = [file("${path.module}/../lifecycle/install-platform.sh"), "0755"]
    "/etc/astracode/slot"                            = ["${lower(var.target.slot)}\n", "0644"]
    "/usr/local/libexec/astra/node_agent.py"         = [file("${path.module}/../lifecycle/node_agent.py"), "0755"]
    "/usr/local/libexec/astra/node_state.py"         = [file("${path.module}/../lifecycle/node_state.py"), "0644"]
    "/usr/local/libexec/astra/permits.py"            = [file("${path.module}/../lifecycle/permits.py"), "0644"]
    "/etc/systemd/system/astra-node-permits.service" = [file("${path.module}/../lifecycle/astra-node-permits.service"), "0644"]
    "/usr/local/libexec/astra/reset-epochs"          = [file("${path.module}/../lifecycle/reset-epochs.sh"), "0755"]
    "/usr/local/libexec/astra/install-k3s"           = [file("${local.bootstrap_root}/install-k3s.sh"), "0755"]
    "/usr/local/libexec/astra/host-firewall"         = [file("${local.bootstrap_root}/host-firewall.sh"), "0755"]
    "/usr/local/libexec/astra/k3s-credential"        = [file("${local.bootstrap_root}/k3s-credential.py"), "0755"]
    "/etc/systemd/system/astra-host-firewall.service" = [
      file("${local.bootstrap_root}/astra-host-firewall.service"), "0644",
    ]
    "/etc/astracode/k3s-release" = [file("${local.bootstrap_root}/k3s-release"), "0644"]
  }

  k3s_app = {
    "node-ip"                    = local.node_ips.app
    "advertise-address"          = local.node_ips.app
    "tls-san"                    = [local.node_ips.app]
    "tls-san-security"           = true
    "flannel-backend"            = "vxlan"
    "cluster-cidr"               = local.kubernetes_cidrs.pods
    "service-cidr"               = local.kubernetes_cidrs.services
    "secrets-encryption"         = true
    "write-kubeconfig-mode"      = "0600"
    "agent-token-file"           = "/etc/rancher/k3s/app-agent-secret"
    "default-local-storage-path" = "/srv/astracode/data/local-path"
    "node-label"                 = ["astracode.io/node-role=app", "svccontroller.k3s.cattle.io/enablelb=true"]
  }

  k3s_judge = {
    "server"     = "https://${local.node_ips.app}:6443"
    "node-ip"    = local.node_ips.judge
    "token-file" = "/etc/rancher/k3s/judge-agent-token"
    "node-label" = ["astracode.io/node-role=judge"]
    "node-taint" = ["astracode.io/node-role=judge:NoSchedule"]
  }

  bootstrap_app = {
    "/etc/systemd/system/astra-poller.service"     = [file("${path.module}/../lifecycle/astra-poller.service"), "0644"]
    "/etc/systemd/system/astra-activation.service" = [file("${path.module}/../lifecycle/astra-activation.service"), "0644"]
    "/etc/systemd/system/astra-attempt-secret.service" = [
      file("${path.module}/../lifecycle/astra-attempt-secret.service"), "0644",
    ]
    "/usr/local/libexec/astra/attempt_secret.py" = [file("${path.module}/../lifecycle/attempt_secret.py"), "0644"]
    "/usr/local/libexec/astra/app-disk"          = [file("${local.bootstrap_root}/app-disk.py"), "0755"]
    "/etc/astracode/app-data-uuid"               = ["${local.disk_uuid}\n", "0644"]
    "/etc/systemd/system/astra-app-disk.service" = [
      templatefile("${local.bootstrap_root}/astra-app-disk.service.tftpl", { device_unit = local.disk_device_unit }), "0644",
    ]
    "/etc/systemd/system/srv-astracode-data.mount" = [
      templatefile("${local.bootstrap_root}/srv-astracode-data.mount.tftpl", { uuid = local.disk_uuid }), "0644",
    ]
    "/var/lib/rancher/k3s/server/manifests/astra-tester-lease-endpoint.yaml" = [
      yamlencode({
        apiVersion = "discovery.k8s.io/v1"
        kind       = "EndpointSlice"
        metadata = {
          name      = "tester-lease-app"
          namespace = "astracode-app"
          labels = {
            "kubernetes.io/service-name"             = "tester-lease"
            "endpointslice.kubernetes.io/managed-by" = "astracode-platform"
          }
        }
        addressType = "IPv4"
        ports       = [{ name = "forward-auth", protocol = "TCP", port = 18080 }]
        endpoints   = [{ addresses = [local.node_ips.app], conditions = { ready = true } }]
      }), "0644",
    ]
    "/var/lib/rancher/k3s/server/manifests/traefik-config.yaml" = [
      yamlencode({
        apiVersion = "helm.cattle.io/v1"
        kind       = "HelmChartConfig"
        metadata   = { name = "traefik", namespace = "kube-system" }
        spec = {
          valuesContent = yamlencode({
            nodeSelector = { "astracode.io/node-role" = "app" }
          })
        }
      }), "0644",
    ]
  }

  bootstrap_judge = {
    "/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/50-judge.toml" = [
      file("${local.bootstrap_root}/judge-runtime.toml"), "0644"
    ]
    "/etc/astracode/judge-runtime-base.json" = [file("${local.bootstrap_root}/judge-runtime-base.json"), "0644"]
  }

  cloud_config = { for role in keys(local.vm_names) : role => "#cloud-config\n${yamlencode(merge(
    {
      write_files = [
        for path, file in merge(local.bootstrap_common, role == "app" ? local.bootstrap_app : local.bootstrap_judge, {
          "/etc/astracode/node-role" = ["${role}\n", "0644"]
          "/etc/astracode/bootstrap-network" = [
            "${role} ${local.node_ips.app} ${local.node_ips.judge} ${local.api_service_ip}\n", "0644",
          ]
          "/etc/rancher/k3s/config.yaml" = [
            role == "app" ? yamlencode(local.k3s_app) : yamlencode(local.k3s_judge), "0600",
          ]
          "/etc/systemd/system/astra-k3s.service" = [
            templatefile("${local.bootstrap_root}/astra-k3s.service.tftpl", {
              node = role
              mode = role == "app" ? "server" : "agent"
            }), "0644",
          ]
          }) : {
          path        = path
          owner       = "root:root"
          content     = file[0]
          permissions = file[1]
        }
      ]
      runcmd = [["/usr/local/libexec/astra/install-k3s"]]
    },
    role == "app" ? {
      users = concat(["default"], [
        for name in ["astra-poller", "astra-secret-loader", "astra-activation"] : {
          name        = name
          system      = true
          lock_passwd = true
          shell       = "/usr/sbin/nologin"
        }
      ])
    } : {}
  ))}" }
}
