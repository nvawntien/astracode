# progress.md — baseline-code-run

## Verified state
- Branch / worktree: `feature/baseline-code-run`; changes confined to `openspec/changes/baseline-code-run/`.
- Inspected source revision: `728aef24cc0d6f624f79fd612265e904406d3d44`.
- Session-start `QUICK=1 scripts/verify.sh` → exit 0, `All checks passed`.
- Final `scripts/verify.sh` → exit 0, `All checks passed`: five Go modules' tests/vet/race tests, website typecheck/build, Compose, strict OpenSpec validation (1 passed, 0 failed).
- `openspec validate baseline-code-run --strict` → exit 0, `Change 'baseline-code-run' is valid`.
- Task 1.1 → R01–R03 source review; `TestGRPCProblemReaderMapsSuccess`, `TestGRPCProblemReaderMapsStatuses`, `TestRunCodeUseCaseValidation` included in passing package tests.
- Task 1.2 → R04–R07 validation branches reviewed; `TestRunCodeUseCaseTestcaseCount`, `TestRunCodeUseCasePreservesResultOrder` included in passing package tests.
- Task 2.1 → R08–R12 source review; `TestRunCodeUseCaseForwardsNormalizedProblemLimits`, `TestGoJudgeClientCompileErrorPreservesDiagnostics`, `TestGoJudgeClientCompileAndRunRequestsUseProtobufSemantics`, `TestGoJudgeClientPropagatesCancellationToUnaryRPC`, `TestGoJudgeClientRaisesOutputLimitForLargeExpectedOutput` included in passing package tests.
- Task 2.2 → R13–R16 reviewed; `TestRunCodeUseCaseUsesSharedExecutorAndMapsResult`, `TestOutputEqualNormalizesLineEndingsAndTrailingWhitespace`, `TestGoJudgeClientMapsExecutionResponses`, `TestMapRunCodeStatus` included in passing package tests.
- Task 2.3 → R17–R19 field/unit and constructor/call-chain review confirms synchronous feedback without persistence or package loading; diagnostic tests and `TestRunCodeUseCaseMapsRuntimeDiagnostics` included in passing package tests.
- Task 3.1 → four configuration/timeout Findings checked against providers and executor; two code-unanswerable questions explicitly retained, with no speculative requirement.
- Task 3.2 → inline `python3` artifact/evidence audit: PASS, 19 ADDED requirements, 19 matching Evidence rows, 37 WHEN/THEN scenarios, 21 existing cited test names, 16 existing Go evidence paths, only this change's paths modified; `git diff --check` → exit 0.
- Task 3.3 → final repository verification and strict validation commands above passed; no code or tests were changed.

## Last session
- Goal: record current `code-run` behaviour as an evidence-backed baseline; create planning artifacts only.
- Changed: `.openspec.yaml`, `proposal.md`, `specs/code-run/spec.md`, `design.md`, `tasks.md`, `progress.md` in this change.

## Broken or unverified
- No failing local checks. Verification used Go `1.27.0-X:nodwarf5`; the script warned that the expected version is `1.25.8`. Existing website lint warnings remain.
- No live Sandbox/deployment execution was verified; effective environment overrides, installed toolchains, and intended future configuration enforcement remain open questions.

## Next action
- Next task: reviewer review of this baseline and its Findings/Open questions; no implementation task remains in this change.
- Do not touch: code, `docs/`, main specs, other changes, production configuration; do not merge or archive.

## Notes for the reviewer
- Evidence distinguishes source review from existing test coverage; passing unit/race tests do not establish live execution or resource enforcement.
- OpenSpec artifact commands warned about existing non-array config rules; this change leaves configuration untouched and follows the requested artifact rules explicitly.
