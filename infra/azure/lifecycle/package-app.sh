#!/usr/bin/env bash
# Build a deterministic package for the trusted App host. No environment files.
set -euo pipefail
target=${1:?output tar file}
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
for name in activation activation_client activation_record app_rollout attempt_secret authority configuration drain_work edge_lease host_services kube_rollout local_rpc migration_job node_state permits redis_acl release_catalog runtime_secrets smoke; do
  install -m 0644 "$root/infra/azure/lifecycle/$name.py" "$stage"
done
install -m 0644 "$root/infra/postgres/managed/"{bootstrap-host.py,bootstrap.sql,catalog.sql,coordinator.py,drain-login.sql,fencer-login.sql,owner.sql,runtime-login.sql} "$stage"
install -m 0644 "$root/scripts/release/"{policy.py,transport.py} "$stage"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C "$stage" -cf "$target" .
