# M0-13 Phase A evidence

This record covers checks using local fixtures, provider mocks and synthetic identities. The [Gate 1 review](../../openspec/changes/azure-walking-skeleton/review-gate1.md), [Round 2 acceptance](../../openspec/changes/azure-walking-skeleton/review-gate1-round2.md) and [executor decision](../../openspec/changes/azure-walking-skeleton/decision-judge-executor.md) keep their separate roles. Gate 2 review and required hosted checks remain mandatory. All real S3 and S2 scenarios are pending.

| Scenario | Phase A observation or fixture | Required live evidence |
| --- | --- | --- |
| ED-01 Recreate the stack in a separate subscription | Terraform 1.13.5 roots passed format, backend-disabled init, validate and provider-mocked tests (3 bootstrap, 8 environment). Both cloud-init renders passed schema, systemd and nft validation. | 2.1–2.4: target eligibility, isolated state, timed S3 recreation within two hours and cost evidence. |
| ED-01 App data disk is unavailable | Nine host fixtures covered absent and wrong disk, reboot and reattachment; the retained-disk fixture rejected target and disk replacement. | 2.3: actual App disk mount denial, reboot, reattachment and persistent data. |
| ED-02 Unauthorized staging or backend access | Strict ingress and NetworkPolicy renders; tester and smoke leases checked with synthetic authorization; Envoy route, auth and deployment checks. | 2.3 and 3.1–3.2: HTTPS client membership, spoofed identity rejection, private management and backend denial. |
| ED-02 Judge reaches dependencies | The disposable K3s VM ran the pinned guarded executor under a CRI-bound permit. The Worker gRPC integration compiled and ran C++ and removed the executable file ID. The host observed private namespaces, zero block devices, delegated cgroups, 67,125,248 bytes and 10 PIDs for a bounded request. | 2.3: actual private paths and CPU, memory, process, time and output enforcement for official submission and Run Code; network, IMDS and host/cloud credential denial. |
| ED-02 Workload crosses its authority boundary | Native admission and RBAC refused host paths, unrelated secrets, management escalation, unexpected placement and broadened workload authority. Mock host rules deny Pod metadata traffic. | 2.3: live packet, IMDS, credential and management denials for ordinary App workloads and Worker. |
| ED-02 Privileged executor restarts | Guard replay fails with the old PID namespace. A retained local Job and Deployments could not start guarded children after a QEMU hard stop. | 2.3: actual Judge restart and fresh verified permit recovery. |
| ED-02 Release requests additional privilege | Native Kubernetes API fixture denied changed service accounts, privileges, host namespaces, images, mounts, init/sidecars, placement and policy writes. | 2.3: unauthorized manifest and role modification on the real cluster. |
| ED-03 Concurrent passing merges | Publication tests wrote two independent SHA receipts concurrently and preserved a single immutable binding on retry. | 2.2 and 3.1–3.2: real trusted workflow runs and first-write receipt behavior. |
| ED-03 Failed checks or incomplete publication | Refused failed, skipped and cancelled checks, changed run/attempt, missing image/prefix inputs and mismatched content. | 3.1: required checks on the registered workflow and actual role scopes. |
| ED-03 Interrupted publication | Injected OCI upload failure left no receipt. Retry verified the first receipt and conflict left it intact. Reconcile accepts only PR-backed commits from the protected history. | 3.1–3.2: missed publication across registration, concurrent canonical receipts and protected reconciliation. |
| ED-03 Unprotected artifacts | Refused legacy tag/manual refs, arbitrary SHA, rehearsal-to-S2 and unknown commits. S3 read-only checks use the reviewed PR head. | 3.1: verify historical workflow disablement and credential retirement on applicable refs. |
| ED-03 Separate environment renders | Kustomize v5.7.1 produced 118 resources per overlay and 13 identical image pins. Both passed strict Kubernetes v1.35.10 and Traefik v3.7.15 schemas. Packaging used real rendered bytes and extracted Goose SQL. | 2.3 and 3.2: observed release, applied config and secret isolation for each environment. |
| ED-04 First activation | Signed synthetic approval fixture powers only the pair, withholds runtime and tester authority before separate deployment approval and requires smoke plus verified readiness. | 2.3 and 3.1–3.2: protected GitHub environments, Entra identities and approved first start/deploy. |
| ED-04 Wrong role, action, release or replay | Signed fixture rejected wrong Entra role, GitHub ref, run attempt, workflow, changed payload and replay in another run. | 2.3 and 3.1–3.2: real claims, reviewer eligibility and cross-role denials. |
| ED-04 Independent dispatch | Fixture retained owner requester, different dispatcher and owner reviewer in the conditional record. | 3.2: native approval and exact run-bound original request. |
| ED-05 Clock starts at readiness | Fixture started a one-hour lease only after both power states and verified release readiness. | 3.2–3.3: real readiness, lease and expiry timestamps. |
| ED-05 Owner-approved extension | Fixture admitted current-generation fresh approval and refused extension beyond the mandatory off window. | 3.3: real extension with independent fresh approval. |
| ED-05 Concurrent requests or insufficient time | Fixture denied overlapping start, stale heartbeat/epoch and insufficient off time; expired operations failed closed. | 3.3: observed twelve-hour daily deallocation floor and operation refusal. |
| ED-06 Deploy exact release | Host fixtures integrated activation, approval/lease, database gate, ordered App and Judge startup and synthetic HTTPS smoke. Native K3s Job recreation rejected stale UID deletion. | 2.3 and 3.2: actual migration, historical versions, runtime digests and all journeys. |
| ED-06 Migration failure or uncertainty | PostgreSQL 15.6 and Goose v3.30.0 exercised contention, lost writer lock before commit, retained markers, partial schema, wrong identity and recovery-only Secret erasure. | 2.3: actual interrupted DDL and retained job recovery. |
| ED-06 Contest freeze | Controller and release fixtures denied planned changes during freeze and allowed safety cleanup. | 2.3 and 3.2: real protected policy and refusal. |
| ED-06 Abrupt restart | Local K3s hard stop retained desired workloads and Job without starting the guarded children. Missing App lease and node epoch change revoked admission in fixtures. | 2.3: hard-stop real pair during migration or rollout; prove DDL, outbox, result consumer and judging stay fenced. |
| ED-07 Restore compatible release | Managed PostgreSQL fixture verified equal all-owner histories without invoking Goose. Host rollout verifies positive old Submission exit. | 2.3 and 3.3: actual rollback and S2 timing within 15 minutes. |
| ED-07 Incompatible rollback | Disposable PostgreSQL rejected drift, old history and incompatible version; partial advancement required a separate forward deployment. | 2.3 and 3.3: real checked version and recovery outcome. |
| ED-08 Expiry with active work | Controller fixture closed tester admission, recorded retained counts and required both deallocated states. Local PostgreSQL and Kafka verified role-limited counts and active group refusal. | 2.3 and 3.3: real retained attempts, outbox, lag/offsets, DLT, result delivery and restart persistence. |
| ED-08 Workflow interruption or partial cleanup | Pending power intents survived controller recreation and delayed a new start; a late VM start got another deallocation without replaying start. | 2.4 and 3.3: actual cancellation, partial/late results, deadline and retries. |
| ED-08 Controller unavailable | Stale heartbeat/lease denied access in fixtures; independent Monitor definitions passed Terraform checks. Emergency fixture denied start and required confirmation of both exact VM states. | 2.4 and 3.3: actual alert delivery, independent emergency credentials and paired instance views. |
| ED-08 Interrupted S3 experiment | Independent fixture timer retained the S3 deadline and initiated pair cleanup and inventory follow-up. | 2.4: interrupt runner and controller, prove alert and recover/destroy only reviewed S3 inventory. |
| ED-09 Eligible promotion | Fixture accepted a reviewed semantic tag mapping, canonical staged bundle, matching versions/config/digests and separate approval. Eligibility workflow has no build or deploy step. | 3.1–3.2: exact real S2 evidence and registered non-deploying checks. |
| ED-09 Rejected promotion | Refused rehearsal, wrong mapping, unstaged or mismatched evidence, missing approval and contest freeze. | 3.2: actual protected wrong-ref and mismatched-evidence cases. |
| ED-10 Azure checkpoint | Offline policy checks validated subscription/state shape, target restrictions and budget/alert definitions. | 2.1 and 2.4: tenant, quotas, offers, credits, costs and 50/80/100% notifications. |
| ED-10 Staging capability or budget unverified | Provisioning and delivery have explicit independently reviewed arming and spend gates. | 3.1: owner-confirmed off window, measured S3 sizing, account access and recurring cost approval. |
| ED-10 Failed canonical staging acceptance | Failed smoke, schema and unexpected state fixtures kept the release closed. Tasks 3.1–3.4 remain unchecked. | 3.4: complete canonical acceptance evidence or a reviewed correction and fresh acceptance. |

