# progress.md — baseline-realtime-updates

## Verified state
- Branch / worktree: `feature/baseline-realtime-updates`; all new repository files are confined to this change directory; no implementation changes.
- Baseline: `TMPDIR=/var/tmp QUICK=1 scripts/verify.sh` in `/var/tmp/astracode-realtime-verify.W4a6Eq` → exit 0, `All checks passed`.
- Final verification: `TMPDIR=/var/tmp scripts/verify.sh` in the same isolated checkout with this change copied in → exit 0, `All checks passed`; Go test/vet/race for all five modules, website typecheck/build, Compose config, strict OpenSpec validation. Log: `/var/tmp/astracode-realtime-full-verify.log`.
- Strict change validation: `openspec validate baseline-realtime-updates --strict` → exit 0, `Change 'baseline-realtime-updates' is valid`.
- Task 1.1 → source review plus required verify's `go test ./...` includes ticket use-case, signer and handler tests; ownership/invalid-ticket/expiry cases PASS. Reuse, session revocation and absent/mismatched origin are source-reviewed, not dedicated automated scenarios.
- Task 1.2 → full handler/snapshot/event source review; existing `TestSubmissionEventsHandler*` and `TestSubmissionRepositoryGetStreamSnapshot*` tests PASS in verify. Replay absence, nonterminal live naming and write-error branches are source-reviewed.
- Task 1.3 → `TestApplyJudgeResultDoesNotPublishOnTransactionCommitFailure`, matching-result, stale-result, duplicate and repository-error tests PASS in verify. Concrete transaction manager reviewed; production `rg` search finds the only hub publish at `apply_judge_result.go:130`; creation/rejudge publish jobs, not stream events.
- Task 1.4 → `TestSubmissionEventHubMultipleSubscribers`, `TestSubmissionEventHubSlowSubscriberGetsLatest`, cleanup and concurrent-publish tests PASS in verify; `InitializeApp` reviewed for shared process-local hub.
- Task 1.5 → read-only YAML/JSON assertions PASS for both generated gateway SSE routes: timeout `0s`, idle timeout `75s`, no per-route JWT; ticket inventory entry has authentication enabled. Generator and query-preserving Lua reviewed; no gateway files changed.
- Task 2.1 → Findings checked against code; deployed replica routing and configuration remain explicitly unconfirmed in proposal Open questions. No requirement depends on an answer about deployment.
- Task 2.2 → format/evidence/scope audit PASS: 17 ADDED requirements, 39 WHEN/THEN scenarios, 17 matching Evidence rows with existing source paths, no implementation references in the delta, and only this change directory modified. Glossary discrepancy and document impact recorded.
- Task 2.3 → strict validation and final full verification PASS as above.

## Last session
- Goal: record current `realtime-updates` behavior for M0-08 and validate the documentation baseline.
- Changed: `.openspec.yaml`, `proposal.md`, `design.md`, `specs/realtime-updates/spec.md`, `tasks.md`, and this progress file, all within this change.

## Broken or unverified
- No verification failure remains. Host Go is `go1.27.0-X:nodwarf5`, so verify warns that it differs from the expected Go 1.25.8; the website build also reports existing lint warnings. No out-of-scope corrections made.
- Source and existing tests do not establish real PostgreSQL commit-fault behavior, cross-instance delivery, deployed configuration, elapsed-time gateway behavior, or browser acceptance. Result-to-stream tests use persistence/transaction doubles.

## Next action
- Next task: reviewer assessment of the baseline and Findings; no implementation, merge or archive is authorized by this change.
- Do not touch: code, main specs, other changes, architecture documents, secrets, or production configuration.

## Notes for the reviewer
- Every task is review/verification only. Proposed behavior improvements are excluded; current ticket, Attempt, publication and delivery limits are preserved.
- Verification ran in an isolated clone so env copies, dependency installation and build output did not modify the original checkout outside this change.
