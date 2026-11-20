# progress.md — baseline-submission

## Verified state

- Branch `docs/apply-m0-baselines` at verification input `670fbebba7e60b8a815913bc9eb65ae29054fbb0`. The relevant Submission, shared, gateway and worker source matches the original inspected revision `728aef2`.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` and `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed in a disposable checkout. The full gate completed Go tests, vet and race tests, the website typecheck and build, Compose config and strict validation of all eight changes.
- Submission `go test -count=1 -v ./...` passed with Go 1.25.8. It reported `SKIP` for the opt-in `TestRedisSubmissionCooldownIntegration` and `TestGetCurrentDetailPostgresSnapshots`. The review run left their opt-in environment variables unset.
- `openspec validate baseline-submission --strict` exited 0 with `Change 'baseline-submission' is valid`. The structure audit found 22 ADDED requirements, 58 WHEN/THEN scenarios, 22 matching Evidence rows and 23 existing source paths. `git diff --check` passed. This session's scoped diff contains only this progress record and `tasks.md`.

## Task evidence

- Task 1.1. Creation validates before problem lookup, scopes cooldown to the canonical problem, and writes Submission, Attempt and outbox in one transaction. `wire_gen.go` supplies the Attempt repository. `TestCreateSubmission_Validation`, `TestCreateSubmissionCooldownIsScopedToUserAndCanonicalProblem` and `TestRejudgeAdminSubmissionCreatesNewAttemptAndJob` passed.
- Task 1.2. Personal reads always apply the owner filter and executable-language check. Staff reads apply optional filters and retain legacy C/JavaScript values. Both paginate with creation-time and ID ordering and project summary fields. `TestListMySubmissionsSupportedRolesRemainOwnerScoped`, `TestListAdminSubmissionsFiltersAndPagination` and `TestSubmissionRepositoryListAppliesFiltersAndPagination` passed.
- Task 1.3. Personal detail reads the selected Attempt and counts in one statement. Staff detail reads Submission, Attempt and results separately and maps only testcase summaries with nullable provenance. `TestGetSubmissionAccessMatrix`, `TestGetCurrentDetailSingleStatement` and `TestGetAdminSubmissionDetailEarlyTerminationDoesNotInventTotal` passed.
- Task 1.4. Rejudge checks staff role, terminal status and dataset metadata, then rechecks status under a row lock before resetting the Submission and writing the new Attempt and outbox. `TestRejudgeAdminSubmissionConcurrentRequestsCreateOneAttemptAndOutboxJob` and the Attempt-insert, Submission-update and outbox-failure rollback tests passed.
- Task 1.5 remains open. Source review confirmed validation before result guards, exact Attempt matching, first-terminal-wins and current-Attempt persistence. The four named result tests passed. Requirement 22 describes removal of control characters generally, while `services/submission/internal/application/usecase/result/apply_judge_result.go:208` removes ASCII C0 and DEL and preserves newline, carriage return and tab. A spec clarification needs approval before the result review can close.
- Task 2.1. The production `MarkJudging|StatusJudging` search found a status declaration, parser case and method definition, with no transition caller. Searches for `GetCurrentDetail`, `GetBySubmissionIDAndAttemptID` and `GetBySubmissionID` found current-Attempt detail callers and an unused unscoped repository method. The questions about external behavior remain bounded in the proposal.
- Task 2.2. Checked the seven Findings against creation, query, result, relay and role source. The structure and scope audit above confirms a documentation-only change confined to this baseline.
- Task 3.1. Strict validation passed as recorded above. The test scope and integration skips are recorded separately from the source evidence.

## Broken or unverified

- The original gate in `0d3624c` used the host Go 1.27 development build. This review used Go 1.25.8. Existing website lint warnings remain.
- Rejudge concurrency and rollback tests use fixtures. Real PostgreSQL snapshots, Redis cooldown integration, deployed behavior and external historical-Attempt consumers remain outside this review's runtime evidence.

## Next action

- Seven of eight review tasks are complete. Task 1.5 awaits a decision on the requirement 22 clarification.