The local privileged daemon observations establish the tested k3s/containerd behavior on that disposable VM. They do not establish Azure networking, full resource limits under load, or an isolation boundary against a compromised privileged daemon.

The integrated verification passed `make test` (Go tests, vet and race, benchmark checks, 620 website tests, website build, local Compose config and 11 OpenSpec items) and `make test-db` (all three targeted PostgreSQL suites). Local checks also passed CI's Compose assertions, deployment script fixtures, Envoy generation/route/integration/image rollback suites, website lint and formatting, gateway client contract, and all six application Dockerfiles plus the managed migrator. The Envoy integration left its optional old-gateway comparison skipped. `actionlint` 1.7.7, `shellcheck`, shell syntax, strict change validation and diff whitespace checks passed. The hosted CI and independent Gate 2 review remain separate gates.

## Phase A preflight remediation

The original reviewed checkout was `c89c132`. The regression fixtures reproduced rejection of the second S3 bundle, refusal of an authorized restart after the controller reached off, removal of existing VM resources when toggling compute and rejection of routine reconciliation with expired startup inputs. Preflight observations, separately verified retail pricing and pending cloud checks are recorded in the [Azure preflight observations](#azure-preflight-observations).

| Finding | Offline verification | Remaining live verification |
| --- | --- | --- |
| PA-01 | The controller retrieved and verified both receipt digests, deployed A and B, rolled back to verified A, and rejected unapproved primary or fallback artifacts, policy widening and rollback without verified history. Release policy fixtures verified rehearsal isolation and existing publication guarantees. | Deploy both approved S3 release packages and record exact checks, digests, all-owner histories, zero rollback DDL, smoke and elapsed time. |
| PA-02 | Controller fixtures exercised deallocation before resume, only one authorization per retained attempt, closed leases before both new boots, stale Job rejection, separate recovery, sealed partial histories and independent cleanup after an unauthorized or late start. The managed PostgreSQL fixture checked all-owner reconciliation and writer fencing. | Hard-stop an actual S3 rollout or migration and verify VM, Job/Pod, disk, mount, schema, outbox, results and Judge state before and after recovery. Confirm the bounded external start role and independent alert and cleanup. |
| PA-03 | Terraform mock state reconciled an existing pair without startup inputs and rejected a disabled topology flag, expired startup input, state retarget and disk replacement. Operator tests exercised current create/replacement authorization, stale saved plans, cancelled grants, deallocated maintenance, operation scope, one delete-before-create, unchanged NIC/disk and the quota-constrained strategy. | Prove authorized execution in the scoped operator context, actual allocation and deallocation, a deallocated no-op plan and same-IP, same-disk replacement. The approved-plan runner and controller are required for compute writes. |

Current command outcomes and remaining gates are recorded in the [change progress](../../openspec/changes/azure-walking-skeleton/progress.md). The hosted checks in the preflight record refer to the original PR head. [Operator procedure](../../infra/azure/README.md)

## Reproduction

- Run `make test`, `make test-db` and `openspec validate azure-walking-skeleton --strict`. The CI Compose and deployment scripts, Envoy and website tooling checks are documented in [.github/workflows/ci.yml](../../.github/workflows/ci.yml).
- For the Terraform, retained-disk, host and render tests, follow [Azure IaC](../../infra/azure/README.md) and [Kubernetes validation](../../infra/kubernetes/README.md).
- For the disposable PostgreSQL and Kafka cases, protected activation, synthetic HTTPS fixture and K3s tests, follow [managed activation](../../infra/azure/lifecycle/README.md). The release reader fixture uses the local migrator's extracted `/migrations`.
- For policy fixtures and exact-revision workflow checks, see [release delivery](../../scripts/release/README.md). See [controller operations](../../infra/azure/lifecycle/controller/README.md) for the signed-token, time, Blob and power fixtures.

## Azure preflight observations

Recorded 2026-11-28 for the offline remediation of draft PR #73. The checkout and hosted PR both initially pointed to `c89c13221ccf09c6c8cdf7b1c62d840b657fed70` on `feature/azure-walking-skeleton` targeting `develop`. GitHub reported 12 commits, passing CI and OpenSpec, and a skipped rehearsal-head check. These check results belong to the original PR head. [PR #73](https://github.com/nvawntien/astracode/pull/73) · [CI](https://github.com/nvawntien/astracode/actions/runs/45772783003) · [OpenSpec](https://github.com/nvawntien/astracode/actions/runs/45772782952)

### Orchestrator CLI observations

The Orchestrator supplied the following results from authenticated Azure CLI and GitHub checks. Record subscription and principal IDs in protected configuration.

| Slot | Operator CLI profile | Purpose | Tenant | Reported effective access |
| --- | --- | --- | --- | --- |
| S1 | acc5 | Production | A | Own operator is Owner. No additional centralized assignment. |
| S2 | acc4 | Staging | A | Own operator is Owner. acc1 is Reader. |
| S3 | acc3 | Testing and benchmark | A | Own operator is Owner. acc1 is Reader. |
| S4 | acc1 | Shared operations | A | acc1 is Owner. |
| S5 | acc2 | Reserve and recovery | B | Own operator is Owner. No additional centralized assignment. |

- All five Azure for Students subscriptions were Enabled. The Orchestrator reports approximately USD 100 and one year of remaining validity per subscription. Confirm balances and expiry separately in Azure Billing. Treat each subscription as its own budget.
- Southeast Asia was policy-blocked. East Asia showed the candidate SKUs and was policy-blocked in S2. The desired B-series sizes were absent from the Indonesia Central check. Korea Central was allowed for S2, S3 and S4. S2 and S3 returned empty SKU restrictions in this region for `Standard_B4s_v2`, `Standard_B4ls_v2`, `Standard_B2s_v2` and `Standard_B2ls_v2`. Actual allocation and sustained performance are pending.
- S2/S3 registered Compute, Network, Storage, KeyVault, ManagedIdentity, Web, App, Insights, OperationalInsights, Authorization and Consumption. S4 registered Storage, Authorization and Consumption. Terraform automatic provider registration remains disabled.
- S2/S3/S4 returned 0 of 250 Storage Accounts in use and StorageV2 with Standard_LRS available. S2/S3 reported Korea Central availability for Key Vault and Functions Flex Consumption. Subscription FC1 eligibility and quota, deployment package delivery, VNet and private Blob access, timer delivery, Entra authentication, managed identity authorization and notifications require live evidence.
- Tenant A disallows member app creation and the available accounts reported no directory role assignments. Tenant B allows member app creation. No cross-tenant enterprise application, consent or role assignment was demonstrated. See the [pending Entra decision](../../openspec/changes/azure-walking-skeleton/design.md#pending-entra-and-github-federation-decision).
- GitHub reported a public repository, Orchestrator ADMIN access, an existing `production` environment with no protection rules, and default immutable OIDC subjects with prefix `repo:nvawntien@200005493/astracode@1157203560`. Native approval, federation and negative access proof remain pending.

### S2 and S3 quota per subscription

| Korea Central resource | Used | Limit | Candidate |
| --- | ---: | ---: | ---: |
| Regional vCPUs | 0 | 6 | 6 |
| Bsv2 family vCPUs | 0 | 10 | 6 |
| VMs | 0 | 25,000 | 2 |
| VNets | 0 | 1,000 | 1 |
| Standard Public IPv4 | 0 | 3 | 3 |
| NAT Gateways | 0 | 15 | 1 |
| NICs | 0 | 65,536 | 2 |
| Private Endpoints | 0 | 65,536 | 2 |

The 6/6 regional vCPUs and 3/3 public IPs leave zero spare capacity. An approved replacement deletes one VM before recreating it with the same NIC and IP. S3 must prove residual quota, provider allocation, and verified App disk reattachment. A change requiring extra capacity needs an approved quota increase or a separately reviewed procedure.

### Candidate and retail estimate

The Orchestrator selected the 4-vCPU App candidate to allow room for future services and observability. The exact Marketplace image version, SKU allocation, CPU credits under sustained load and usable headroom require evidence. [Selected Azure topology](../architecture/deployment.md#azure-topology)

The public Azure Retail Prices API returned USD 0.208/hour for `Virtual Machines Bsv2 Series`, SKU and meter `B4s v2`, region `koreacentral`, type `Consumption`, effective 2023-09-01. The same response listed separate Windows, Spot, Low Priority and Cloud Services meters. The previously supplied USD 0.052/hour Judge rate estimates USD 0.260/hour for both VMs. [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)

| Resource | Supplied retail unit rate | 30-day standing estimate |
| --- | ---: | ---: |
| One Standard NAT Gateway | USD 0.045/hour | USD 32.40 |
| Two private endpoints | USD 0.01/hour each | USD 14.40 |
| Three static Standard public IPv4s | USD 0.005/hour each | USD 10.80 |
| Three Standard SSD E6 LRS disks | USD 4.80/month each | USD 14.40 |
| Total | | USD 72.00 |

At 2–4 VM hours/day, 14 days estimates USD 40.88–48.16 and 21 days USD 61.32–72.24. The scenario uses 30-day proration and pay-as-you-go rates. The other quoted VM rate for B2s_v2 is USD 0.104/hour. The estimate excludes NAT processing at the supplied USD 0.045/GB, E6 operations at USD 0.002 per 10,000, endpoint traffic, Storage, Key Vault, DNS, Functions, monitoring, taxes and student benefits. The Orchestrator expects typical usage below eight hours/day. Verify billed rates, credits and eligibility. The forecast is limited to the submission horizon.

The short-term planning targets are independent, with S2 at about USD 80 or less, S3 at USD 20 or less and S4 at USD 10 or less. S1/S5 retain zero M0-13 compute. Require 50/80/100% alert configuration and recipient evidence, record credit and cost daily during the short rehearsal, and keep the weekly review and staging off-time floor. Alerts notify and can lag actual charges. The controller independently enforces the session deadlines. [Operations and teardown](../../infra/azure/README.md#environment-retirement)

### Open evidence

- Task 2.1 needs verified balances and expiry, effective write and data-plane permissions, the Entra decision, exact OIDC and native approval proof, eligible FC1/package/storage access and quota, alert prerequisites and protected receipt path. Record the exact Marketplace image and check the current quotas before planning.
- Tasks 2.2–2.4 require authorized S4 or S3 operations and evidence. Gate 2 requires the reviewed candidate SHA, green checks, independent review, S3 timed recreation, isolation and cleanup evidence. Task 3.1–3.4 require a separate protected default-branch transition and then canonical S2 acceptance.
- Real deployment, billing, approval enforcement, allocation, latency, benchmark, rollback, hard-stop recovery, receipt retention and cleanup results are pending.
