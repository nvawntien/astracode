# progress.md — baseline-realtime-updates

## Verified state

- Verification base is `docs/apply-m0-baselines` at `f89f8ec41ca2668955d835b2a3992b645c913c1c`. The final deltas incorporate review response `150e238` and the RT-16 correction below. The cited runtime source matches baseline revision `728aef2`.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` passed on the verification base. `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed with both final deltas in the same disposable checkout. The full run completed Go tests, vet and race tests, the website typecheck and build, Compose validation, and all eight OpenSpec changes. It ended with `All checks passed`.
- `openspec validate baseline-realtime-updates --strict` exited 0 with `Change 'baseline-realtime-updates' is valid`. `openspec validate --all --strict` exited 0 with 8 passed and 0 failed. `git diff --check` and `git diff --name-only` confirmed a whitespace-clean diff confined to the two authorized baselines.

## Task evidence

- Tasks 1.1 and 1.3–1.5 retain their ticket, post-commit publication, hub, and gateway evidence. The cited Submission, shared, and Envoy source matches the reviewed baseline. Production routing and replica settings remain the proposal's open question.
- Task 1.2, RT-16 source trace. `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go:71` subscribes and defers unsubscribe before snapshot and ownership checks. Snapshot failures return through the normal error handler before SSE setup. At line 97, the `http.Flusher` assertion checks Gin's wrapper. Gin v1.11.0's `ResponseWriter` embeds `http.Flusher` and its `Flush` asserts that interface on the underlying writer. An unsupported underlying writer therefore panics at the first flush after the retry directive is written. Deferred unsubscribe releases the registration. The router's recovery middleware handles that panic after the response has begun.
- An isolated `go run -overlay` probe drove the real handler, hub, Gin wrapper and recovery middleware with fixture ticket and snapshot ports. The non-flushing writer kept HTTP 200, wrote the retry directive, recovered from a flush panic, appended the generic internal error, and emitted no status event. Subscriber count was 1 at snapshot read and 0 afterward. The flushing control emitted its terminal status event and also released its subscription. RT-16 and its evidence row now describe that observed behavior.
- The existing `TestSubmissionEventsHandler*`, `TestSubmissionRepositoryGetStreamSnapshot*`, and `TestSubmissionEventHub*` checks passed. The focused run covered 14 tests, including snapshot-error handling, cancellation, and hub cleanup. The unsupported underlying writer case was reproduced by the isolated probe and is outside the checked-in handler tests.
- Tasks 2.2–2.3 passed. The independent audit counted 17 ADDED requirements, 40 WHEN/THEN scenarios and 17 matching Evidence rows. All nine review tasks retain their completed status.

## Historical verification

- The 39-scenario audit and the original `TMPDIR=/var/tmp` quick/full gates applied to `de60210`, before `150e238` added the RT-16 scenario. Those gates used the host Go 1.27 development build. The results above cover the current delta with Go 1.25.8.

## Broken or unverified

- The proposal Findings and deployment question remain in place. Transaction doubles do not establish real PostgreSQL commit-fault behavior. Cross-instance delivery, deployed gateway timing and configuration, and browser acceptance remain unverified. The website build reported existing lint warnings.

## Next action

- The documentation baseline is ready for a separate archive step.
