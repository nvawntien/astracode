## 1. Review requirement evidence

- [x] 1.1 Verify creation and Attempt evidence for requirements 1–6 against the source functions in `design.md`; cross-check `TestCreateSubmission_Validation`, `TestCreateSubmissionCooldownIsScopedToUserAndCanonicalProblem`, and `TestRejudgeAdminSubmissionCreatesNewAttemptAndJob`, and confirm the composed service supplies the Attempt repository.
- [x] 1.2 Verify personal/staff history evidence for requirements 7–11, including owner scope, legacy language differences, pagination, and omitted sensitive fields; cross-check `TestListMySubmissionsSupportedRolesRemainOwnerScoped`, `TestListAdminSubmissionsFiltersAndPagination`, and `TestSubmissionRepositoryListAppliesFiltersAndPagination`.
- [x] 1.3 Verify detail evidence for requirements 12–14, including current-Attempt summaries, missing provenance, private testcase omission, and the different snapshot guarantees; cross-check `TestGetSubmissionAccessMatrix`, `TestGetCurrentDetailSingleStatement`, and `TestGetAdminSubmissionDetailEarlyTerminationDoesNotInventTotal`.
- [x] 1.4 Verify Rejudge evidence for requirements 15–16, including role/state/dataset checks, the concurrent-state guard, reset, and atomic durable intake; cross-check `TestRejudgeAdminSubmissionConcurrentRequestsCreateOneAttemptAndOutboxJob` and the three Rejudge rollback tests named in `design.md`.
- [x] 1.5 Verify result evidence for requirements 17–22, including validation before guards, stale/duplicate no-ops, first terminal result, provenance, replacement scope, and diagnostics; cross-check `TestApplyJudgeResultStaleOrLegacyAttemptIsAckNoop`, `TestApplyJudgeResultDuplicateMatchingResultIsAckNoopAfterTerminalCommit`, `TestApplyJudgeResultPersistsCurrentAttemptProvenance`, and `TestApplyJudgeResultMapsOutputFieldsByVerdict`.

## 2. Review questions and baseline boundaries

- [x] 2.1 Answer the bounded Open questions in `proposal.md` from code if additional evidence is available; verify `rg -n 'MarkJudging|StatusJudging' services/submission --glob '*.go' --glob '!**/*_test.go'` and the current-detail handlers, explicitly retaining unanswered questions without adding unsupported requirements.
- [x] 2.2 Review all Findings and document impact; confirm 22 ADDED requirements each have SHALL, WHEN/THEN scenarios, and one Evidence row, with no requirement about `judging` or `realtime-updates`, no implementation tasks, and no changed paths outside `openspec/changes/baseline-submission/` using `git status --short` and the staged-file inventory before commit.

## 3. Validate the documentation

- [x] 3.1 Run `openspec validate baseline-submission --strict` and record its output in `progress.md`; review the local verification output and report opt-in integration skips and toolchain limitations without claiming production acceptance.
