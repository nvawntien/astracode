---
change: remove-contributor-role
gate: 2
round: 2
max_rounds: 3
reviewed_commit: 3650adf6abbd72d6f14b63908abd93d55fcc4de0
risk: high
verify: pass
status: changes-requested
---

## Reviewer independence

The fixes reviewed in this round were written by the same agent that performs this review. Workflow §8 says the agent that wrote the code does not review it. This review is therefore provisional until a second reviewer (the other tool or a human) confirms it. The findings below were checked against the code, not against the author's claims.

## Process findings to decide before merge

- **P-1 (important, human decision): the branch is already merged into `develop`.** `origin/develop` is `95a6e0c` ("Merge pull request #60 from nvawntien/feat/remove-contributor-role", author Ivan Nguyen, 02:00 +0700). Its second parent is `4c27cd8`. At that time this review's round 1 was `changes-requested`. Workflow §7.1 requires Gate 2 approval before merge. The two later commits (`49f9993`, `3650adf`) are not in `develop`. Options for the human reviewer: accept the merge as a documented exception, or revert it on `develop` and merge again after approval. This review did not change `develop`.
- **P-2 (important, human decision): tasks 4.3 and 4.4 were added to the Gate-1-approved `tasks.md`** after Gate 1 and after the round 1 review. Both are ticked. They are relevant to findings 2.2 and 2.5, so they are not scope creep, but they change the approved contract. Accept the amendment, or send it back to Gate 1.

## Verification
| Step | Result |
|---|---|
| `scripts/verify.sh` (full, at 3650adf) | pass: `==> All checks passed`, exit 0. All Go modules, 620 website tests in 24 files, Next.js build, Compose config, OpenSpec validate. Warning: local toolchain go1.26.5, CI pins 1.25.8. |
| `openspec validate remove-contributor-role --strict --no-interactive` | pass: `Change 'remove-contributor-role' is valid` |
| OpenSpec verify command | not available. `openspec --help` lists `list`, `validate`, `show` only. |
| PostgreSQL suites (Problem, Testcase, Submission detail) | Not run by verify.sh (no database). Run locally in the round 1 follow-up against PostgreSQL 15.6 with the current test code: Problem 6/6 PASS, Testcase 13/13 PASS, zero SKIP. The Submission detail suite was run only through the CI script simulation, which PASSED. |
| CI job `postgres-integration` on GitHub | **Not run.** The reviewer has no network access beyond verify.sh. The only evidence is the local simulation of the job's script (see F-1). |

## Diff reviewed

`origin/develop...HEAD` now contains only two files, because `develop` already includes the branch up to `4c27cd8`. The change set was therefore reviewed as `8dbcd7a..HEAD` (`8dbcd7a` is the first parent of the merge; 108 files, +3119 / −632). This includes the round 1 follow-up commits.

## Round 1 findings: disposition

| Finding | Status now | Evidence |
|---|---|---|
| 2.1 blocking (CM-14 hide restores author rights) | Resolved | `services/problem/internal/application/usecase/admin/problem/hide_restores_author_test.go`: `TestHidingPublishedContributionRestoresAuthorEditAndDelete` (author edit and delete denied while Published, allowed after hide, not found after delete) and `TestHidingAlreadyHiddenProblemSucceedsAndStaysHidden`. Both PASS in `go test ./internal/application/usecase/admin/problem` and in verify.sh. Testcase suite subtest `hiding a published problem restores author package management` (`testcase_mutation_integration_test.go:307`) PASS. |
| 2.2 major (CI does not run the suites) | Resolved in code, not verified on CI | `.github/workflows/ci.yml:59` job `postgres-integration`; `POSTGRES_CONTAINER` moved to step env in `e59f7d3` (`ci.yml:99`); suites at `ci.yml:118-120`; the script fails on `--- SKIP` or a missing PASS (`ci.yml:110`). See F-1. |
| 2.3 minor (CM-11 indirect) | Resolved | Testcase suite subtest `staff deletes a published problem and its package is kept` (`testcase_mutation_integration_test.go:349`) PASS: published package kept, metadata version and key unchanged, author edit after deletion returns not found. |
| 2.4 minor (website assertions) | Resolved | `website/tests/contributions.test.ts:124-130` (Draft/Published labels, Open link) and `:164-166` (Published detail, View problem, Back to contributions). vitest 11/11 PASS, typecheck exit 0. |
| 2.5 major (stale Contributor docs) | Resolved for every listed passage and the root `README.md` | Remaining mentions: `envoy/README.md:94` and `docs/codebase/ARCHITECTURE.md:75` state that the retired role is rejected (intentional). Product documents (`docs/product/*`, PRD/FRD/delivery plan, which change only via their own PR), `docs/process/glossary.md:106` (deprecation entry), and `docs/process/templates/baseline-prompt.md:43` (historical baseline prompt) are unchanged on purpose. |

