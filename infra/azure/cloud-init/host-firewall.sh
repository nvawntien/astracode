#!/usr/bin/env bash
set -euo pipefail

read -r role app_ip judge_ip api_service </etc/astracode/bootstrap-network
for ip in "$app_ip" "$judge_ip" "$api_service"; do
  if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Invalid bootstrap IPv4 address." >&2
    exit 1
  fi
done

case "$role" in
  app)
    poller_uid="$(id -u astra-poller)"
    loader_uid="$(id -u astra-secret-loader)"
    imds_allow="ip daddr 169.254.169.254 meta skuid { $poller_uid, $loader_uid } accept"
    ;;
  judge)
    imds_allow=""
    ;;
  *)
    echo "Invalid bootstrap node role." >&2
    exit 1
    ;;
esac

# Replace only our table and do so in one transaction. K3s owns its own rules.
exec nft -f - <<EOF
destroy table inet astra_host
table inet astra_host {
  chain pod_common {
    ip daddr { 169.254.0.0/16, 127.0.0.0/8 } drop
    ip6 daddr { fe80::/10, ::1 } drop
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname { "cni0", "flannel.1", "veth*" } jump pod_input
    iifname != "cni0" tcp dport 18080 drop
  }
  chain pod_input {
    jump pod_common
    # Packaged add-ons use the Kubernetes Service. Direct host management
    # remains closed to Pods, and the Service is still authenticated by k3s.
    tcp dport 6443 ct original ip daddr $api_service ct original proto-dst 443 return
    tcp dport { 22, 2379, 2380, 6443, 10250 } drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    jump pod_common
    tcp dport 6443 ct original ip daddr $api_service ct original proto-dst 443 return
    ip daddr { $app_ip, $judge_ip } tcp dport { 22, 2379, 2380, 6443, 10250 } drop
  }
  chain output {
    type filter hook output priority -10; policy accept;
    $imds_allow
    ip daddr 169.254.169.254 drop
  }
}
EOF
