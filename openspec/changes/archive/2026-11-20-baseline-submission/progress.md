# progress.md - baseline-submission

## Verified state

- Branch `docs/apply-m0-baselines` at verification input `271acc2`. `git diff --exit-code 728aef2 HEAD -- services/submission pkg workers/judge envoy` confirmed that the relevant runtime source matches the inspected baseline revision.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` passed in a disposable checkout before the documentation update. `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed with the updated artifacts, including Go tests, vet, and race tests, the website typecheck and build, Compose config, and strict validation of all eight OpenSpec changes.
- Submission `go test -count=1 -v ./...` passed with Go 1.25.8. It reported `SKIP` for the opt-in `TestRedisSubmissionCooldownIntegration` and `TestGetCurrentDetailPostgresSnapshots`. The review run left their opt-in environment variables unset.
- `openspec validate baseline-submission --strict` exited 0 with `Change 'baseline-submission' is valid`. The structure audit found 22 ADDED requirements, 58 WHEN/THEN scenarios, 22 matching Evidence rows, and 23 existing source paths. OpenSpec apply reports `all_done` with 8 of 8 tasks complete. The scoped `git diff --check` passed.

## Last session

- Completed task 1.5 by verifying result application and clarifying requirement 22 in the Submission delta spec and evidence table.

## Task evidence

- Task 1.1. Creation validates before problem lookup, scopes cooldown to the canonical problem, and writes Submission, Attempt and outbox in one transaction. `wire_gen.go` supplies the Attempt repository. `TestCreateSubmission_Validation`, `TestCreateSubmissionCooldownIsScopedToUserAndCanonicalProblem` and `TestRejudgeAdminSubmissionCreatesNewAttemptAndJob` passed.
- Task 1.2. Personal reads always apply the owner filter and executable-language check. Staff reads apply optional filters and retain legacy C/JavaScript values. Both paginate with creation-time and ID ordering and project summary fields. `TestListMySubmissionsSupportedRolesRemainOwnerScoped`, `TestListAdminSubmissionsFiltersAndPagination` and `TestSubmissionRepositoryListAppliesFiltersAndPagination` passed.
- Task 1.3. Personal detail reads the selected Attempt and counts in one statement. Staff detail reads Submission, Attempt and results separately and maps only testcase summaries with nullable provenance. `TestGetSubmissionAccessMatrix`, `TestGetCurrentDetailSingleStatement` and `TestGetAdminSubmissionDetailEarlyTerminationDoesNotInventTotal` passed.
- Task 1.4. Rejudge checks staff role, terminal status and dataset metadata, then rechecks status under a row lock before resetting the Submission and writing the new Attempt and outbox. `TestRejudgeAdminSubmissionConcurrentRequestsCreateOneAttemptAndOutboxJob` and the Attempt-insert, Submission-update and outbox-failure rollback tests passed.
- Task 1.5. Source review confirmed validation before result guards, exact Attempt matching, first-terminal-wins, and atomic replacement and provenance for the current Attempt. `TestApplyJudgeResultStaleOrLegacyAttemptIsAckNoop`, `TestApplyJudgeResultDuplicateMatchingResultIsAckNoopAfterTerminalCommit`, `TestApplyJudgeResultPersistsCurrentAttemptProvenance`, and `TestApplyJudgeResultMapsOutputFieldsByVerdict` passed in the current Go 1.25.8 Submission suite. Requirement 22 now records the ASCII filter and post-truncation trim verified in `stripControlCharacters` and `publicErrorMessage`.
- Task 2.1. The production `MarkJudging|StatusJudging` search found a status declaration, parser case and method definition, with no transition caller. Searches for `GetCurrentDetail`, `GetBySubmissionIDAndAttemptID` and `GetBySubmissionID` found current-Attempt detail callers and an unused unscoped repository method. The questions about external behavior remain bounded in the proposal.
- Task 2.2. Checked the seven Findings against creation, query, result, relay and role source. The structure and scope audit above confirms a documentation-only change confined to this baseline.
- Task 3.1. Strict validation passed as recorded above. The test scope and integration skips are recorded separately from the source evidence.

## Broken or unverified

- The website build reported existing lint warnings. OpenSpec apply ignores the existing artifact rules because their values are strings.
- Rejudge concurrency and rollback tests use fixtures. Real PostgreSQL snapshots, Redis cooldown integration, deployed behavior and external historical-Attempt consumers remain outside this review's runtime evidence.

## Archive

- Archived on 2026-11-20 after matching the Purpose and all 22 requirements against the delta specs for `submission`.
- `openspec validate --all --strict --no-interactive` passed (9 items, zero failures).
