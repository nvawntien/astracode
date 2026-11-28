# ADR-0013 — Staging Lifecycle Control Plane and Identity

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-28 |
| Direction approval | The Orchestrator approved the simplified direction and authorized offline implementation in the M0-13 simplification decision on 2026-11-28. Independent ADR review and formal acceptance remain pending. |
| Implementation | M0-13 `azure-walking-skeleton` |
| Requirements | ED-01–ED-10, NFR-D01, NFR-D02, NFR-D04, NFR-F03, NFR-S08, NFR-S09 |
| Supersedes in part if accepted | ADR-0004, Staging lifecycle, for VM startup, session timing and automatic cleanup as specified below |
| Review | Orchestrator and independent infrastructure or security reviewer under [Team Workflow §10](../../process/workflow.md#10-adrs) |

## Context

M0-13 needs a reproducible Azure deployment and measured acceptance before the project deadline. The original proposal required custom Entra registration, several app roles, an external Functions API, independent power reconciliation and short-lived network grants. Its Blob mailbox alternative removed the directory API but still needed additional runner reachability, durable command and approval reconciliation, and time-sensitive revocation. These paths delay the first deployment and add infrastructure to operate. Tenant A directory assistance remains unconfirmed.

## Proposed decision

- A member requests access in the existing team channel or GitHub. The Orchestrator approves and records the operating window. A scoped infrastructure operator starts both VMs manually and verifies the actual power states, persistent mount, both k3s nodes and workload safety. Changing the window requires fresh owner approval. The operator keeps at least 12 hours of observed daily deallocation for both VMs and reserves a safety margin for shutdown delays.
- Keep CI on merges to `develop` and publish immutable GHCR releases only after passing checks. A separate designated maintainer approves the exact deployment or rollback through a protected GitHub Environment. The protected workflow then runs migration, rollout, readiness and smoke checks automatically against that release. Preserve the exact staging receipt required for future production promotion and retain isolation for S3 rehearsal artifacts.
- Configure daily Azure-native VM auto-shutdown for the exact pair in an explicit time zone. Keep automatic startup disabled. The operator can close access and deallocate earlier, confirms deallocation of both VMs and retries or invokes the scoped emergency path if scheduled shutdown misses its deadline. Keep notifications, budget alerts and data retention. A fixed schedule does not implement a readiness-based timer. [Azure VM auto-shutdown](https://learn.microsoft.com/en-us/azure/virtual-machines/auto-shutdown-vm)
- Retain host-local authorization for workload activation, migration, and tester access. Keep these closed on boot, missing or expired approval, stale node or process identity, unverified storage, interrupted mutation or uncertain health. Recover explicitly under a new approval using the actual database histories and exact retained release. Routine shutdown and emergency deallocation preserve the App disk, NICs and IPs.

| Principal | Authority |
| --- | --- |
| Member | Request a window or delivery and use staging when admitted. |
| Orchestrator | Approve startup and the exact operating window, and approve changes to that window. |
| Infrastructure operator | Manually start the pair after approval. Maintain the schedule, verify power and readiness, and perform exact reviewed creation or recovery. |
| Designated deployment maintainer | Separately approve the exact release, action and workflow attempt. Deployment approval gives no VM power authority. |
| Protected deployment workload identity | Run the reviewed delivery operation through the private management path. Azure Action Run Command is guest execution authority on App. Scope it to the exact App VM and protected workflow, with no power, Terraform, role assignment or Judge access. App root remains in the deployment trust boundary. Prove deny cases before live use. |
| Emergency operator | Read and deallocate only the target pair. Verify the resulting Azure instance views. |

Native schedules reduce cloud permissions and infrastructure. They cannot enforce a minimum off interval on an operator who ignores approval or starts a VM early. Give startup only to trusted operators, record actual instance views and audit activity, leave a shutdown margin, and treat missing confirmation as a blocked next window. A missed schedule requires an operator response independent of GitHub. Use no custom scheduler unless native shutdown is shown insufficient for an essential requirement. Keep SSH and the Kubernetes API private. An approved transport must preserve automated delivery and current workload safeguards. [GitHub Environment protections](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) · [Azure Linux Action Run Command](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command)

## Effect on ADR-0004

If accepted, this replaces item 1's assignment of direct startup to GitHub Actions in [Staging lifecycle](0004-azure-topology-and-subscription-layout.md#staging-lifecycle). It replaces item 2's readiness-based one-hour limit and per-session extensions with operating windows and fresh approval for changes. Item 3's automatic deallocation, bounded interruption or reconciliation of in-flight work, and data retention stay in force. The following paragraph's GitHub Actions/Azure CLI lifecycle implementation and independently retried cleanup are narrowed to automated release delivery, platform-scheduled deallocation and explicit operator verification and retry. The S2 row in [Platform and subscriptions](0004-azure-topology-and-subscription-layout.md#platform-and-subscriptions) retains on-demand owner approval and independent data, with shutdown at the approved closing time or earlier.

This extends the final bullet of [Delivery and access control](0004-azure-topology-and-subscription-layout.md#delivery-and-access-control) with the operator/workflow authority split and scope validation. Separate deployment approvals, private cluster management, topology, sandbox boundary, release integrity, rollback, persistent resources and daily off-time remain in force. The revised NFR-F03 is subject to product review. NFR-D01 remains in force.

## Validation

Verify native shutdown and notifications on the actual S3 offer and check both instance views independently of GitHub. Rehearse early stop, interrupted deployment, one-sided deallocation, missing VM recovery, and restoration of the same disk, network identities and quota footprint. Verify workflow approval protections, UAMI federation, allowed target, no power or Judge access, and immutable release/run binding. Prove safe migration and restart and the mandatory isolation checks in [ADR-0012](0012-judge-executor-trust-boundary.md). Record results through the [existing change tasks](../../../openspec/changes/azure-walking-skeleton/tasks.md).
