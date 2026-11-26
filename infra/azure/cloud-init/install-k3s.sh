#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "$(uname -m)" != x86_64 ]]; then
  echo "This K3s release is pinned for Linux amd64." >&2
  exit 1
fi

read -r version checksum </etc/astracode/k3s-release
if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ || ! "$checksum" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid K3s release pin." >&2
  exit 1
fi

if ! command -v nft >/dev/null || ! command -v curl >/dev/null; then
  # The node NSGs allow HTTPS egress. Use the same Ubuntu mirrors over HTTPS.
  for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [[ -f "$source" ]]; then
      sed -i 's|http://|https://|g' "$source"
    fi
  done
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl nftables
fi

if ! printf '%s  %s\n' "$checksum" /usr/local/bin/k3s | sha256sum --check --status 2>/dev/null; then
  stage="$(mktemp -d /usr/local/bin/.astra-k3s.XXXXXX)"
  trap 'rm -rf -- "$stage"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --retry 3 \
    --output "$stage/k3s" "https://github.com/k3s-io/k3s/releases/download/$version/k3s"
  printf '%s  %s\n' "$checksum" "$stage/k3s" | sha256sum --check --status
  chmod 0755 "$stage/k3s"
  mv -T -- "$stage/k3s" /usr/local/bin/k3s
fi

systemctl daemon-reload
if [[ "$(cat /etc/astracode/node-role)" == app ]] && ! command -v psql >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client
fi
systemctl enable astra-k3s.service
# K3s is ordered after cloud-final; the first cloud-init run must not wait for it.
systemctl start --no-block astra-k3s.service
