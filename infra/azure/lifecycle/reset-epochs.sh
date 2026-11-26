#!/usr/bin/env bash
# Run on the host before each K3s startup. Revoke files in place so retained
# container bind mounts observe the revocation even when a shim survives restart.
set -euo pipefail
umask 022
read -r role </etc/astracode/node-role
case "$role" in
  app) workloads=(website envoy auth-service problem-service submission-service migrate) ;;
  judge) workloads=(judge-worker go-judge) ;;
  *) exit 1 ;;
esac
root=/run/astracode
install -d -o root -g root -m 0755 "$root" "$root/permits"
for workload in "${workloads[@]}"; do
  scope="$root/permits/$workload"
  install -d -o root -g root -m 0755 "$scope"
  rm -f -- "$scope/binding.json" "$scope/permit.json"
done
epoch=$(mktemp "$root/epoch.XXXXXX")
cat /proc/sys/kernel/random/uuid > "$epoch"
chmod 0644 "$epoch"
mv -T -- "$epoch" "$root/epoch"
