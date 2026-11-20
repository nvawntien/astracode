---
change: baseline-submission
round: 1
max_rounds: 3
reviewed_commit: 0d3624c9ae1acb53bbde5be5c7a50c838d8ad269
status: approved
---

## Round 1 findings

`openspec validate baseline-submission --strict` passes (`Change 'baseline-submission' is valid`). `spec.md` contains 22 ADDED requirements with 58 WHEN/THEN scenarios, matching the 22 rows in `design.md`'s Evidence table. No requirement, endpoint, table, class, or file name leaks into `spec.md`; all requirement text is behavioral. No requirement overlaps `judging`, `realtime-updates`, `code-run`, `problem-catalog`, `content-moderation`, or `user-profile`/`statistics` per the boundary table in `docs/process/templates/baseline-prompt.md`.

Every requirement's Evidence row was opened and checked against the cited function, including: input-validation order in `create_submission.go` (problem ID → language/`IsExecutable` → source blank/size, all before `problemReader.GetProblem`); canonical-problem substitution (`problem.ID`/`problem.Title`, not the request's); cooldown scoping/no-release in `redis.go`; the single atomic transaction for Submission/Attempt/outbox in `create_submission.go` + `tx_manager.go` + `outbox.go`; owner-scoped/role-gated personal history in `list_my_submissions.go` vs. staff-wide history with `C`/`JAVASCRIPT` acceptance in `list_submissions.go`/`parseOptionalLanguage`; `created_at DESC, id DESC` ordering and non-nil-empty items in `submission.go`'s `List`; the single-statement `LEFT JOIN LATERAL` in `submission_detail.go` (`GetCurrentDetail`) vs. the three separate reads in `get_submission_detail.go` (admin); Rejudge's role/terminal/testcase-metadata checks plus the `GetByIDForUpdate` re-check inside the transaction in `rejudge_submission.go`; and `apply_judge_result.go`'s validation-before-guards ordering, stale/legacy/duplicate/terminal no-ops, replacement scoped to `attempt_id`, and the verdict-specific diagnostic normalization/truncation logic (regexes, `stripControlCharacters`, 4096-byte UTF-8-safe truncation with ellipsis). All matched the spec text and scenarios exactly, including edge cases (exactly-262144-byte source, independent cooldown pairs, legacy blank Attempt identity, System-Error-then-Accepted, reported-total vs. stored-count divergence).

Both Open Questions in `proposal.md` were independently re-confirmed from code (not just taken on faith): `rg -n 'MarkJudging'` and `rg -n 'GetBySubmissionID\('` across `services/submission/*.go` (excluding `_test.go`) show zero production callers for either — only test files reference them. Both questions remain correctly unanswered/bounded; no requirement in `spec.md` claims an intermediate Judging transition or historical-Attempt browsing, which is consistent with this.

All seven items under `proposal.md`'s "Findings" were spot-checked against the code and are accurate as stated: cooldown has no release path (`create_submission.go`, no `Release`/`Delete` call after `Acquire`); `IsTerminalStatus` includes `SYSTEM_ERROR` so it is never superseded (`apply_judge_result.go`); read paths (`list_my_submissions.go`, `list_submissions.go`, `get_submission.go`, `get_submission_detail.go`) never call `problemReader`; staff detail does three separate reads (Submission, Attempt, results) while personal detail is one statement; `mapTestCaseResults`/`validateDatasetChecksum` have no duplicate-index or total-vs-count cross-check and no positivity check on optional version/count/runtime/memory; testcase `Input`/`ExpectedOutput`/`ActualOutput` are persisted (`submission_result.go`) but omitted from both response DTOs; and `relay.go`'s `maxPublishRetries = 5` confirms the outbox-relay skip-after-five-failures claim. None of these are mis-stated as corrected behavior — the spec records them truthfully as current behavior.

No blocking findings.

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | proposal.md: "Open questions" (Q1, MarkJudging) | Confirmed by code: `Submission.MarkJudging` (`services/submission/internal/domain/entity/submission.go:118`) has no production caller anywhere under `services/submission/`; only `_test.go` files reference it. | Question is correctly bounded as unanswered by the code. No requirement should claim an intermediate Judging transition; none does. No change needed. |
| 1.2 | minor | proposal.md: "Open questions" (Q2, historical Attempt browsing) | Confirmed by code: `submissionResultRepository.GetBySubmissionID` (`services/submission/internal/adapter/outbound/persistence/postgres/submission_result.go:40`), which is not scoped to the current Attempt, has no production caller under `services/submission/`; only `_test.go` files call it. Production detail reads use the Attempt-scoped `GetBySubmissionIDAndAttemptID` instead. | Question is correctly bounded as unanswered by the code. No requirement should claim historical-Attempt browsing; none does. No change needed. |

## Round 1 author response

_Pending._