## Round 2 findings
| # | Severity | Check | Location | Problem | Expected |
|---|---|---|---|---|---|
| F-1 | blocking | 4 | `openspec/changes/remove-contributor-role/tasks.md:26` (task 4.4); `.github/workflows/ci.yml:59-120` | Task 4.4 is ticked with the text "Run … in CI through a `postgres-integration` job". The evidence is a local simulation of the job's script against `postgres:15.6-alpine`, not a CI run. The task's stated verify clause (local script run plus YAML parse) is met, but the headline requirement is not demonstrated. The three suites have never executed on a GitHub runner, so `docker exec` on the hosted runner, the health check, and the `job.services.postgres.id` wiring are unproven. | Either (a) a green `postgres-integration` run on this branch's PR, with the three suites reported PASS and no SKIP, recorded in `progress.md`, or (b) amend task 4.4 to say the local simulation is the verification and record the CI run as a PR check. |
| F-2 | minor | 1 | `services/problem/internal/application/usecase/admin/testcase/delete_testcase.go:30-60`; `docs/codebase`/design Decision lifecycle step 3 | The design says deletion removes metadata first and that "physical cleanup happens independently". `DeleteTestCaseUseCase` no longer takes a storage port and never removes the object; the object is left for the manual reconciler. The spec's CM-20 "Storage removal fails" scenario is still satisfied, because the object stays eligible for a later cleanup and the metadata stays absent. Behaviour matches the spec, but it does not match the design text. | Update the design text in the next docs change, or add the physical cleanup in-line. Not blocking. |
| F-3 | minor | 7 | PR template doc-impact list (no PR exists yet) | The PR template's targets `docs/architecture/security.md`, `data.md` and `contracts/` do not exist. New attack surface: any authenticated User can upload testcase packages for their own drafts (`routes.json` `POST /api/v1/admin/problems/{problem_id}/testcases` now `User: owned hidden draft`). | When the PR is opened, state in the PR that these targets do not exist yet, and name the passages in `docs/codebase/*` and the new upload authorization in `routes.json` as the substitute. Not blocking. |

## Scenario coverage (changed or newly covered rows; the rest are unchanged from round 1)
| Requirement / scenario | Implemented at | Test |
|---|---|---|
| content-moderation CM-14 hide Published → author edits and manages package again | `usecase/admin/problem/hidden_problem.go:39-48`, `canMutateTestcase` in `upload_testcase.go` | `TestHidingPublishedContributionRestoresAuthorEditAndDelete`; testcase suite `hiding a published problem restores author package management` |
| CM-14 hide an already hidden problem → succeeds, remains hidden | `hidden_problem.go` | `TestHidingAlreadyHiddenProblemSucceedsAndStaysHidden` (moderator, admin) |
| CM-11 delete owned Draft → later edit reports missing | `delete_problem.go:38-46` | `TestHidingPublishedContributionRestoresAuthorEditAndDelete` (edit after delete → `ErrProblemNotFound`) |
| CM-11 staff deletes Published with package → package kept | `delete_problem.go`, soft delete | testcase suite `staff deletes a published problem and its package is kept` |
| CM-04 both states, Open and View problem actions | `contributions/page.tsx:86-107` | `contributions.test.ts:124-130` |
| CM-02 Published read-only, navigation back | `contributions/[id]/page.tsx:95-110` | `contributions.test.ts:164-166` |
| CM-20 deletion outcomes | `delete_testcase.go`, `problem.go` `WithLockedProblem`, `reconcile_objects.go` | testcase suite (13 subtests, all PASS locally); CI job pending (F-1) |

