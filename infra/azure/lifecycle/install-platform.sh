#!/usr/bin/env bash
# Run during protected node provisioning, before opening any admission parameter.
set -euo pipefail
source_dir=${1:?reviewed platform artifact directory}
expected=${2:?approved Linux amd64 launch-guard SHA256}
[[ "$expected" =~ ^[0-9a-f]{64}$ ]]
[[ "$(uname -m)" == x86_64 ]]
printf '%s  %s\n' "$expected" "$source_dir/launch-guard" | sha256sum --check --status
install -d -m 0755 /usr/local/libexec/astra
stage=$(mktemp /usr/local/libexec/astra/.guard.XXXXXX)
trap 'rm -f -- "$stage"' EXIT
install -o root -g root -m 0755 "$source_dir/launch-guard" "$stage"
mv -T -- "$stage" /usr/local/libexec/astra/launch-guard

# A reviewed App package and checksum are delivered during infrastructure
# bootstrap. Judge receives only the launch guard and its observer service.
if [[ "$(cat /etc/astracode/node-role)" == app ]]; then
  app_hash=${3:?approved App host package SHA256}
  probe_hash=${4:?approved rollout probe SHA256}
  [[ "$app_hash" =~ ^[0-9a-f]{64}$ ]]
  [[ "$probe_hash" =~ ^[0-9a-f]{64}$ ]]
  printf '%s  %s\n' "$app_hash" "$source_dir/app.tar" | sha256sum --check --status
  printf '%s  %s\n' "$probe_hash" "$source_dir/judge-rollout-probe" | sha256sum --check --status
  install -o root -g root -m 0755 "$source_dir/judge-rollout-probe" /usr/local/libexec/astra/judge-rollout-probe
  destination=/usr/local/libexec/astra
  if [[ ! -d "$destination/app-$app_hash" ]]; then
    bundle="$(mktemp -d "$destination/.app.XXXXXX")"
    tar --no-same-owner -xf "$source_dir/app.tar" -C "$bundle"
    chmod -R u=rwX,go=rX "$bundle"
    mv -T "$bundle" "$destination/app-$app_hash"
  fi
  ln -sfn "app-$app_hash" "$destination/app.next"
  mv -Tf "$destination/app.next" "$destination/app"
fi
