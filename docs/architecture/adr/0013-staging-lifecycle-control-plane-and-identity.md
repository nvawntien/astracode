# ADR-0013 — Staging Lifecycle Control Plane and Identity

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-28 |
| Implementation | M0-13 `azure-walking-skeleton` |
| Requirements | NFR-D01, NFR-D02, NFR-D04, NFR-F03, NFR-S08, NFR-S09 |
| Supersedes in part if accepted | ADR-0004, Staging lifecycle, only the assignment of direct Azure start authority described below |
| Review | Orchestrator and an independent infrastructure or security reviewer under [Team Workflow §10](../../process/workflow.md#10-adrs) |

## Context

ADR-0004 assigns staging startup to GitHub Actions and Azure CLI. The M0-13 offline candidate instead has the workflow submit an approved request and a separately authenticated controller own the Azure start action on the S2 VM pair. An external control plane can still reconcile startup and initiate cleanup after the workflow exits.

The reported tenant A policy prevents ordinary app registration. A directory administrator, delegated registration route, or existing approved application with the required grants has yet to be confirmed. Subscription Owner is an Azure resource role. Directory app registration, delegated consent and app-role assignment require their own authority. Workload federation to Azure resources alone cannot establish the custom controller API's audience, delegated member caller or machine roles. The project has a 14–21 day planning window. [Preflight observations](../../evidence/m0-13-phase-a.md#azure-preflight-observations) · [Microsoft Entra directory roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference)

## Options

| Option | Security, operations and delivery trade-offs |
| --- | --- |
| Controller-owned Azure power with tenant A Entra integration, conditional on verified directory support | Uses the existing candidate implementation and isolates direct power from workflow jobs. Requires confirmation of API registrations and service principals, delegated member access and separate app-role assignments, plus live application and federation checks. Likely the smallest implementation change within the planning window once these prerequisites are confirmed. |
| Keep the ADR-0004 direct-start model with a narrowly federated workflow and a separately authorized cleanup controller | A protected workflow with pair-scoped Azure rights is a possible deployment pattern if the federation, approved request and pair-scoped access can be verified. Direct start increases the workflow's authority and requires reliable handoff of operation and deadline state to the cleanup controller. It leaves custom API authentication for members and the App poller unresolved and requires rework of the current candidate. |
| Controller-owned power with a different approved identity boundary | An existing approved identity issuer or a short-lived certificate gateway could support the controller if the team can verify member mapping, machine authentication, revocation and independent approval. A multi-tenant Entra app would still need explicit tenant A enterprise application, consent and role grants. No such route is confirmed. The additional trust and failure modes make these options unlikely within the planning window without an existing approved service. |

## Proposed decision

Keep GitHub as the approval and dispatch path and give the independent S2 controller routine Azure power authority for the reviewed pair. Prefer tenant A Entra integration only after an authorized directory route and the required registrations and grants are confirmed. Withhold live activation if identity or approval assurance is unresolved. A different authentication architecture requires Orchestrator acceptance before implementation. [GitHub OIDC claim reference](https://docs.github.com/en/actions/reference/security/oidc)

Prefer native Environment Required Reviewers. If native review is unavailable, separately review an equivalent protected request-PR path with role-specific ownership, independent approval of the exact revision, stale-review dismissal and an authenticated post-merge verifier. Keep the private App pull path for routine delivery. A runner on App ties privileged workflow execution to the data host and its uptime. Routine Azure Run Command would give delivery guest execution authority. Keep guest execution under the separate infrastructure bootstrap or recovery authority.

| Actor | Proposed authority |
| --- | --- |
| Authorized member | Submit a typed request bound to that member's verified identity. The request grants no approval or power authority. |
| Project owner and designated maintainers | Owner approves S2 lifecycle requests such as startup and extension. Either designated maintainer may approve deployment or rollback independently of startup. Future production promotion retains its separate maintainer approval. Use the protected approval mechanism and preserve requester, dispatcher and reviewer separation where required. |
| Protected GitHub workflow | Submit the approved operation and its proof, with separate scoped workflow identities. Bind the proof to the immutable request, repository, protected workflow revision and run attempt. The lifecycle and deployment jobs hold no direct Azure VM power, Terraform state or runtime secret authority. The separate release publisher can publish only within its reviewed scope and cannot authorize staging. |
| Controller verifier | Verify the caller and approval independently, validate the exact environment and operation, prevent replay and persist the decision and deadline. The App participant authenticates separately and receives only the authority needed to observe and execute the approved workload operation. |
| Azure power principals | The S2 controller identity is the routine start and deallocate principal for the approved pair. Infrastructure creation or replacement can power a VM through a separate, plan-bound, owner-approved window with cleanup armed and workload activation closed. In S3, the controller can observe and deallocate. An authorized infrastructure operator owns any separately bounded start for rehearsal or recovery. |
| Emergency and independent cleanup | The separate emergency identity can observe and deallocate only the target pair. The controller reconciles expiry and incomplete operations from durable state, independently of any GitHub run. Independent monitoring reports missing health or unconfirmed cleanup. Require both observed deallocated states before recording completed cleanup. |

## Effect on ADR-0004

If accepted, this supersedes only the assignment of direct VM start to GitHub Actions in item 1 of [Staging lifecycle](0004-azure-topology-and-subscription-layout.md#staging-lifecycle) and the corresponding direct-power interpretation of the following paragraph assigning lifecycle implementation to GitHub Actions and Azure CLI. GitHub continues to handle the protected approval and dispatch path. This extends the last bullet of [Delivery and access control](0004-azure-topology-and-subscription-layout.md#delivery-and-access-control) by separating the workflow, verifier and Azure power identities. The topology, separation of infrastructure and application delivery, owner and maintainer approvals, session duration, off-time floor, independent cleanup requirement and data retention stay in force.

## Consequences and validation

This adds a controller and durable state as security-critical dependencies. Lost or uncertain state closes new startup, deployment or tester admission. The separate monitoring and emergency path remain available when the controller or GitHub is unavailable. Independent cleanup can retry delayed operations and reports unconfirmed outcomes.

Before live use, verify directory authority and the actual member, workflow, App and controller principals, token audiences, app roles and Azure RBAC. Exercise positive and negative approval proofs on protected refs, including replay, self-review and bypass checks. Confirm that an unauthorized workflow cannot obtain power authority or write canonical receipts. Exercise independent monitoring, deadline recovery and emergency deallocation, and record actual VM states before reporting cleanup. The outstanding tenant decision and cloud evidence remain Task 2.1 and later acceptance gates. [Active change](../../../openspec/changes/azure-walking-skeleton/tasks.md)
