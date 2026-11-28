# M0-13 Azure Terraform

`bootstrap` defines S4 state, recovery and immutable canonical release records in separate storage accounts. `environment` defines the S2/S3 network, App and Judge VMs, retained App disk, runtime Key Vault, Azure-native daily shutdown, and scoped delivery and emergency roles. Each root defines a subscription budget with 50%, 80% and 100% actual-spend alerts.

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
python3 -B infra/azure/environment/tests/test_reviewed_apply.py
```

The retained-disk and compute test seeds state through the mock provider in a disposable directory. It checks that retargeting, disk replacement, expired startup inputs and toggling off existing VM resources fail. The operator fixture verifies saved-plan decisions and rejects stale approvals and proves initial creation and partial-replacement recovery against mocked instance views. Azure resource eligibility, operator reachability, role propagation, native deallocation and notification delivery require Phase B evidence.

## App and Judge bootstrap

The VM custom data renders separate cloud-init configurations from `cloud-init/`. The installer verifies the pinned Linux amd64 K3s binary before enabling the systemd service. Both roles wait for the host firewall. App runs the server, Traefik and ServiceLB and uses its verified retained disk for local volumes. Judge runs the tainted agent and requires an independently issued, CA-pinned agent token in a root-only file. The protected delivery and rotation procedure requires live Phase B verification. [K3s release and checksums](https://github.com/k3s-io/k3s/releases/tag/v1.35.10%2Bk3s1) · [K3s token roles and formats](https://docs.k3s.io/cli/token)

Set `compute.app_data_uuid` to the approved ext4 filesystem UUID for the App disk at Azure LUN 0. Initialize a fresh disk explicitly during authorized provisioning. The App disk check rejects an absent or mismatched device and the bootstrap performs no formatting. Reattach an existing approved disk as-is and confirm its identity before restarting the App K3s service, which requires the verified mount. Pod traffic to metadata and direct management ports is blocked at the host. The authenticated Kubernetes ClusterIP remains available for required system add-ons. App host IMDS is restricted to the activation issuer and secret loader service accounts. Live placement, boot, mount recovery, join and traffic checks belong to the S3 rehearsal. [Azure Linux disk device aliases](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/azure-virtual-machine-utilities)

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

- Start S4 bootstrap with an isolated local backend, then migrate to its dedicated Blob state. Keep state, backups and write-once canonical receipts separate. [S4 procedure](#task-22-first-time-s4-bootstrap)
- S2 and S3 have distinct approved subscriptions and state scopes. Prepare the network, retained disk, Key Vault, budget, daily shutdown schedules and emergency authority before enabling compute. The reviewed-plan runner binds the current planning and apply scopes. Routine shutdown deallocates the pair and keeps the declared resources.
- Each node has a static IPv4 for egress, with no unsolicited external Judge ingress. App permits HTTPS only from approved CIDRs. The scoped App identity reads the S4 receipt container over its approved network path. The Kubernetes API and SSH remain private.
- The workload RG permits only the expected App/Judge VM names under Azure Policy. An emergency principal can read and deallocate only that pair. The delivery role has VM read and Action Run Command on App only.

## Task 2.1 review boundary

Use the owning subscription contexts after the Orchestrator authorizes the next Phase B operation. This Bash fragment checks account and scope locally without printing identities. Use only trusted, protected local values for the variables below. Keep shell tracing disabled. Use the expected names from the [preflight record](../../docs/evidence/m0-13-phase-a.md#azure-preflight-observations).

```bash
set -euo pipefail
set +x
: "${TENANT_A:?}" "${TENANT_B:?}" "${S1_SUB:?}" "${S2_SUB:?}" "${S3_SUB:?}" "${S4_SUB:?}" "${S5_SUB:?}"
check_account() {
  az account show --subscription "$1" -o json |
    jq -e --arg sub "$1" --arg tenant "$2" \
      '.id == $sub and .tenantId == $tenant and .state == "Enabled"' >/dev/null
}
AZURE_CONFIG_DIR="$HOME/.acc5" check_account "$S1_SUB" "$TENANT_A"
AZURE_CONFIG_DIR="$HOME/.acc2" check_account "$S5_SUB" "$TENANT_B"
for pair in acc4:S2 acc3:S3 acc1:S4; do
  slot=${pair#*:}
  export AZURE_CONFIG_DIR="$HOME/.${pair%:*}"
  subvar="${slot}_SUB"
  sub=${!subvar}
  check_account "$sub" "$TENANT_A"
  az provider list --subscription "$sub" --query "[?registrationState=='Registered'].namespace" -o tsv
  if [[ "$slot" != S4 ]]; then
    az vm list-usage --subscription "$sub" --location koreacentral -o table
    az network list-usages --subscription "$sub" --location koreacentral -o table
    az vm list-skus --subscription "$sub" --location koreacentral --resource-type virtualMachines \
      --all --query "[?name=='Standard_B4s_v2' || name=='Standard_B2ls_v2'].{sku:name,restrictions:restrictions}" -o json
    az vm image list --subscription "$sub" --location koreacentral --all \
      --publisher Canonical --offer ubuntu-24_04-lts --sku server --query '[].urn' -o tsv
  fi
done
gh api repos/nvawntien/astracode/actions/oidc/customization/sub
gh api repos/nvawntien/astracode/environments --jq '.environments[] | {name, protection_rules}'
```

Record Azure Billing credit and expiry, provider registration including `Microsoft.DevTestLab`, location and quota, approved images (including Ubuntu VM Agent), scoped Azure RBAC, the native schedule and its notification path, protected GitHub Environment review and exact OIDC subject, and GHCR/S4 reachability. Verify the daily schedules can target the pair before creation. Check workflow registration and authorization for S3 separately from activating S2. The published role must deny power, Judge, role assignments and Terraform state. Prove native shutdown using actual instance views on S3. [Proposed ADR-0013](../../docs/architecture/adr/0013-staging-lifecycle-control-plane-and-identity.md) · [Azure VM auto-shutdown](https://learn.microsoft.com/en-us/azure/virtual-machines/auto-shutdown-vm)

## Provisioning privileges

Use separate protected identities and temporary grants. Centralized Reader access supports inspection. Use the owning operators or narrowly scoped, time-limited delegated grants for provisioning. The working Terraform requirements are below.

| Scope and duty | Minimum working authority to verify |
| --- | --- |
| S2/S3 subscription and approved RGs | Resource group read/create at subscription scope for initial RGs, or have the owner create the exact groups and import them with review. Use Contributor on the workload and operations RGs for Compute, Network, DevTestLab schedules, private DNS, Storage, Key Vault and user-assigned identity resources. Exclude storage `listKeys` and key regeneration in the provisioning identity and use separate limited identity-assignment authority for the exact UAMIs. Retain access to required network subnet joins. Use only approved Managed Run Command scripts with one-time scoped authority. |
| Azure Policy and RBAC | Use temporary Resource Policy Contributor or equivalent reviewed policy definition and RG assignment actions. Subscription custom role definitions need `Microsoft.Authorization/roleDefinitions/read,write` at the definition scope. Separate role assignment write/delete at exact RG/resource or S4 container scopes, constrained to reviewed roles and principal IDs where possible. If needed, the owning operator performs these narrow steps using the existing Owner authority and retires temporary grants. |
| S4 | Manage the dedicated shared RG and three storage accounts. Keep provider registration explicit. Require budget permissions at subscription scope. Cross-subscription service-endpoint rules may also require subnet join authorization on the source VNet. Scope state Blob Data Contributor to each independent slot container, backup contributor to `recovery`, receipt reader to `canonical-releases`. Verify whether the Terraform version uses ARM or Blob data operations for each storage resource. If bootstrap principal data-plane access is needed, grant it on the exact new account temporarily before rerunning the affected plan. |
| Budgets | Subscription-level `Microsoft.Consumption/budgets/read,write` and read access to the relevant Cost Management data. Verify offer support, recipient delivery and usage in a separately authorized task. |

Keep temporary infrastructure/bootstrap guest execution separate from routine delivery. For delivery, the custom role grants only `Microsoft.Compute/virtualMachines/read` and `Microsoft.Compute/virtualMachines/runCommand/action` on the exact App VM. Action Run Command is elevated guest execution, including scripts other than the installed delivery command if a principal holds that permission. Protect the exact GitHub workflow and its Environment and verify effective denials for wrong workflow/ref, start, deallocate, Judge, role assignment and S4 state. The VM agent needs outbound HTTPS to Azure. The S4 publisher and App receipt reader have separate Blob scopes. [Azure Action Run Command](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command) · [Azure Compute RBAC actions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/compute)

## Task 2.2 first-time S4 bootstrap

Prerequisites are task 2.1 clearance and separate S4 authorization, Terraform 1.13.5 and the checked provider lock, stable approved egress, reviewed S4 inputs, equal tenant/subscription assertions, and a protected encrypted location outside the repo. Confirm the [S4 owner or delegated permissions](#provisioning-privileges). Configure separate S4, S2 and S3 state principal IDs, backup and receipt principal IDs, and the restricted receipt networks. Preserve WORM retention selection, budget dates and 50/80/100% alert recipients in the reviewed inputs.

Run from the root after checking that the exact S4 target is initially empty or fully accounted for. Set `PRIVATE_DIR`, `S4_VARS` and `S4_STATE_ACCOUNT` in the authorized shell. `S4_VARS` is an absolute path. `check_account` is the function above. The first copy has an implicit local backend. Removing its local state or changing its work directory before migration can orphan the new resources.

```bash
umask 077
set +x
: "${PRIVATE_DIR:?}" "${S4_VARS:?}" "${S4_SUB:?}" "${TENANT_A:?}" "${S4_STATE_ACCOUNT:?}"
export AZURE_CONFIG_DIR="$HOME/.acc1"
check_account "$S4_SUB" "$TENANT_A"
test "$(az account show --query id -o tsv)" = "$S4_SUB"
source_dir="$PWD/infra/azure"
work=$(mktemp -d "$PRIVATE_DIR/m013-s4.XXXXXXXX")
mkdir "$work/bootstrap"
cp -R "$source_dir/modules" "$work/modules"
cp "$source_dir"/bootstrap/{main.tf,variables.tf,versions.tf,.terraform.lock.hcl} "$work/bootstrap/"
unset TF_DATA_DIR TF_WORKSPACE TF_CLI_ARGS TF_CLI_ARGS_init TF_CLI_ARGS_plan TF_CLI_ARGS_apply
terraform -chdir="$work/bootstrap" init -lockfile=readonly
terraform -chdir="$work/bootstrap" plan -input=false -var-file="$S4_VARS" -out="$work/bootstrap.plan"
terraform -chdir="$work/bootstrap" show -no-color "$work/bootstrap.plan" >"$work/bootstrap.review"
sha256sum "$work/bootstrap.plan"
```

After reviewing the exact saved plan and recording approval, verify its digest against the protected approved value and apply it from this same context.

```bash
check_account "$S4_SUB" "$TENANT_A"
printf '%s  %s\n' "${S4_APPROVED_PLAN_SHA256:?}" "$work/bootstrap.plan" | sha256sum -c -
terraform -chdir="$work/bootstrap" apply -input=false "$work/bootstrap.plan"
terraform -chdir="$work/bootstrap" output -json state_backend >"$work/backend.json"
jq -e --arg account "$S4_STATE_ACCOUNT" --arg tenant "$TENANT_A" \
  '.S4 == {storage_account_name:$account,tenant_id:$tenant,container_name:"s4-tfstate",key:"terraform.tfstate"}' \
  "$work/backend.json" >/dev/null
terraform -chdir="$work/bootstrap" state pull >"$work/local-before-migration.json"
az storage container show --account-name "$S4_STATE_ACCOUNT" --name s4-tfstate --auth-mode login -o none
cp "$source_dir/bootstrap/backend.tf" "$work/bootstrap/"
terraform -chdir="$work/bootstrap" init -migrate-state -lockfile=readonly \
  -backend-config="storage_account_name=$S4_STATE_ACCOUNT" \
  -backend-config="tenant_id=$TENANT_A" -backend-config="use_cli=true"
terraform -chdir="$work/bootstrap" state pull >"$work/remote-after-migration.json"
diff -u <(jq -cS '[.lineage,.resources]' "$work/local-before-migration.json") \
        <(jq -cS '[.lineage,.resources]' "$work/remote-after-migration.json")
```

Complete migration only after the exact Blob scope is reachable with Entra and the S4 state principal's data-plane grant has propagated. Confirm the destination Blob is empty before accepting the first migration prompt. If any bootstrap operation fails after creating resources, inspect the local state and actual S4 resources and resume under review. Keep the protected original state until migration and recovery are verified.

Verify lock contention with a finite lease in the S4 maintenance window and no concurrent writer. Confirm the Terraform output reports a lock error. Then verify a normally locked refresh-only plan can proceed. Retain sanitized status and no state body.

```bash
(
  set -e
  lease=$(az storage blob lease acquire --account-name "$S4_STATE_ACCOUNT" \
    --container-name s4-tfstate --blob-name terraform.tfstate --lease-duration 60 --auth-mode login -o tsv)
  trap 'az storage blob lease release --account-name "$S4_STATE_ACCOUNT" --container-name s4-tfstate --blob-name terraform.tfstate --lease-id "$lease" --auth-mode login -o none' EXIT
  if terraform -chdir="$work/bootstrap" plan -refresh-only -input=false -lock-timeout=5s \
      -var-file="$S4_VARS" >"$work/lock-check.log" 2>&1; then
    exit 1
  fi
  rg -q 'Error acquiring the state lock|LeaseAlreadyPresent' "$work/lock-check.log"
)
terraform -chdir="$work/bootstrap" plan -refresh-only -input=false -var-file="$S4_VARS"
```

Verify each assignment using the actual distinct state principals and stable network path. `az storage blob list --account-name "$S4_STATE_ACCOUNT" --container-name s2-tfstate --auth-mode login --query 'length(@)' -o tsv` should work as S2 and receive a data-plane authorization error as S3, then reverse the checks. Repeat against S4. Under the backup principal test `az storage blob list` on the backup account's `recovery` container and verify denial on state and receipts. Verify receipt reader write denial. With authorization for a retained synthetic probe name in the receipt container, use `az storage blob upload --auth-mode login --if-none-match '*' --overwrite false` with the receipt publisher and a protected test file. Require the repeat conditional create and an explicit overwrite/delete of only that probe to fail, verify its bytes separately, and record retention and principal scope. Arrange disposition of that locked probe before writing it. On completion retire the temporary bootstrap grants. Retain the original local snapshot in approved encrypted recovery storage, or dispose of it using the storage medium’s approved deletion procedure after validating recovery. Remove saved plans and incidental local copies under the same policy. [Entra Blob authentication and locking](https://developer.hashicorp.com/terraform/language/backend/azurerm)

## S2/S3 VM maintenance

Configure `operations.earliest_start` and `operations.shutdown` from the recorded owner approval in UTC, with at least 12 hours off and a shutdown delay margin. No Azure auto-start. Verify that exact native schedules are enabled for both nodes, record measured deallocation times and wait for the minimum off interval before the next start. After a fresh owner approval for a window change, use a reviewed schedule-only plan while compute is closed and align the protected App host window configuration before startup.

Plan VM creation, replacement or recovery from the same checked, initialized Terraform scope. For power-on plans set `compute.startup` to the exact pair, short UTC expiry and approval reference. The protected approval JSON binds `plan_sha256`, `target` from `plan_target`, `backend_account`, `operation`, `role` for single-VM actions, `expires_at`, `approval_ref`, `startup_approval_ref` and `window_ref`. Initial creation needs no prior off-time record. All existing VMs must be observed deallocated before a power-on plan.

For one replacement, use an isolated reviewed root with an override allowing replacement of `azurerm_linux_virtual_machine.node` and, for App only, `azurerm_virtual_machine_data_disk_attachment.app`. Leave `azurerm_managed_disk.app` protected. Save a plan with `-replace='azurerm_linux_virtual_machine.node["app"]'` plus `-replace='azurerm_virtual_machine_data_disk_attachment.app[0]'` for App, or use only the Judge VM address for Judge. Verify one delete-before-create, same size, names, NIC/IP and original disk at LUN 0. Remove the override after the apply and check the clean plan. After a failed replace, reconcile the actual Azure inventory and Terraform state, verify the surviving VM is deallocated and the native schedules remain enabled, and review a new `recover` plan with the exact absent role. Keep original NIC/IP and disk in state. Use no spare VM or IP. Verify App's actual LUN and UUID before workloads or testers return. If schedule, disk or state evidence is missing, stop for protected infrastructure recovery before resuming.

Use the deallocate-only emergency profile when an early or scheduled stop leaves either state uncertain. The script checks both Azure instance views and exits nonzero unless both are deallocated.

```bash
AZURE_CONFIG_DIR="$EMERGENCY_CLI" python3 infra/azure/lifecycle/emergency.py \
  --slot s3 --subscription "$S3_SUB"
```

## S3 provision and deploy

Run only following Task 2.1 clearance and separate authorization. Set the protected S3 CLI profile and verify its subscription and tenant. Keep the reviewed S3 variables, plans and approval files in a private operator directory. `S3_PREP_VARS` has compute disabled. `S3_COMPUTE_VARS` binds the approved compute window, pinned image, operator public key and App disk filesystem UUID. Configure the S3 environment and repository workflow in the separately authorized registration step before live automated delivery. S4 bootstrap must already be verified. [Release workflow registration](../../scripts/release/README.md#separately-reviewed-default-branch-transition)

```bash
set -euo pipefail
set +x
export AZURE_CONFIG_DIR="$S3_CLI" TF_DATA_DIR="$S3_PRIVATE/terraform-data"
test "$(az account show --query id -o tsv)" = "$S3_SUB"
test "$(az account show --query tenantId -o tsv)" = "$TENANT_A"
s3root="$PWD/infra/azure/environment"
terraform -chdir="$s3root" init -input=false -lockfile=readonly \
  -backend-config="storage_account_name=$S4_STATE_ACCOUNT" \
  -backend-config="container_name=s3-tfstate" -backend-config="key=terraform.tfstate" \
  -backend-config="tenant_id=$TENANT_A" -backend-config="use_cli=true"
terraform -chdir="$s3root" plan -input=false -var-file="$S3_PREP_VARS" -out="$S3_PRIVATE/prep.tfplan"
terraform -chdir="$s3root" show -no-color "$S3_PRIVATE/prep.tfplan" > "$S3_PRIVATE/prep.review"
sha256sum "$S3_PRIVATE/prep.tfplan"
# After recording approval of the exact maintenance plan:
python3 "$s3root/reviewed-apply.py" --check "$S3_PRIVATE/prep.tfplan" "$S3_PREP_APPROVAL"
python3 "$s3root/reviewed-apply.py" "$S3_PRIVATE/prep.tfplan" "$S3_PREP_APPROVAL"

terraform -chdir="$s3root" plan -input=false -var-file="$S3_COMPUTE_VARS" -out="$S3_PRIVATE/compute.tfplan"
terraform -chdir="$s3root" show -no-color "$S3_PRIVATE/compute.tfplan" > "$S3_PRIVATE/compute.review"
sha256sum "$S3_PRIVATE/compute.tfplan"
# After fresh owner approval of the exact compute plan within its active window:
python3 "$s3root/reviewed-apply.py" --check "$S3_PRIVATE/compute.tfplan" "$S3_COMPUTE_APPROVAL"
python3 "$s3root/reviewed-apply.py" "$S3_PRIVATE/compute.tfplan" "$S3_COMPUTE_APPROVAL"
terraform -chdir="$s3root" output -json vm_ids > "$S3_PRIVATE/vm-ids.json"
APP_ID=$(jq -er .app "$S3_PRIVATE/vm-ids.json")
JUDGE_ID=$(jq -er .judge "$S3_PRIVATE/vm-ids.json")
az vm get-instance-view --ids "$APP_ID" --query "instanceView.statuses[?starts_with(code,'PowerState/')].code" -o tsv
az vm get-instance-view --ids "$JUDGE_ID" --query "instanceView.statuses[?starts_with(code,'PowerState/')].code" -o tsv
```

The initial App mount fails closed until the authorized operator initializes the new blank LUN 0 as ext4 with the previously approved UUID. Verify the target disk and blank state before formatting. Never format a retained disk. Complete protected host bootstrap, per-role credentials, backing services and installation of the exact reviewed rehearsal receipts under the [activation procedure](lifecycle/README.md#host-configuration-and-authority). Run the App mount check and `/usr/local/bin/k3s kubectl get nodes` through the approved private guest path. Keep workload admission closed until that verification and the separate deployment approval. On subsequent windows, verify both states and off-time before `az vm start --ids "$APP_ID" "$JUDGE_ID"`.

After actual readiness, set `WINDOW_APPROVAL` to the recorded current owner approval reference. Send only this non-secret reference and UTC date through Azure Action Run Command. Initialize the journal only on the first new S3 setup. The routine workflow must remain disabled until the scoped role, federation and other live gates pass.

```bash
# Initial setup only, on the verified new App data disk:
az vm run-command invoke --ids "$APP_ID" --command-id RunShellScript \
  --scripts '/usr/bin/python3 -B /usr/local/libexec/astra/app/host_services.py delivery initialize' -o json
window_payload=$(jq -cn --arg approval "$WINDOW_APPROVAL" --arg date "$(date -u +%F)" \
  '{approval:$approval,date:$date}' | base64 -w0)
az vm run-command invoke --ids "$APP_ID" --command-id RunShellScript \
  --scripts "/usr/bin/python3 -B /usr/local/libexec/astra/app/host_services.py delivery open $window_payload" -o json
jq -ce '{slot:"s3",action:"deploy",source,digest:.bundle,fallback_source:.source,fallback:.bundle}' \
  "$S3_REHEARSAL_RECEIPT" > "$S3_PRIVATE/deployment.json"
gh workflow run staging-deploy.yml --repo nvawntien/astracode --ref main \
  -f "request=$(cat "$S3_PRIVATE/deployment.json")"
```

The maintainer reviews the frozen request in `s3-delivery`. Record the precise run ID, then use `gh run watch "$S3_DEPLOY_RUN" --repo nvawntien/astracode --exit-status` and confirm the staged release and smoke artifact. Stop at a missing mount, native schedule, protected transport or observed release mismatch and keep tester access closed. Verify standby and emergency shutdown using the scoped profile.

## Environment retirement

Close tester access before an early stop with the protected App guest command `host_services.py delivery close`. Observe the drain and deallocate both VMs. Retain the required data, state and receipts. Budget credits and expenses can continue while VMs are off. Review any disk, network, schedule or other resource removal separately after measuring final inventory and cost.
