---
change: add-versioned-migrations
gate: 1
round: 2
max_rounds: 3
reviewed_commit: 5c5db19aa554372807ca38d016342143857b8fc3
risk: high
status: approved
---

## 1. Review scope and references

Reviewed the proposal, design, tasks, operational delta and change metadata at the recorded commit against the current repository and the five-file diff from `develop`. The review used [workflow §5](../../../docs/process/workflow.md#5-gate-1-checklist--spec-review), [configuration](../../config.yaml), [ADR-0006](../../../docs/architecture/adr/0006-schema-migration-policy.md), ADRs [0001](../../../docs/architecture/adr/0001-problem-row-lock-for-mutations.md), [0002](../../../docs/architecture/adr/0002-testcase-object-lifecycle.md) and [0003](../../../docs/architecture/adr/0003-worker-testcase-cache-generations.md), [NFR-D05](../../../docs/product/nfr.md#9-deployability-and-maintainability), and the [delivery plan](../../../docs/product/delivery-plan.md#m1--community-core). The [M1-01 Gate 1 review](../archive/2026-11-22-remove-contributor-role/review-gate1.md) supplies the review-record precedent.

The canonical [identity](../../specs/identity-session/spec.md), [catalog](../../specs/problem-catalog/spec.md), [moderation](../../specs/content-moderation/spec.md), [submission](../../specs/submission/spec.md), and [judging](../../specs/judging/spec.md) specifications and the current persistence, startup, fixture, Compose and protected-release paths were inspected. [PR #66](https://github.com/nvawntien/astracode/pull/66) was inspected through GitHub metadata, changed-file and workflow-run tools.

**Reviewer independence limitation.** This assistant previously drafted and revised the reviewed proposal in this conversation. This is a fresh specification assessment with no blocking or major specification defect found, but it is not a review by a different reviewer. The maintainer must obtain independent reviewer confirmation of this record before treating it as the workflow's independent Gate 1 approval. No GitHub approval is asserted here.

## 2. Round 1 review history

Round 1 reviewed `0eeabf0401e2ec3582d699a60d83d37d9f2f0321` and returned **changes-requested**. The supplied review history recorded four findings.

| Finding | Problem |
| --- | --- |
| 1.1 | Three-change decomposition conflicted with the maintainer's single-change direction. |
| 1.2 | Single-session Goose Provider locking needed an early feasibility proof. |
| 1.3 | Target identity, manifest provenance, durable checksums, prefix validation and dirty-checkout identity needed concrete designs. |
| 1.4 | The protected promotion hold needed enforceable controls, ownership and evidence. |

## 3. Round 1 finding dispositions

| Finding | Disposition | Evidence at round 2 |
| --- | --- | --- |
| 1.1 | Resolved by maintainer decision | [Proposal](proposal.md#execution-strategy) and [design](design.md#delivery-estimate-and-execution) retain one change, branch and PR with sequential internal phases. |
| 1.2 | Resolved in plan | [Design feasibility gate](design.md#single-session-feasibility-gate) and task 1.2 require a same-backend and lock-loss proof and a stop on failure. The proof has not been run. |
| 1.3 | Resolved in plan | [Design identity](design.md#target-identity-and-privileges), [bundle and reconciliation](design.md#bundle-applied-checksums-and-reconciliation), and tasks 2.1–2.3 specify the local identities, checksum journal, prefix snapshots and dirty-bundle digest. |
| 1.4 | Resolved in plan | [Protected promotion](design.md#protected-promotion-and-managed-release-prerequisites) and task 4.2 identify repository, maintainer and Infra actions and negative rehearsal evidence. Actual enforcement remains pending. |

## 4. Maintainer decisions and approved exceptions

The maintainer decisions supplied with this review approve one change, branch and PR, the `database-schema-migrations` capability, the 7–10 day size exception, and a November 24, 2026 target without reducing acceptance. M0-11 and M1-03 dependencies and existing baselines remain in force. The Goose Provider, local identity, manifest and journal designs, and temporary release freeze are accepted subject to the stated implementation evidence. Managed adoption, actual managed migrations and Azure or production deployment are outside the local cutover. These are decisions, not evidence that the work has passed.

## 5. Formal Gate 1 checklist

| Workflow §5 check | Assessment and evidence |
| --- | --- |
| Proposal traceability | Pass. The first line states `Addresses: NFR-D05 | Follows: ADR-0006`. No F-xx is claimed for this enabler. |
| Scope and non-goals | Pass. [Proposal](proposal.md#what-changes) implements the named enabler and excludes product features, adoption and deployment. Existing business baselines remain regression requirements. The enabler has no supplied PRD feature section to compare. |
| Behavior-only deltas | Pass. The new [operational spec](specs/database-schema-migrations/spec.md) has observable behavior and no implementation table, class, endpoint or path names. |
| Testable scenarios | Pass in plan. All 22 scenarios have observable outcomes and the task mapping below identifies planned verification. |
| Existing targets and conflicts | Pass. The delta contains ADDED requirements for one new capability, with no MODIFIED or REMOVED targets. `openspec list --json` returned only this active change. No local in-flight conflict was identified. |
| NFR and ADR alignment | Pass in design, subject to the acceptance evidence below. See §6. |
| Contract classification | Pass. [Design contract draft](design.md#operational-contract-draft) marks local startup BREAKING and service contracts NON-BREAKING. The one-shot runner behavior is described there. |
| Size | Pass by explicit maintainer exception. One capability and 12 tasks meet the count limits. The 7–10 day estimate exceeds 1–4 days and the supplied decision waives that limit. |

## 6. ADR-0006 and NFR-D05 compliance assessment

The plan specifies independent Auth, Problem and Submission SQL sequences, Goose v3.30.0 artifact verification, physical PostgreSQL 15.6 schema parity, transactional forward execution, and no Judge Worker database ownership. It plans a read-only startup gate and keeps GORM for application persistence. [Design](design.md#proposed-implementation) · [Tasks](tasks.md)

The runner plan covers owner and instance validation, least-privilege roles, full history and checksum validation, prefix catalog verification, same-session locking, contention, lock loss, partial success and reconciliation. It addresses local checkout identity, fixture protection and explicit seeds. Submission/Attempt/Outbox atomicity, rejudge correlation, Problem locks and immutable testcase lifecycle remain protected by the existing contracts and planned regression work.

NFR-D05's backward compatibility extends beyond an initial empty schema. ADR-0006's managed release preflight, per-database and release-wide serialization, expand/backfill/contract, protected activation, backup and compatible DDL-free rollback remain prerequisites before managed use. [Managed release plan](design.md#protected-promotion-and-managed-release-prerequisites)

## 7. Requirement-to-task verification coverage

The task references below are planned evidence. None has been marked complete.

| Requirement and scenarios | Tasks and expected verification |
| --- | --- |
| Independent versioned schemas — initialize empty; reject invalid sequence | 1.1–1.3, 2.2, 3.4. Capture and compare the legacy schema, apply all three initial schemas, reject sequence and hash violations, and repeat the run. |
| Verify migration target — incorrect target | 2.1–2.2. Reject each mismatched identity or owner before a write. |
| Validate history and schema — known prefix; repeat target; untrusted history or drift | 2.2–2.3, 3.4. Reproduce snapshots, test applied-prefix and checksum validation, no-op, drift and retry. |
| Serialize migration — concurrent runners; lock loss | 1.2, 2.3. Prove the backend and lock identity, bounded contention and no continuation after loss. |
| Preserve committed progress — transactional failure; later DB failure; reconciliation | 2.3, 3.2. Inject failures and uncertain outcomes, retain successful DB outcomes and block activation until verified. |
| Enforce database roles — distinct roles; out-of-scope write | 2.1, 3.3–3.4. Exercise DML and sequences using runtime credentials and deny DDL, history writes, role assumption and cross-owner access. |
| Verify schema during service startup — compatible; missing or incompatible | 3.1. Test read-only success and rejection before listeners and background work. |
| Gate local activation — fresh install; earlier run; one DB fails | 3.2–3.4. Exercise both startup paths and reject stale bundle/target evidence or partial results. |
| Protect local fixtures and reset targets — repeated seed; refused reset; stale related state | 3.2–3.4. Test explicit seed rerun, refusal of ineligible reset targets and isolated broker, cache, object and worker state. |
| Hold protected promotion — promote before gate | 4.2. Record effective restrictions and isolated negative checks across publication and node activation. |

Task 3.3 explicitly requires actual non-skipped PASS results for `TestProblemMutationPostgresConcurrency`, `TestTestcaseMutationPostgresConcurrency`, and `TestGetCurrentDetailPostgresSnapshots`. Task 3.4 covers the complete submission and rejudge path. Task 4.1 records verification evidence and documentation.

## 8. New findings

No new blocking, major or minor **specification** findings were identified. Reviewer independence remains the process limitation stated in §1.

## 9. Pending implementation acceptance checks

- Task 1.2 must prove actual Goose Provider and pgx same-session and lock-loss behavior on disposable PostgreSQL. Failure stops the task.
- Tasks 1.1–3.4 must establish the real legacy catalog, parity, target/role isolation, manifest and journal integrity, failure recovery, startup gating, fixtures, and behavior regressions.
- Task 4.2 must remain unchecked until the maintainer and Infra owner supply effective hold evidence and the negative rehearsal. If unavailable, the cutover remains on its feature branch.
- Before managed release, the gate and compatible DDL-free rollback require implementation and rehearsal. Existing unmanaged managed databases require a separate approved adoption plan.

## 10. Validation evidence

At the start of this review, `git status --short` returned no entries and `git rev-parse HEAD` returned `5c5db19aa554372807ca38d016342143857b8fc3`. `git diff --stat develop...HEAD` reported five added change files and 341 insertions. The GitHub PR changed-file list matched those five paths. GitHub's branch comparison showed the reviewed commit at the feature branch head and `develop` at `7d518406bcb5acdd2be1d22b74dd199e8d065d7f`.

- `openspec list --json` reported this single active change with 0 of 12 tasks complete.
- `openspec validate add-versioned-migrations --strict --no-interactive` passed.
- `openspec validate --all --strict --no-interactive` passed, with 10 items and 0 failures. Existing long-requirement informational messages were present.
- `git diff --check` passed before creating this review.
- OpenSpec 1.13.0 reports that the configured artifact rules must be arrays and ignores the scalar YAML rules. This review manually checked the first line, behavioral delta format, contract classification, task count and verification against [config.yaml](../../config.yaml). No configuration was changed.
- GitHub reported successful [OpenSpec run 45334409792](https://github.com/nvawntien/astracode/actions/runs/45334409792) and [CI run 45334409774](https://github.com/nvawntien/astracode/actions/runs/45334409774) for the reviewed commit. The CI PostgreSQL job succeeded against the existing constructor-driven fixtures. This is baseline evidence and does not test the planned Goose cutover.
- GitHub's review list returned no submitted PR reviews at inspection. PR #66 was open. The direct PR metadata command could not reach the GitHub API from the sandbox, so its draft state and base were not independently obtained from that command.

## 11. Final Gate 1 verdict

The round 2 specification assessment found no blocking or major defects and deferred the Gate 1 decision pending resolution of the reviewer independence limitation in §1. At that assessment, the implementation checklist stood at **0/12**.

### Maintainer exception — 2026-11-24

The project owner and repository maintainer **approved Gate 1 by explicit one-time exception** and authorized implementation for M1-02 `add-versioned-migrations` under PR #66. The approved specification is commit `5c5db19aa554372807ca38d016342143857b8fc3`. The maintainer accepted the technical assessment after two review rounds because all previous findings were addressed and strict OpenSpec validation and CI passed.

No independent GitHub approval has been obtained. The approval is the maintainer's exception to reviewer independence for this Gate 1 only. Gate 2, cross-agent implementation review, ADR-0006, NFR-D05 and all implementation acceptance criteria remain mandatory, including the task 1.2 feasibility proof and task 4.2 promotion hold evidence.

### Maintainer-directed scope correction — 2026-11-24

The maintainer confirmed that AstraCode has yet to deploy to production and
explicitly authorized revising and applying M1-02 in the existing PR #66.
ADR-0011 supersedes the local execution and protected cutover provisions of
ADR-0006 while retaining NFR-D05, database ownership and business baselines.
The previous promotion freeze is replaced by a future deployment prerequisite
to migrate successfully before application activation. The earlier review
above records the pre-correction scope. This entry records maintainer
authorization, with independent implementation review and Gate 2 still required.
