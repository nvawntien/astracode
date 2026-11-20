## Why

M0-08 needs a reviewable baseline of the live Submission status stream before later changes can be compared with it. This change records behavior confirmed in the current code; it introduces no runtime behavior.

## What Changes

- Add the `realtime-updates` delta spec using ADDED requirements only, covering ticket eligibility, stream admission, snapshot and live event delivery, publication after commit, and delivery limitations.
- Add a requirement-by-requirement evidence table and review-only tasks, with verification evidence in `progress.md`.
- Preserve observed limitations and likely bugs as findings instead of describing desired fixes as current behavior.

## Capabilities

### New Capabilities

- `realtime-updates`: Baseline documentation of who can subscribe to a Submission's live status stream, what the stream sends, and when committed result notifications are published. The capability is new to OpenSpec; its implementation already exists.

### Modified Capabilities

None. Every baseline requirement is ADDED.

## Scope

Ticket issuance and validation, ownership at connection time, origin checks, initial snapshots, event metadata and names, Attempt filtering, terminal closure, heartbeats, reconnect behavior, local fan-out, slow subscribers, and the boundary between committing a result and publishing a notification.

## Out of scope

- Verdict computation and the Submission lifecycle rules: reference `judging` and `submission` only.
- Code changes, bug fixes, new tests, new delivery guarantees, contract changes, architecture-document edits, and changes to other baselines.
- Merge or archive of this change.

## Impact

Documentation only, exclusively under `openspec/changes/baseline-realtime-updates/`. The sources inspected are Submission's SSE, ticket, result-notification and composition code; Envoy routing/generation; the four requested codebase documents; and the glossary. No module-specific `AGENTS.md` exists under Submission or Envoy. No existing capability specs were found by `openspec list --specs`.

Contract classification: **NON-BREAKING** documentation baseline; no HTTP, gRPC, Kafka, gateway, persistence, or dependency changes. No feature, NFR, or ADR identifier was supplied for this baseline, so none is invented.

## Findings

1. **No intermediate status publisher.** `applyJudgeResultUseCase.Execute` is the only production caller of the status event hub's `Publish`. It accepts terminal results; creation and rejudge do not publish stream events. The handler supports `submission.updated`, but that does not establish a current producer of intermediate progress. Evidence: `services/submission/internal/application/usecase/result/apply_judge_result.go` (`Execute`); `services/submission/internal/application/usecase/user/create_submission.go` (`Execute`); `services/submission/internal/application/usecase/admin/rejudge_submission.go` (`Execute`); `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` (`Handle`).
2. **An existing stream does not follow a rejudge.** `SubmissionEventsHandler.Handle` captures the snapshot's Attempt once and ignores events for a different Attempt. It neither refreshes the snapshot nor switches Attempts. If the old stream is still open when a rejudge changes the Attempt, for example after a missed completion, it can keep sending heartbeats without delivering the new Attempt's completion. Evidence: the same handler's `currentAttemptID` comparison and loop.
3. **Delivery is best effort within one instance.** The event hub is an in-memory fan-out shared only inside one Submission process. There is no status-event replay or durable publish step after a result commits. A notification published on another instance, or a process failure between commit and publish, can leave an existing stream unaware until a reconnect reads a new snapshot. Evidence: `services/submission/internal/adapter/outbound/stream/event_hub.go` (`Publish`, `Subscribe`); `services/submission/cmd/server/wire_gen.go` (`InitializeApp`); result `Execute` above.
4. **Authorization is checked at admission.** Tickets are reusable bearer credentials until expiry. The stream does not recheck the login session or ticket expiry after admission, and the ticket verifier does not consult session revocation. This baseline records that limit without asserting immediate stream revocation. Evidence: `services/submission/internal/adapter/outbound/stream/hmac_ticket.go` (`Issue`, `Verify`); stream `Handle`; `services/submission/internal/adapter/inbound/http/router.go` (`SetupRoutes`).
5. **Glossary/code mismatch.** The glossary calls Contributor deprecated/removed, but ticket issuance still accepts that legacy role alongside User, Moderator, and Admin. The baseline preserves the observed allowlist. Evidence: `docs/process/glossary.md`; `services/submission/internal/application/usecase/user/issue_stream_ticket.go` (`Execute`).

## Open questions

- Which replica topology, routing affinity, and SSE configuration overrides are actually used in a running deployment? Source inspection confirms the checked-in implementation and defaults, not deployed settings or cross-instance delivery. No deployment-wide delivery or latency guarantee is specified.
- No further functional ambiguity remains for the requirements recorded here. The findings above are confirmed limitations, not unresolved implementation tasks or authorization to fix them.
