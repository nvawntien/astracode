---
change: add-versioned-migrations
gate: 2
round: 2
max_rounds: 3
reviewed_commit: bc9ae67110bddc16e296aa36571ed071a10231a9
risk: high
verify: pass
status: approved
---

# Gate 2 — M1-02 Add Versioned Migrations

## 1. Review scope

- Date: 2026-11-24.
- Repository: `nvawntien/astracode`; [PR #66](https://github.com/nvawntien/astracode/pull/66).
- Head: `feature/add-versioned-migrations` at `bc9ae67110bddc16e296aa36571ed071a10231a9`.
- Base: `develop` at `7d518406bcb5acdd2be1d22b74dd199e8d065d7f`.
- PR is open, ready (not draft), mergeable without a reported conflict, and not merged. Diff: 71 files, +2,218 / -188 lines, 12 commits.
- Reviewed against the revised proposal, design, delta spec, tasks, Gate 1 history, NFR-D05, ADR-0006 as partially superseded by ADR-0011, and the repository Gate 2 checklist.
- The reviewer inspected implementation and GitHub Actions evidence independently of the implementation author's report. This is a ChatGPT independent technical review, not a Codex self-review. In the final round the maintainer directed acceptance of this review. The alternate reviewer path is recorded transparently; no separate Claude Code review or submitted GitHub approval is asserted.

## 2. Scope and prior finding dispositions

| Finding / decision | Disposition | Evidence |
|---|---|---|
| Custom runner and excessive local orchestration | Resolved by approved scope correction | Official pinned Goose CLI; `infra/postgres/migrations.Dockerfile`, `infra/postgres/migrate.sh`, base `docker-compose.yml`. Custom runner, enrollment, journal, receipt, manifest and local overlay removed. |
| Old runner test coverage and receipt identity | Superseded, not waived as implementation defects | Removed mechanisms are no longer required under ADR-0011. Existing PostgreSQL suites now exercise the official CLI. |
| Independent service versions | Resolved | `pkg/schema/startup.go` declares AuthVersion, ProblemVersion and SubmissionVersion separately. Providers pass their own version. |
| Protected promotion freeze | Superseded by ADR-0011 | No existing production cutover. Successful migration of all three owning databases remains a prerequisite to first and subsequent deployments. Managed automation remains deferred. |
| ADR numbering | Resolved | `0011-local-goose-migrations.md`; ADR-0006 remains unchanged. ADR-0007 is reserved for M0-12. |
| Developer tooling | In scope by maintainer direction | Tasks 5.1 and 5.2 and design/proposal record the CI optimization and Makefile. |
| Stale agent guidance | Resolved | `AGENTS.md` documents Makefile, Goose, no runtime DDL, and direct-Go migration prerequisite. |

## 3. Implementation assessment

- Three initial SQL files and retained legacy schema captures remain unchanged from the earlier implementation. Goose v3.30.0 is pinned by OCI digest. The short shell entrypoint migrates Auth, Problem and Submission sequentially, fails on the first error, and relies on the per-database Goose ledger and transaction behavior.
- The migration SQL is copied into the migration image, so changed inputs change the build artifact. The three Compose applications depend on successful completion of `migrate` and use the normal startup path. The supported build/start and restart paths were rehearsed by the author.
- All eight constructor AutoMigrate calls and the explicit Attempt AlterColumn were removed. The Wire providers invoke read-only expected-version verification before service work. Existing persistence transaction logic was not changed in the reviewed repository patches. Direct-Go listeners bind to loopback when explicitly using local configuration.
- The Makefile is a thin wrapper around existing tools. `up` preserves the dev and worker profiles; `down` does not remove volumes; `restart` follows down then build/up rather than bypassing migration dependencies. The seed target obtains the local published PostgreSQL port and Problem password and calls the existing Go seed. No new deployment framework or destructive target is introduced.
- The production Compose overlay excludes the local migration job and credential defaults. It is deliberately not yet a migration-aware deployment pipeline. Local app roles also execute migrations; this is accepted for local development. Managed least-privilege separation, rollout, backup and compatible rollback remain first-deployment prerequisites, not claims of completed work.

## 4. CI optimization review

`.github/workflows/ci.yml:379-486` adds a classifier and preserves the existing six `Build image (...)` checks. Only the build steps are skipped on a positively identified documentation-only PR. Checkout/diff ambiguity falls back to full builds. PR classification uses the merge base and head, not the last commit. The NUL-delimited raw diff checks both paths of renames and rejects executable/symlink mode changes and workflow/action files. Main pushes and release `workflow_call` retain full image verification.

Independent reviewer shell rehearsal: the classifier script extracted from the reviewed workflow was run against disposable Git repositories. All 12 cases passed: documentation, OpenSpec Markdown, source, mixed, SQL, Makefile, workflow Markdown, source-to-Markdown rename, docs deletion, executable Markdown, symlink Markdown, and invalid comparison. This verifies the classifier logic, not a hosted documentation-only event.

The effective develop ruleset still requires the six named image checks; the matrix retains all names and reports success after an intentional step skip rather than suppressing the workflow. The current PR has code/config changes, so its image jobs must run. A docs-only commit appended to this mixed PR does not turn the entire PR into a documentation-only diff. A future genuinely docs-only PR is the hosted proof of the skip path. Existing PostgreSQL integration checks still build their small migration fixture image; the authorized optimization concerns the six application image builds. Release publication is unchanged.

## 5. Scenario coverage

| Delta scenario | Implementation / evidence |
|---|---|
| Initialize fresh databases | `infra/postgres/init.sql`, `migrate.sh`, three SQL files; author reports fresh PostgreSQL 15.6 parity and clean Compose startup. Hosted fixtures independently show Goose applying version 1. |
| Rerun an applied sequence | Goose history; author reports unchanged schema and full ledger fingerprints on repeat. |
| Advance one database | Per-service migration directories and expected-version constants; author reports test-only Auth 1 / Problem 2 / Submission 1. |
| Changed inputs and failed migration | Migration SQL in image, Compose success dependency; author reports changed job replacement, invalid migration rollback and refusal of candidate starts, including Makefile restart. |
| Missing or incompatible version | `pkg/schema/startup.go`, service providers; author reports missing ledger and newer-version startup refusal without DDL. |
| Fresh local development and testing | Compose and disposable PostgreSQL integration script; author reports no developer volume reset and Makefile down preserving volumes. Hosted fixtures pass all three suites. |

## 6. Verification

| Check | Result / provenance |
|---|---|
| Revised task list | 10/10 checked; `tasks.md` and `progress.md` inspected. |
| Local full verifier, quick verifier, strict change and all-spec validation, diff check | PASS as reported in `progress.md`; not independently rerun on the full checkout by this reviewer. |
| Local Compose migration, parity, seed, Makefile paths and regression smoke | PASS as reported by the implementation author; not independently rerun here. |
| Independent CI classifier shell rehearsal | PASS, 12/12 disposable Git cases. |
| [Hosted OpenSpec](https://github.com/nvawntien/astracode/actions/runs/45355173130) | Completed successfully on reviewed head. |
| [Hosted CI](https://github.com/nvawntien/astracode/actions/runs/45355173126) | Completed successfully on the reviewed head; all 18 jobs concluded success. Rechecked in the final review round. |
| [Hosted PostgreSQL integration job](https://github.com/nvawntien/astracode/actions/runs/45355173126/job/138311101209) | Completed successfully. Reviewer inspected logs: three Goose migrations to version 1, `TestProblemMutationPostgresConcurrency`, `TestTestcaseMutationPostgresConcurrency`, `TestGetCurrentDetailPostgresSnapshots` all PASS; no SKIP result lines. |
| Other hosted checks | All five Go checks, frontend, Envoy, Compose, deployment-script, benchmark, classifier, PostgreSQL integration and all six image build checks concluded success. |
| Submitted reviews / inline review threads | None at final review time. This document is not a submitted GitHub approval. |

## 7. Gate 2 checklist and documentation impact

- [x] Revised change scope, ADR traceability and implementation task evidence reviewed.
- [x] Every delta scenario has a corresponding recorded check (see section 5).
- [x] No business API, gRPC, Kafka, UI or sandbox feature change identified in the reviewed patches. No new user-facing incomplete behavior requiring a feature flag.
- [x] Documentation impact covered by ADR-0011, AGENTS.md, README, CONTRIBUTING, codebase development/data/architecture guides and deployment guide. Planned architecture documents need not be invented for this change.
- [x] No new paid resource. Local credential values are development-only; no real credential or private testcase data identified in the inspected changes.
- [x] Latest hosted CI fully green on the reviewed implementation commit.
- [x] Independent technical review completed; maintainer directed acceptance of this review in lieu of another review round. No Claude Code review is claimed.
- [x] Formal GitHub approval requirement acknowledged; submission of that approval remains a separate repository merge requirement and is not asserted by this review.

Compatibility: BREAKING operational startup prerequisite (migrate before application startup); NON-BREAKING business/API/event behavior. Existing legacy local databases require a new local project or an explicitly authorized disposable PostgreSQL volume reset. No automatic deletion or managed deployment performed.

## 8. Final finding dispositions

| ID | Severity | Disposition | Evidence / follow-up |
|---|---|---|---|
| G2-01 | Verification blocker | Resolved on reviewed implementation | Hosted CI run 45355173126 and OpenSpec run 45355173130 completed successfully. All 18 CI jobs succeeded. Recheck required checks after committing this review artifact. |
| G2-02 | Review process | Accepted by maintainer direction for this Gate 2 record | Independent ChatGPT technical assessment completed; the maintainer requested final acceptance based on this assessment. No separate Claude Code review was evidenced. Formal GitHub approval remains subject to the existing ruleset. |
| G2-03 | Minor (PR metadata) | Non-blocking | Prefer final title `feat(migrations): add versioned database migrations (M1-02)` and fill the PR template before merge. |

No additional blocking or major source-code defects were identified in the reviewed scope. The deferred managed deployment work is not an M1-02 merge blocker under the revised ADR. No new custom migration infrastructure, additional ADR or new OpenSpec change is requested.

## 9. Final verdict

**APPROVED — Gate 2 technical review and maintainer-directed acceptance for implementation commit `bc9ae67110bddc16e296aa36571ed071a10231a9`.**

The revised local-first M1-02 scope is satisfied. All 10 tasks are recorded complete, hosted CI and OpenSpec are green, and the three PostgreSQL integration suites passed without skips. The remaining managed deployment work is explicitly deferred under ADR-0011.

This approval record is ready to commit to the existing feature branch. It does not submit a GitHub review, waive branch protection, or certify any later code changes. Before merging, confirm that the final commit contains only review/documentation updates, that its required checks pass, and that the repository-required GitHub approval is present. Then merge into `develop` and archive through the normal OpenSpec workflow. No production deployment is authorized by this review.
