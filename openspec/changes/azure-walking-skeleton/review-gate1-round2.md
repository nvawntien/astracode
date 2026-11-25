---
change: azure-walking-skeleton
gate: 1
round: 2
reviewed_commit: 96ff799e2fcf2dd5159e112a25d9dc4e1b99713c
previous_reviewed_commit: 3387d30f2700c58a8389bdeaa3510dff114e5a98
base_commit: 1804dc27eeaf30286da1a1d301023c876d4e7b16
risk: high
verify: not_run_independently
status: approved
orchestrator_sequence_approval: approved
apply_authorization: approved_phase_a_only
---

# Gate 1 - M0-13 Azure walking skeleton - Round 2

## 1. Final technical verdict

**ACCEPTED / APPROVED - independent Gate 1 technical review.**

All five Round 1 findings have been addressed at the proposal/design level. No new blocking technical finding or additional proposal-remediation round is required. The plan is suitable for incremental implementation once the explicit Orchestrator sequencing decision and applicable formal Gate 1 checks are recorded. This is approval of the plan, not evidence that the proposed infrastructure or its security and lifecycle controls already work.

- Review date: 2026-11-26 (Asia/Ho_Chi_Minh).
- Repository: `nvawntien/astracode`; branch [`feature/azure-walking-skeleton`](https://github.com/nvawntien/astracode/tree/feature/azure-walking-skeleton).
- Reviewed head: [`96ff799`](https://github.com/nvawntien/astracode/commit/96ff799e2fcf2dd5159e112a25d9dc4e1b99713c), `docs(openspec): address M0-13 Gate 1 review findings`.
- Previous review: [`3387d30`](https://github.com/nvawntien/astracode/commit/3387d30f2700c58a8389bdeaa3510dff114e5a98); the original `review-gate1.md` remains in the change directory and retains its Round 1 changes-requested verdict.
- Base: `develop` at [`1804dc2`](https://github.com/nvawntien/astracode/commit/1804dc27eeaf30286da1a1d301023c876d4e7b16). At review time, the branch is two commits ahead and zero behind. The M1-02 migration archive is already included in the base.
- Scope: compared the revision against Round 1 and the complete change against `develop`; inspected the revised proposal, design, delta spec, task/evidence map, progress and original review. The revision changes six files; the overall change adds seven files, all under `openspec/changes/azure-walking-skeleton/`. No application, infrastructure, workflow-policy, Accepted ADR or canonical spec changes are part of this revision.

This review is independent of the implementation author. It is not a submitted GitHub approval and does not authorize paid Azure operations, a default-branch maintenance PR, production deployment or any exception on behalf of the project owner.

## 2. Round 1 finding dispositions

Line references below refer to the reviewed head, unless explicitly identified as the original review. "Resolved" means the required design change and planned verification are present. It does not mean the implementation or a live scenario has passed.

| ID | Severity | Disposition | Revised evidence |
| --- | --- | --- | --- |
| G1-01 | P1 | Resolved technically; owner sequencing decision remains explicit | `proposal.md:12-13`; `design.md:154-168`; `tasks.md:1,13-29`; `progress.md:24-26`; ED-03, ED-09, ED-10. |
| G1-02 | P1 | Resolved | `design.md:54-77,99-101`; tasks 1.5, 1.6, 2.2, 3.1, 3.2; ED-03, ED-04, ED-09. |
| G1-03 | P1 | Resolved | `design.md:119-130`; tasks 1.2-1.4 and 2.3; ED-06 restart scenario at `spec.md:111-114`. |
| G1-04 | P1 | Resolved | `design.md:37-38,48-52,79-91`; tasks 1.2, 1.3, 1.6, 2.3, 3.1; ED-02 authority and privilege scenarios at `spec.md:32-38`. |
| G1-05 | P2 | Resolved | `design.md:103-115,168`; tasks 1.1, 1.6, 2.1, 2.3-2.4, 3.1, 3.3-3.4; ED-08 and ED-10. |

### G1-01 - Pre-merge and post-merge evidence

The circular acceptance condition has been resolved in the proposed sequence, rather than by claiming that an unmerged implementation has already produced canonical staging evidence. Tasks 1.1-1.7 and 2.1-2.4 belong before Gate 2. Tasks 3.1-3.4 remain unchecked until canonical S2 acceptance after merge to `develop`. S3 uses the exact reviewed candidate SHA, isolated rehearsal artifacts and non-promotable evidence. The plan explicitly prevents untrusted PR publication or Azure access and repeats affected evidence if the candidate changes. Failed post-merge S2 acceptance leaves the change open and the failed release ineligible for promotion. The owner must still approve this change-specific sequencing exception before Apply (section 4).

### G1-02 - Protected workflow registration and publication

The revised design acknowledges `main` as the default branch. A separately authorized minimal maintenance PR registers the trusted `main` dispatch and reconciliation path; no early milestone release, tag or broad merge to `main` is required. Startup and extension use the owner-only lifecycle environment, and deployment and rollback use the separate deployment environment. The plan binds the exact approved operation, digest, workflow run and attempt, and rejects changed requests, unauthorized refs and replay. It uses native GitHub environment reviews first and retains a conditional fallback only if verified necessary.

Canonical publication is tied to checked `develop` merge SHAs; interrupted or skipped events are reconciled from protected merge history, not arbitrary SHA input. A distinct protected receipt scope binds a commit to one immutable release. The semantic tag mapping points to the exact staged bundle and evidence, not a tag string or a newly built image. The old tag-build/manual publish and Compose deployment entry points have an explicit retirement/disable plan, including historical-ref checks. Task 3.1 prevents S2 activation until the actual default-branch transition, approval gates and legacy bypass checks are verified. This is a credible plan; actual GitHub/Azure integration remains to be verified.

### G1-03 - Fail-closed restart and managed migration

The design now separates backing-service readiness, authorized process activation and tester admission. It retains a durable last-verified release record and marks in-flight mutations before authorization. A platform-owned launch supervisor checks bounded permits tied to the current startup epochs, session, operation and workload digest, including on kubelet restarts. Persisted Jobs or workload objects cannot by themselves grant permission to run a migration, outbox, result consumer or judge process. Uncertain state requires reconciliation before new activation. Migration writer fencing, per-database histories, actual prior Submission termination and compatible rollback remain required. The new restart scenario and both local and S3 tasks explicitly exercise a hard stop with stale desired state/Jobs and a lost lease. This closes the restart design gap without changing the business contracts or automatically downgrading schemas.

### G1-04 - Identity and privilege boundaries

The actor-to-authority table distinguishes infrastructure/bootstrap, lifecycle, deployment, publisher, controller, App poller/activation, secret loader, migrator/runtime, testers, Judge and emergency operator. Routine delivery cannot use Terraform state, arbitrary guest commands or direct VM power. App root and the host-installed agents are identified as trusted; distinct managed identity client IDs are not incorrectly treated as process isolation. Host IMDS restrictions precede k3s startup. Judge has no attached Azure managed identity or Key Vault role and uses agent-only join material.

The trusted platform retains ownership of RBAC, policies, templates and launch guards. The proposed native Kubernetes admission path constrains workload shapes, commands, privileges, mounts, secrets, placement and digest/permit parameters independently of the candidate bundle. Negative checks now cover ordinary workload metadata/identity access, unrelated secret access and attempted privilege escalation. Validate the complete enforcement path against the pinned k3s version and real S3 sandbox, not just a rendered allowlist. The design addresses the requested trust boundary; no extra policy platform is required.

### G1-05 - Durable lifecycle, S3 cleanup and affordability

The plan now includes provisional boot/drain/cleanup deadlines, a durable reconciliation heartbeat, an independent Azure Monitor missing-heartbeat check and a distinct deallocate-only emergency role. It acknowledges that controller and Azure outages can delay confirmed deallocation and requires observed power-state evidence before declaring success. The S3 experiment also has an independently armed cleanup deadline before compute creation, an exact target inventory, and follow-up reconciliation of residual billable resources. The same minimal controller logic is reused instead of a second full platform.

Flex Consumption, network-restricted storage, static public IPv4 egress, monitoring costs and the daily off window remain provisional. Phase B verifies actual offer eligibility and costs, and stops before S2 spending if a prerequisite or budget cannot be met. This satisfies the requested design-level clarification. Azure availability, actual alert latency and the shutdown deadlines are not established facts.

## 3. Gate 1 checklist and verification provenance

| Check | Result |
| --- | --- |
| Alignment with M0-13, ADR-0004, retained managed ADR-0006 and ADR-0011 | Pass on design review. No architecture decision is reopened. |
| Canonical migration requirements | Pass. `database-schema-migrations` was archived by PR #72 and is referenced by the proposal. No duplicate capability is introduced. |
| Scope and non-goals | Pass. S1/S5 compute activation, full observability, capacity/scaling, full DR and unrelated application changes remain out of scope. |
| One capability and behavioral delta | Pass on inspection: 10 requirements and 32 scenarios in `environment-delivery`. |
| Task count and evidence mapping | Pass on inspection: 15 tasks, 0 checked, with ED-01 through ED-10 mapped to offline, S3 or S2 evidence. The work is substantial and must be split into sessions. |
| Approval and release provenance | Pass as a design; protected real-ref execution and cross-tenant access are later evidence gates. |
| Restart, migration, isolation and lifecycle failure cases | Pass as a design; the negative tests and real rehearsals remain mandatory. |
| `openspec validate azure-walking-skeleton --strict` | Author-reported pass in revised `progress.md:7`; not independently executed by the reviewer. |
| `openspec status --change azure-walking-skeleton` | Author reports 4/4 planning artifacts. The artifacts were independently inspected. |
| `openspec validate --all --strict` | Author reports 11/11 passing items. |
| `git diff --check`, links and artifact-rule review | Author-reported pass; the fsmonitor diagnostic was reported resolved on rerun. The CLI reportedly ignores string-valued rules, so the author performed a manual rules audit. |
| Hosted checks / draft PR | No open PR and zero check runs returned for this branch head at review time. No hosted CI result or submitted GitHub approval is asserted. |
| Real Azure validation | Not performed. No account activation, quota verification, resource creation, live approval, deployment, benchmark or cost measurement was performed by this reviewer. |

No new blocking technical finding. No additional planning-artifact remediation is requested. The following remaining decisions and evidence are not waived by this technical approval.

## 4. Owner decisions and mandatory boundaries

| Item | Disposition |
| --- | --- |
| Change-specific Gate 2 sequencing | **Explicit Orchestrator approval required before Apply.** Recommend accepting the proposed sequence: complete tasks 1.1-1.7 and 2.1-2.4, independent Gate 2 and required green CI before merge; complete tasks 3.1-3.4 using the protected post-merge S2 release; archive only after all evidence passes. This is an exception for M0-13 only, not a general workflow change. |
| Daily staging off window | `00:00-12:00 Asia/Ho_Chi_Minh` remains a candidate. Confirm or adjust before operational configuration. Retain the 12-hour floor, one hour from readiness and bounded startup/shutdown margins. This need not delay initial offline IaC work. |
| Default-branch registration | The minimal `main` maintenance PR is an explicit later prerequisite to S2. Obtain separate owner authorization and required review; do not merge early or activate a production release. |
| Controller, approval and receipt storage integration | Accepted as candidate implementation, not verified services. Keep the simplest design. Preflight must prove the GitHub-hosted publisher and controller can reach the separate protected S4 receipt scope with appropriate tenant/RBAC/network permissions. Never make Terraform state public or grant broad state/identity rights to solve reachability. Verify actual OIDC claims, review history and approval enforcement, native admission support and fail-closed behavior before exposure. |
| Cloud execution | No cloud action is authorized by this review. S4 bootstrap, S3 and S2 provisioning, budgets, identities, credentials and live rehearsals require separately authorized Phase B work. S1 and S5 compute remain inactive. |
| Formal Gate 1 | Preserve the normal draft-PR review and applicable repository checks. This review file is not a GitHub review submission. |

Suggested owner decision text, to be used only if the owner explicitly agrees:

> I approve the M0-13-specific two-stage completion sequence described in Gate 1 Round 2. Tasks 1.1-1.7 and 2.1-2.4 must be evidenced before Gate 2/merge. Tasks 3.1-3.4 remain open for protected post-merge S2 acceptance. Archive and M0-13 completion require all tasks and real evidence. I authorize Phase A offline implementation after the required Gate 1 checks; Azure operations and the main maintenance PR require separate authorization.

Do not infer that the owner has approved this exception merely because this review has status `approved`. Do not turn the proposed off window into an accepted owner preference without confirmation.

## 5. Handoff to Codex - Apply, Phase A only

1. Preserve the original `review-gate1.md`; add this file as `review-gate1-round2.md` within the same OpenSpec change. The Round 2 technical verdict supersedes the Round 1 verdict for the reviewed revision, while retaining the history.
2. Record the actual owner sequencing decision in the change's progress/decision record and confirm the formal Gate 1 conditions. If that decision is missing, stop before Apply. Do not edit the general workflow or Delivery Plan to silently implement an exception.
3. Once authorized, use the installed `openspec-apply-change` skill for `azure-walking-skeleton`. Read `AGENTS.md`, the proposal, design, delta, tasks and progress. Check the branch, base and clean baseline; preserve unrelated work. Run applicable session-start checks and stop on a red baseline.
4. Start with **task 1.1 only**: S4 bootstrap definitions and the reusable Azure environment root, including the planned isolation and controls. Build versioned IaC with example/synthetic inputs; prefer a minimal implementation. Do not begin unrelated tasks or new architecture. If a concrete service or provider constraint prevents the accepted design, report it rather than quietly changing ADR requirements.
5. Verify the actual changes with the task's applicable formatting, backend-disabled initialization, validation and supported offline tests; record exact commands/results and pending cloud checks. Provider/tool downloads are acceptable, but do not authenticate to Azure or call live plans/applies. Tick a task only when its scoped verification is actually satisfied; retain the cloud-dependent tasks unchecked. Update `progress.md` from evidence, not assumed success.
6. Continue through Phase A incrementally in reviewed sessions. Do not provision resources, start Phase B, deploy, modify production settings, activate legacy delivery, merge or archive automatically. Do not claim Gate 2 or M0-13 completion.

**Final status: APPROVED (technical Gate 1). All Round 1 findings are resolved. No Round 3 correction is requested. Apply requires the explicit owner sequencing decision and applicable formal Gate 1 checks; cloud execution requires separate authorization.**