All other rows from the round 1 coverage table are unchanged and still cite the same tests.

## Checks with no findings (round 2)
- **1 (spec behaviour):** no code changed for behaviour since round 1. The round 2 commits change tests, CI, docs and the root README only (`git diff --stat 8dbcd7a..HEAD`).
- **3 (scope):** every changed file maps to a task or a finding. `README.md` at the root is covered by 2.5 and is listed in the response.
- **5 (hard constraints):** no change to the sandbox, outbox, AttemptID, proto or secrets. The CI job uses throwaway fixture credentials (`fixture_admin`, `problem_fixture`, `detail_fixture`), which are test-only and already present in the test sources.
- **6 (security):** unchanged from round 1. Every write path rechecks role, ownership and visibility under the Problem row lock.
- **8 (contracts):** unchanged. `routes.json` matches the router.
- **11 (tests):** the new tests assert the THEN outcomes. The PostgreSQL subtests use real barriers and lock probes. The stateful fake in `hide_restores_author_test.go` reflects committed writes, so it can fail if hide does not restore rights.
- **12 (risk):** stays `high` (authorization, BREAKING role contracts, testcase upload by Users, content-moderation hotspot).

## Author response after round 2

- **P-1 (merged before approval): accepted as an exception by the project owner.** The branch reached `develop` through PR #60 at `4c27cd8`, whose CI run was green.
- **F-1 (task 4.4 "run in CI"): resolved with GitHub evidence.** Run `44938316772` (commit `4c27cd8`), job `PostgreSQL integration suites` (job `136949758744`), concluded **success**. Its log shows `TestProblemMutationPostgresConcurrency` 6/6 PASS, `TestTestcaseMutationPostgresConcurrency` 13 subtests PASS, and `TestGetCurrentDetailPostgresSnapshots` PASS. The log has no `--- SKIP: ` result lines; the single textual match is the script's own `grep` line. The earlier run `44937723727` (commit `e59f7d3`) failed only at `Frontend checks` (6 lint warnings), which `4c27cd8` fixed.
- **Note on CI triggers:** `ci.yml` runs on `pull_request` and on pushes to `main` only. PR #60 is merged, and no PR is open for this branch. Commits `49f9993` and `3650adf` have therefore not been checked by CI.
- **P-2 (tasks 4.3 and 4.4 added after Gate 1):** open, waiting for the project owner's decision.
- **F-2 (design wording, minor):** resolved. The project owner approved the wording change in `design.md`, delete step 3: the delete request does not remove the object, and the object stays eligible for the manual reconciler. Code unchanged, because inline deletion would break the retention window. Included in PR #PR1.
- **F-3 (PR doc impact, minor):** resolved in the PR bodies. `docs/architecture/contracts/` exists but is empty. The other planned documents (`application.md`, `data.md`, `security.md`, `deployment.md`) do not exist and were not created.
- **ADRs:** ADR-0001 to ADR-0003 are added in a separate PR from `develop`, with status Accepted at the project owner's instruction. The reviewer must confirm before merge (workflow §10).

## Summary for the human reviewer
All five round 1 findings are fixed in code, and the new tests assert the spec outcomes; verify and strict OpenSpec validation pass. Status is `changes-requested` for one blocking item: task 4.4 says "run in CI", but the job has never run on GitHub (F-1). Two process decisions need you before merge: this branch is already in `develop` via PR #60 without Gate 2 approval (P-1), and tasks 4.3 and 4.4 changed the Gate-1-approved task list (P-2). Because the author wrote these fixes, have a second reviewer confirm this round. Look first at `hide_restores_author_test.go` and `ci.yml:59-120`.
