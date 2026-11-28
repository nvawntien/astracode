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
python3 -B infra/azure/environment/tests/test_reviewed_apply.py
```

The retained-disk and compute test seeds state through the mock provider in a disposable directory. It checks that retargeting, disk replacement, expired startup inputs and toggling off existing VM resources fail. The operator fixture verifies saved-plan decisions and rejects stale or cancelled power windows. Azure resource eligibility, operator reachability, role propagation, timer execution and alert delivery require Phase B evidence.

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

- Initial S4 bootstrap starts in a protected isolated root with the default local backend. Add the checked-in `backend.tf` after creating and verifying the storage and grants, then migrate to the matching Blob backend. Use the dedicated state scopes, avoid storage `listKeys` and preserve the recovery snapshot until remote locking and isolation are verified. [S4 bootstrap procedure](#task-22-first-time-s4-bootstrap)
- S2 and S3 use independently approved subscriptions and separate state. The provider checks tenant and subscription and the first state write binds the target. Start with compute and controller exposure disabled. Verify the controller and monitors before the separate reviewed compute apply. The runner validates target and backend, plan digest, live controller deadline and approval. Use Azure deallocation for ordinary shutdown. Keep VM resources, their network identities and the independent data disk in state. Do not change `compute.enabled` to power off. [VM maintenance procedure](#s2s3-vm-maintenance)
- The power roles use a dedicated workload resource group reserved by an enforced Azure Policy for the two planned VM names. This lets the controller and emergency operator have deallocation capability before either VM exists. S3 and emergency access are deallocate-only. The controller uses its own private storage account, separate from S4 state and release data.
- Static IPv4 addresses provide explicit VM egress. Judge accepts only the App peer's cluster traffic. App HTTPS uses explicit tester CIDRs. A dedicated NAT gateway supplies the Flex Consumption subnet's public egress for Azure APIs and telemetry while controller storage uses Private Link. Verify the gateway's eligibility, deployment and standing cost in Phase B. [Flex Consumption networking](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options)
- The App data disk is a separately managed resource protected against destruction and replacement while declared. Routine staging shutdown uses VM deallocation. S3 deletion of the retained disk requires the separately approved cleanup and inventory procedure.

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

Record the Azure Billing credit and expiry independently for every slot. Confirm the minimum IAM grants, Azure Policy, exact image, FC1 subscription quota/region eligibility, package and network path, receipt ingress and GitHub Environment/federation prerequisites before provisioning. The controller procedure depends on acceptance of Proposed ADR-0013 and confirmed directory authority. Task 2.1 captures preflight feasibility. Tasks 2.2–2.4 and 3.1–3.4 supply the actual cloud acceptance. [Proposed ADR-0013](../../docs/architecture/adr/0013-staging-lifecycle-control-plane-and-identity.md)

## Provisioning privileges

Use separate protected identities and temporary grants. Centralized Reader access supports inspection. Use the owning operators or narrowly scoped, time-limited delegated grants for provisioning. The working Terraform requirements are below.

| Scope and duty | Minimum working authority to verify |
| --- | --- |
| S2/S3 subscription and approved RGs | Resource group read/create at subscription scope for initial RGs, or have the owner create the exact groups and import them with review. Use Contributor on the workload and operations RGs for Compute, Network, Web/FC1, Insights, OperationalInsights, private DNS, Storage, Key Vault and user-assigned identity resources. Exclude storage `listKeys` and key regeneration in the provisioning identity and use separate limited identity-assignment authority for the exact UAMIs. Retain access to required network subnet joins. Use only approved Managed Run Command scripts with one-time scoped authority. |
| Azure Policy and RBAC | Use temporary Resource Policy Contributor or equivalent reviewed policy definition and RG assignment actions. Subscription custom role definitions need `Microsoft.Authorization/roleDefinitions/read,write` at the definition scope. Separate role assignment write/delete at exact RG/resource or S4 container scopes, constrained to reviewed roles and principal IDs where possible. If needed, the owning operator performs these narrow steps using the existing Owner authority and retires temporary grants. |
| S4 | Manage the dedicated shared RG and three storage accounts. Keep provider registration explicit. Require budget permissions at subscription scope. Cross-subscription service-endpoint rules may also require subnet join authorization on the source VNet. Scope state Blob Data Contributor to each independent slot container, backup contributor to `recovery`, receipt reader to `canonical-releases`. Verify whether the Terraform version uses ARM or Blob data operations for each storage resource. If bootstrap principal data-plane access is needed, grant it on the exact new account temporarily before rerunning the affected plan. |
| Budgets | Subscription-level `Microsoft.Consumption/budgets/read,write` and read access to the relevant Cost Management data. Verify offer support, recipient delivery and usage in a separately authorized task. |

Use a separate time-limited Function resource grant for package administration. The per-slot Function UAMI needs Blob Data Owner only on its own controller account for the host containers and leases. The S2 controller separately reads S4 receipts. CI application delivery uses controller HTTPS without ARM or Terraform write permissions. If the receipt publisher needs subscription discovery with `azure/login`, verify the data-only login path first and review the minimum discovery permissions separately. Use an approved stable egress path for its S4 receipt connection.

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

Keep `compute.enabled = true` for provisioned VMs in the managed configuration. Ordinary shutdown uses controller cancellation or expiry, or the separate pair-scoped emergency deallocate-only command. Confirm both instance views show `PowerState/deallocated`. Keep the App data disk, NICs and public IPs in state and leave the controller able to enforce its deadline.

Create the network, disk, controller, package and alerts in reviewed plans before VM creation. For compute apply use `infra/azure/environment/reviewed-apply.py` in the protected operator context. Plan and apply in the same initialized state scope. Set Entra CLI auth, stable approved credentials and the default workspace. Keep all backend metadata, variables, plan and approval files in the protected location. Restrict Azure write access to the operation window and authorize saved plans through the operator review procedure.

- A maintenance plan omits `compute.startup` and may reconcile deallocated VMs as existing resources. Any VM update that could power on or change identity requires review. The current runner allows changes outside the VM resource and rejects direct VM updates, so use an approved replacement for a supported VM change. The VM and attachment `prevent_destroy` guards reject turning the topology flag off after creation.
- For creation or replacement set `compute.startup` with the exact controller ID, pair, approval reference and near-term UTC deadline. Review the saved plan. For S3 obtain the protected immutable experiment reference and deadline. For S2 use a protected native-reviewed `start` request with `terraformPlan` containing exact saved plan `sha256`, `operation` (`create` or `replace`), `role` (null for create), and `expiresAt` equal to the startup deadline. The request ID is the startup approval reference. The window allows Terraform's external VM power effect, keeps workload leases closed and emits only cleanup power actions. Start and deploy after normal deallocation with separate approvals.
- For one approved replacement, from an isolated reviewed copy of `infra/azure` add an override file containing `resource "azurerm_linux_virtual_machine" "node" { lifecycle { prevent_destroy = false } }` as a multi-line block. For App only, similarly override `azurerm_virtual_machine_data_disk_attachment.app`, leaving the separate managed disk guard in place. Use `terraform plan -replace='azurerm_linux_virtual_machine.node["app"]' -replace='azurerm_virtual_machine_data_disk_attachment.app[0]' -out=...` for App, or the single Judge address for Judge. Require deallocation of both nodes, sealed work, current off-window and cleanup evidence, protected disk recovery point and cloud operator review. Verify one delete-before-create, the same name, size, NIC, IP, and the same App disk at LUN 0. Reattach as-is and verify the UUID and acceptance before admitting workloads. Remove the override and confirm a new plan without the override is clean. If replacement fails, keep cleanup active and reconcile the real state before requesting approval for the recovery plan. Do not add temporary VMs or IPv4s under the current quotas.
- The protected approval JSON has `plan_sha256`, `target` copied from the plan's `plan_target`, `backend_account`, `operation` (including `maintenance`), `role` for replacement, `expires_at` and `approval_ref`. A power-on plan also has `startup_approval_ref` and `controller_grant`. Copy the S2 result from the approved run. For S3 supply the protected controller experiment's `approvalRef` and `deadline`. Confirm the evidence independently, the controllers and alerts are healthy, and both instance views match the expected scope before signing off the plan. Run `python3 infra/azure/environment/reviewed-apply.py --root "$REVIEWED_ROOT" --check "$SAVED_PLAN" "$APPROVAL_JSON"`, then the same command without `--check` only after authorization. The runner checks the plan again and uses the same privately copied bytes. Keep the sunset for temporary Azure write access.

For actual create or replacement, stream a fresh controller-scoped token from the approved API client into the runner's standard input. The runner uses a separate Azure CLI profile for the infrastructure scope. A cancelled S2 window, stale heartbeat, changed plan, expired approval or inactive S3 experiment blocks the apply. An S3 replacement also needs the bounded external recovery window. The example below requires an approved CLI context capable of obtaining an access token for the controller API. Use the approved delegated client instead if tenant policy grants the scope only to that client.

```bash
set -euo pipefail
set +x
: "${CONTROLLER_CLIENT_CONTEXT:?}" "${PROVISIONER_CONTEXT:?}" "${CONTROLLER_AUDIENCE:?}"
AZURE_CONFIG_DIR="$CONTROLLER_CLIENT_CONTEXT" az account get-access-token \
  --resource "$CONTROLLER_AUDIENCE" --query accessToken -o tsv |
  AZURE_CONFIG_DIR="$PROVISIONER_CONTEXT" python3 infra/azure/environment/reviewed-apply.py \
    --root "$REVIEWED_ROOT" "$SAVED_PLAN" "$APPROVAL_JSON"
```

## Environment retirement

For S2 during the 14–21 day submission horizon, schedule only needed 2–4 hour planning windows with separate approved sessions and keep at least the existing daily 12-hour off window. Track actual credit and cost, investigate standing charges during off-hours and verify notifications. Agree the end date before provisioning. After submission or the final demo, close tester access, deallocate both nodes, take approved data recovery snapshots or backups, verify recovery metadata and retain required state and receipts in S4. Review an exact S2 retirement plan for network, disks, controller, monitoring and credentials with the owner. Confirm last bills and retained inventory. S1 and S5 remain inactive for M0-13.

For the S3 workload benchmark, rollback and recovery drills, use the [managed activation runbook](lifecycle/README.md#s3-pre-merge-rehearsal-and-cleanup).
