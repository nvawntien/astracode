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

Use the approved mapping below. Carry forward the recorded permissions, Korea Central SKU restrictions and quotas. Repeat a completed lookup only if its scope or evidence changes. Keep subscription IDs, principal IDs and network addresses in the protected operator session. Record only sanitized results by slot. [Existing observations](../../docs/evidence/m0-13-phase-a.md#azure-preflight-observations) · [Accepted ADR-0013](../../docs/architecture/adr/0013-staging-lifecycle-control-plane-and-identity.md)

| Slot | CLI profile | Tenant | Preflight use |
| --- | --- | --- | --- |
| S1 | `.acc5` | A | Credit and expiry record |
| S2 | `.acc4` | A | Shutdown and delivery readiness |
| S3 | `.acc3` | A | Shutdown and delivery readiness |
| S4 | `.acc1` | A | State, receipts and budget readiness |
| S5 | `.acc2` | B | Credit and expiry record |

In Bash, load the already approved `S2_SUB`, `S3_SUB` and `S4_SUB` values. Keep shell tracing disabled. The account check also remains the scope check for the separately authorized S4 procedure.

```bash
set +x
: "${S2_SUB:?}" "${S3_SUB:?}" "${S4_SUB:?}"
m013_az() {
  local profile=$1 sub=$2
  shift 2
  AZURE_CONFIG_DIR="$HOME/.$profile" az "$@" --subscription "$sub" --only-show-errors
}
check_account() {
  az account show --subscription "$1" -o json |
    jq -e --arg sub "$1" --arg tenant "$2" \
      '.id == $sub and .tenantId == $tenant and .state == "Enabled"' >/dev/null
}
```

On S2/S3, confirm `Microsoft.DevTestLab` reports `Registered`, inspect its `schedules` catalog, and check the Compute operation catalog for the exact Action Run Command action. Catalog metadata proves the API is advertised. The separately authorized S3 preparation must show that the offer and policy permit both schedule resources before VM creation. Tasks 2.3–2.4 verify actual authorization, notifications, deallocation and recovery with VMs. A location or registration issue stays open until resolved by the authorized operator.

```bash
for slot in S2 S3; do
  case "$slot" in S2) profile=acc4; sub=$S2_SUB;; S3) profile=acc3; sub=$S3_SUB;; esac
  printf '%s\n' "$slot"
  m013_az "$profile" "$sub" provider show --namespace Microsoft.DevTestLab \
    --query "{registration:registrationState,schedules:resourceTypes[?resourceType=='schedules'].{locations:locations,apiVersions:apiVersions}}" -o json
  m013_az "$profile" "$sub" provider operation show --namespace Microsoft.DevTestLab -o json |
    jq -r '.. | objects | .name? // empty | select(ascii_downcase | startswith("microsoft.devtestlab/schedules/"))'
  m013_az "$profile" "$sub" provider operation show --namespace Microsoft.Compute -o json |
    jq -r '.. | objects | .name? // empty | select(ascii_downcase == "microsoft.compute/virtualmachines/runcommand/action")'
done
```

Inspect any existing delivery custom role, UAMI and federation. A missing identity or role is expected for an empty environment and leaves live federation and effective-scope checks for S3. For an existing principal inspect all its Azure assignments in the target subscription, including parent scopes on App. The role must contain only `Microsoft.Compute/virtualMachines/read` and `Microsoft.Compute/virtualMachines/runCommand/action`. The assignment belongs on `astra-s2-app` or `astra-s3-app` exactly. Also review inherited and group access, and cross-subscription access to S4 where applicable. These are metadata checks. S3 must prove the actual approved action succeeds and Judge, VM power, IAM and state access are denied.

```bash
for slot in S2 S3; do
  case "$slot" in S2) profile=acc4; sub=$S2_SUB;; S3) profile=acc3; sub=$S3_SUB;; esac
  stem="astra-${slot,,}"
  app_scope="/subscriptions/$sub/resourceGroups/$stem/providers/Microsoft.Compute/virtualMachines/$stem-app"
  m013_az "$profile" "$sub" role definition list --name "AstraCode $slot App guest delivery" \
    --query '[].{name:roleName,permissions:permissions}' -o json
  if principal=$(m013_az "$profile" "$sub" identity show -g "$stem-ops" -n "$stem-delivery" --query principalId -o tsv); then
    m013_az "$profile" "$sub" identity federated-credential list -g "$stem-ops" --identity-name "$stem-delivery" \
      --query '[].{name:name,issuer:issuer,audiences:audiences,subject:subject}' -o json
    m013_az "$profile" "$sub" role assignment list --assignee-object-id "$principal" --fill-principal-name false --all \
      --query '[].{scope:scope,role:roleDefinitionName}' -o json
    m013_az "$profile" "$sub" role assignment list --assignee-object-id "$principal" --fill-principal-name false \
      --scope "$app_scope" --include-inherited --query '[].{scope:scope,role:roleDefinitionName}' -o json
    m013_az acc1 "$S4_SUB" role assignment list --assignee-object-id "$principal" --fill-principal-name false --all \
      --query '[].{scope:scope,role:roleDefinitionName}' -o json
  fi
done
```

Inspect GitHub Environment settings for designated reviewers, protected `main`, self-review prevention and disabled administrator bypass. Check the workflow registration and repository OIDC template. Compare the expected subject from `identity.tf`, including repository ID, environment, ref and workflow ref. The issuer is `https://token.actions.githubusercontent.com` and Azure audience is `api://AzureADTokenExchange`. Check GHCR package visibility and the approved pull and publisher identities and receipt network path. Repository-level OIDC changes, workflow registration and activation require separate authorization. The S3 run verifies the actual token and wrong-context denials. [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc) · [Release workflow registration](../../scripts/release/README.md#separately-reviewed-default-branch-transition)

```bash
repo=nvawntien/astracode
gh api --method GET "repos/$repo" --jq '{id,visibility,default_branch}'
gh api --method GET "repos/$repo/environments" --jq '.environments[].name'
for env_name in s2-delivery s3-delivery canonical-publication; do
  gh api --method GET "repos/$repo/environments/$env_name" \
    --jq '{name,protection_rules:[.protection_rules[] | {type,prevent_self_review,reviewer_count:(.reviewers // [] | length)}],deployment_branch_policy,can_admins_bypass}'
  gh api --method GET "repos/$repo/environments/$env_name/deployment-branch-policies" \
    --jq '.branch_policies[] | {name,type}'
done
gh api --method GET "repos/$repo/actions/oidc/customization/sub" --jq '{use_default,include_claim_keys}'
gh api --method GET "repos/$repo/actions/workflows/staging-deploy.yml" --jq '{path,state}'
```

For S4, inspect only `astra-s4-shared`, check each proposed account name, and verify the approved network paths and separation of the state, recovery and receipt principals. Use `S4_PREFIX` from the approved S4 inputs. An unavailable name requires identifying the owner before proceeding. If an account already exists in the target, inspect its firewall and use the authenticated data-plane probe from the matching approved principal and network. A successful ARM read proves management visibility only. An empty target needs the scoped data-plane verification in Task 2.2. The App receipt reader requires the approved S2 subnet or other existing approved path, and the publisher needs its own verified restricted egress. [Storage firewall and service endpoints](https://learn.microsoft.com/en-us/troubleshoot/azure/azure-storage/blobs/networking/best-practices-for-storage-network-security)

```bash
: "${S4_PREFIX:?}"
m013_az acc1 "$S4_SUB" group exists --name astra-s4-shared -o tsv
for suffix in state backup receipts; do
  m013_az acc1 "$S4_SUB" storage account check-name --name "${S4_PREFIX}${suffix}" \
    --query '{available:nameAvailable,reason:reason}' -o json
done
# For existing in-scope accounts, inventory firewall and authentication metadata.
m013_az acc1 "$S4_SUB" storage account list -g astra-s4-shared -o json |
  jq --arg prefix "$S4_PREFIX" '[.[] | select(.name | startswith($prefix)) |
    {name,publicNetwork: .publicNetworkAccess,allowSharedKey: .allowSharedKeyAccess,
     defaultAction: .networkRuleSet.defaultAction,
     subnetCount: (.networkRuleSet.virtualNetworkRules // [] | length),
     ipRuleCount: (.networkRuleSet.ipRules // [] | length)}]'
# Use these probes only if their accounts and containers already exist.
m013_az acc1 "$S4_SUB" storage container show --account-name "${S4_PREFIX}state" --name s4-tfstate --auth-mode login -o none
m013_az acc4 "$S2_SUB" storage container show --account-name "${S4_PREFIX}state" --name s2-tfstate --auth-mode login -o none
m013_az acc3 "$S3_SUB" storage container show --account-name "${S4_PREFIX}state" --name s3-tfstate --auth-mode login -o none
# Run with the approved receipt-reader profile and its approved receipt network.
m013_az acc1 "$S4_SUB" storage container show --account-name "${S4_PREFIX}receipts" --name canonical-releases --auth-mode login -o none
```

The last command is an acc1 probe only if acc1 is the recorded receipt reader. Otherwise use the approved existing profile for that principal with the same S4 account and container. Receipt publisher first-write and isolation checks require the real scopes under Task 2.2. If the publisher UAMI will be hosted in S4, check that provider in S4 with `m013_az acc1 "$S4_SUB" provider show --namespace Microsoft.ManagedIdentity --query registrationState -o tsv`.

Read existing budgets in the three working subscriptions. Confirm the planned amount, validity and 50/80/100 actual-spend alerts. Actual alert delivery is a later live check. Each subscription owner checks the Azure for Students credit and expiration in the Sponsorships portal. Report amount, currency, expiry and check date per slot. Subscription status and budget spend are separate from remaining credit. [Azure budgets API](https://learn.microsoft.com/en-us/rest/api/consumption/budgets/list) · [Student credit balance and expiration](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/azurestudents-subscription-disabled)

```bash
for slot in S2 S3 S4; do
  case "$slot" in S2) profile=acc4; sub=$S2_SUB;; S3) profile=acc3; sub=$S3_SUB;; S4) profile=acc1; sub=$S4_SUB;; esac
  printf '%s\n' "$slot"
  m013_az "$profile" "$sub" rest --method get \
    --url "https://management.azure.com/subscriptions/$sub/providers/Microsoft.Consumption/budgets?api-version=2024-08-01" \
    -o json | jq '[.value[] | {name,amount: .properties.amount,timePeriod: .properties.timePeriod,
      spend: .properties.currentSpend,alerts: [(.properties.notifications // {})[] |
        {enabled,threshold,thresholdType}]}]'
done
```

Before requesting Task 2.2 authorization, account for existing S4 resources or confirm the target is empty. Prepare `S4_VARS` with the recorded S4 tenant, subscription and location, available prefix, distinct principals, approved source networks, receipt retention, budget date and recipients. Confirm stable operator egress, relevant role definition and assignment authority, the budget against real credits, Terraform 1.13.5, the pinned AzureRM provider and a protected directory for local state and plans. After authorization, use the [S4 bootstrap procedure](#task-22-first-time-s4-bootstrap).

Before S3 allocation, complete S4 state migration and access checks, obtain separate S3 authorization, register the protected workflow and review the S3 candidate SHA and two isolated rehearsal receipts. Prepare the exact approved window in UTC, shutdown margin and emergency/notification paths, pinned Ubuntu image with VM Agent, App LUN 0 filesystem UUID, private ingress and Key Vault/registry access. Review the preparation and compute plans separately and verify the two native schedules before enabling compute. Keep S3 deployment and power-state proof in Tasks 2.3–2.4. [S3 procedure](#s3-provision-and-deploy)

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
