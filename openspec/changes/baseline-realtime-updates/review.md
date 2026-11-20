---
change: baseline-realtime-updates
round: 1
max_rounds: 3
reviewed_commit: de602109f6248323067e4822e20406589ded44cf
status: approved
---

## Round 1 findings

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | specs/realtime-updates/spec.md: "RT-16 Failure handling and subscription cleanup" | The handler also rejects the connection with `domain.ErrSubmissionStreamUnsupported` when the response writer does not implement `http.Flusher`, after the ownership check but before any data is sent (`services/submission/internal/adapter/inbound/http/handler/user/submission_events.go:97-101`). The spec's "Initial read fails" scenario only covers the snapshot-read failure case. | Could add a scenario (or fold into the existing one) noting that admission also fails, without sending status data, if the response does not support flushing. Not blocking: it is an edge-case rejection path that behaves the same as the already-specified "no data sent, subscription released" outcome. |

No blocking findings. Validation and evidence checks performed this round:

- `openspec validate baseline-realtime-updates --strict` → `Change 'baseline-realtime-updates' is valid`.
- All 17 requirements (RT-01–RT-17) have a corresponding Evidence table row in `design.md`; every cited file, function, and test name was confirmed to exist (`services/submission/internal/...`, `envoy/generate.py`, `envoy/routes.json`).
- Read and traced the cited code for each requirement against its SHALL statements and WHEN/THEN scenarios:
  - RT-01/RT-02: `issue_stream_ticket.go` (owner-only, role allowlist, not-found on missing/other-owner Submission) and `hmac_ticket.go` (`Issue`/`Verify`: purpose, required claims, nonpositive Submission ID, `IssuedAt.Before(ExpiresAt)`, expiry check using `!now.Before(ExpiresAt)` — rejects "at or after" expiry as specified) match exactly.
  - RT-03–RT-09, RT-12, RT-15, RT-16: `submission_events.go` `Handle` — ticket verify → Submission-ID match → subscribe → snapshot read → owner match → SSE headers/retry → snapshot event naming (`submission.snapshot`/`submission.completed`) → terminal close → heartbeat loop → live-event Attempt/Submission filter → `submission.updated`/`submission.completed` naming — all match the spec precisely, including CORS behavior in `applyCORS` (absent origin allowed, mismatched nonempty origin forbidden, matching origin sets `Access-Control-Allow-Origin`/`Vary: Origin`). No `Last-Event-ID`/replay handling exists in the handler, confirming RT-12's no-replay claim.
  - RT-10/RT-11: `apply_judge_result.go` `Execute` — event is only captured inside the transaction after all repository writes succeed and is only published after `ExecuteInTx` returns successfully; early returns for empty/mismatched Attempt and already-terminal status leave `eventToPublish` nil. `rg`-equivalent search found the hub's `Publish` called only from this one use case (`apply_judge_result.go:130`); `create_submission.go` and `rejudge_submission.go` contain no event-hub reference.
  - RT-13/RT-14: `event_hub.go` — subscribers keyed/fanned-out per Submission ID within one process map; `wire_gen.go` constructs one `SubmissionEventHub` shared by the handler and the result use case, confirming instance-local-only delivery; `trySendLatest`'s drain-then-replace logic matches the one-pending-event/non-blocking requirement.
  - RT-17: `envoy/generate.py` adds the `/events/submissions/{submission_id}` route outside the per-item authorization loop with `timeout: "0s"`, `idle_timeout: "75s"`, and no JWT/authorization rule attached; `routes.json` keeps the ticket-issuance endpoint authenticated. Matches.
- Config defaults cited only in `design.md` (not `spec.md`, correctly) verified against `services/submission/config/config.yaml` (`ticket_ttl: 2m`, `heartbeat_interval: 15s`, `allowed_origin: http://localhost:3000`) and `ProvideSSEConfig`'s validation (including the `HeartbeatInterval >= 75s` guard tying it to the gateway idle timeout).
- `spec.md` contains no endpoints, tables, class, or file names; all requirements are phrased behaviorally and reference `submission`/`judging` by capability name only, consistent with the boundary table (M0-08 owns "who can subscribe, which events are pushed, when"; verdict computation and Submission lifecycle correctly deferred to `judging`/`submission`).
- Findings 1–5 in `proposal.md` were each checked against code and are accurate: no intermediate-status publisher (confirmed above), stream does not follow a rejudge (`currentAttemptID` captured once, never refreshed — confirmed in `Handle`), in-memory single-instance fan-out with no durable outbox for SSE (confirmed above), reusable tickets with no session-revocation check (confirmed: no `session`/`revoc` references anywhere in the ticket/stream code), and the glossary/code mismatch on the deprecated Contributor role (`docs/process/glossary.md:106` calls it deprecated/removed; `issue_stream_ticket.go:44` still accepts `rbac.RoleContributor`).
- Open questions in `proposal.md` are genuinely deployment-topology questions that cannot be answered from source; correctly left open rather than turned into unverified requirements.
- No module-specific `AGENTS.md` exists under `services/submission` or `envoy` (confirmed by search), matching the proposal's claim.
