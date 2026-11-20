# progress.md — baseline-judging

## Verified state

- Verification base is `docs/apply-m0-baselines` at `f89f8ec41ca2668955d835b2a3992b645c913c1c`. The final deltas incorporate review response `9cc7b69` and the J19 clarification below. The cited runtime source matches baseline revision `728aef2`.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` passed on the verification base. `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed with both final deltas in the same disposable checkout. The full run completed Go tests, vet and race tests, the website typecheck and build, Compose validation, and all eight OpenSpec changes. It ended with `All checks passed`.
- `openspec validate baseline-judging --strict` exited 0 with `Change 'baseline-judging' is valid`. `openspec validate --all --strict` exited 0 with 8 passed and 0 failed. `git diff --check` and `git diff --name-only` confirmed a whitespace-clean diff confined to the two authorized baselines.

## Task evidence

- Tasks 1.1–1.4 and 2.1 retain their reviewed evidence. The worker, Sandbox build and shared code match the inspected baseline. The proposal retains its seven Findings and two open questions.
- Task 1.5, J19 source trace. In `workers/judge/internal/adapter/outbound/execute/go_judge_client.go:148`, `Execute` retains the first failure and derives the result-level message via `mapTestCaseResult` and `errorMessageForTestCase`. In `diagnostics.go:149`, `runtimeErrorMessage` prefers a nonempty sanitized runtime diagnostic derived from stderr, then uses a stderr headline. `publicErrorMessage` removes recognized path prefixes, invalid UTF-8 and ASCII controls except newline, carriage return and tab. It bounds the text to a UTF-8-safe prefix of up to 4,096 bytes plus an ellipsis when truncated. J19 now says ASCII controls to match this code.
- `ProcessJudgeJobUseCase.Execute` forwards the result with the original Submission and Attempt. In `workers/judge/internal/adapter/outbound/judge/kafka_result_publisher.go:36`, `PublishResult` copies the top-level message and maps testcase items to index, Verdict and available metrics.
- The focused tests `TestRuntimeErrorMessagePrefersDiagnosticAndSanitizes`, `TestRuntimeErrorMessageFallsBackToHeadlineAndTruncates`, `TestKafkaResultPublisherIncludesSanitizedErrorMessageAndAttemptID`, `TestPublishResultDoesNotIncludeHiddenTestcaseData`, and `TestProcessJudgeJobUsesOfficialLoaderSharedExecutorAndSanitizesResult` passed. The helper tests cover diagnostic preference, NUL removal, fallback and truncation. The publisher test supplies the message explicitly and verifies the serialized result. Source review connects these checks to the official first-failure path and establishes the invalid UTF-8 and ASCII ranges.
- Tasks 2.2–2.3 passed. The independent audit counted 24 ADDED requirements, 56 WHEN/THEN scenarios and 24 matching Evidence rows. All eight review tasks retain their completed status.

## Historical verification

- The 55-scenario count and original strict validation came from `f336dc0`, before `9cc7b69` added the J19 scenario. The original round did source review and skipped the broad repository gate. The results above cover the current delta.

## Broken or unverified

- The tests use fixtures and doubles. Live Sandbox syscall and network enforcement, live Kafka delivery and external DLT recovery, and deployed C++ and Python versions remain unverified. The website build reported existing lint warnings.

## Next action

- The documentation baseline is ready for a separate archive step.
