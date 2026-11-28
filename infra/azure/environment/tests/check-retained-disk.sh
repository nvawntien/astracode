#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

mkdir -p "$scratch/environment/tests"
cp -- "$root"/*.tf "$root/.terraform.lock.hcl" "$root/offline.tfvars.example" "$scratch/environment/"
ln -s -- "$root/../modules" "$scratch/modules"
ln -s -- "$root/../cloud-init" "$scratch/cloud-init"
ln -s -- "$root/../lifecycle" "$scratch/lifecycle"
cp -- "$root/tests/retained-disk.tftest.hcl.example" "$scratch/environment/tests/retained-disk.tftest.hcl"

# Keep the expected-failing test and its mock state out of the regular suite.
export TF_DATA_DIR="$scratch/terraform-data"
terraform -chdir="$scratch/environment" init -backend=false -lockfile=readonly -no-color

if terraform -chdir="$scratch/environment" test -no-color -var-file=offline.tfvars.example >"$scratch/result" 2>&1; then
  cat "$scratch/result"
  echo "Expected Terraform to reject App disk replacement." >&2
  exit 1
fi

if ! grep -Fq 'run "seed_disk"... pass' "$scratch/result" ||
   ! grep -Fq 'run "reject_bound_state_retarget"... pass' "$scratch/result" ||
   ! grep -Fq 'run "blocked_replacement"... fail' "$scratch/result" ||
   ! grep -Fq 'Instance cannot be destroyed' "$scratch/result" ||
   ! grep -Fq 'azurerm_managed_disk.app has lifecycle.prevent_destroy' "$scratch/result"; then
  cat "$scratch/result"
  echo "The mocked plan did not fail on the App disk retention guard." >&2
  exit 1
fi

echo "Terraform rejected state retargeting and replacement of the retained App data disk."

cp -- "$root/tests/compute-lifecycle.tftest.hcl.example" "$scratch/environment/tests/compute-lifecycle.tftest.hcl"
if terraform -chdir="$scratch/environment" test -no-color -var-file=offline.tfvars.example \
  -filter=tests/compute-lifecycle.tftest.hcl >"$scratch/compute-result" 2>&1; then
  cat "$scratch/compute-result"
  echo "Expected Terraform to reject removing managed VM resources."
  exit 1
fi

if ! grep -Fq 'run "seed_existing_compute"... pass' "$scratch/compute-result" ||
   ! grep -Fq 'run "reconcile_existing_pair_without_startup_approval"... pass' "$scratch/compute-result" ||
   ! grep -Fq 'run "reject_expired_saved_startup_inputs"... pass' "$scratch/compute-result" ||
   ! grep -Fq 'run "forbid_compute_flag_shutdown"... fail' "$scratch/compute-result" ||
   ! grep -Fq 'has lifecycle.prevent_destroy' "$scratch/compute-result" ||
   ! grep -Fq 'azurerm_linux_virtual_machine.node["app"]' "$scratch/compute-result" ||
   ! grep -Fq 'azurerm_virtual_machine_data_disk_attachment.app[0]' "$scratch/compute-result"; then
  cat "$scratch/compute-result"
  echo "The mocked VM lifecycle did not exhibit the expected maintenance and protection behavior."
  exit 1
fi

echo "Terraform reconciled existing VMs without startup inputs and rejected expired approval and VM removal."
