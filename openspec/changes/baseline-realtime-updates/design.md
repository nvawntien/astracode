## Context

See `proposal.md` for motivation, scope, findings, and the deployment question. This is a baseline of source commit `728aef24cc0d6f624f79fd612265e904406d3d44`, not an implementation design for future behavior.

The context documents read were:

- `docs/codebase/ARCHITECTURE.md`: Submission owns SSE delivery and the result consumer.
- `docs/codebase/FLOWS.md`: the result-application-to-stream path.
- `docs/codebase/DATA.md`: Submission-owned persistence and transaction boundaries.
- `docs/codebase/SERVICES.md`: owner-only tickets and the process-local event hub.
- `docs/process/glossary.md`: Submission, Attempt, Verdict, Rejudge, SSE, and role terminology. The legacy Contributor discrepancy is recorded in the proposal.

These documents orient the review; the code in the Evidence table establishes each requirement. No cited NFR or feature IDs were supplied, so this baseline does not read additional product requirements or invent quality targets. No module-specific `AGENTS.md` was found under Submission or Envoy.

## Goals / Non-Goals

**Goals:** Make every ADDED requirement traceable to an implementation function or handler; separate confirmed behavior from deployment unknowns; preserve the boundary between result processing and notification delivery.

**Non-Goals:** Any implementation, new test, contract, authentication, sandbox, outbox, schema, or deployment change. The `judging` and `submission` baselines retain their own rules; this design records only their observable notification boundary.

## Decisions

1. **Add one flat capability, `realtime-updates`.** `openspec list --specs` reports no existing specs, and the requested boundary names one capability. All requirements are ADDED. Alternatives such as changing the main specs, splitting the capability, or omitting the delta would contradict the baseline request.
2. **Use source evidence for current behavior.** Keep paths, functions, defaults, and test limitations here; keep the delta behavioral. Documentation describes intent but is not used as sole evidence. Create this design even though no code is planned because the requested evidence table and the access/commit boundaries need an explicit review record.
3. **Describe three distinct phases.** The owner obtains a ticket; the handler verifies it, subscribes locally, and reads a snapshot; result processing publishes later committed changes. The subscription is installed before the snapshot read, but the handler always sends the initial snapshot before draining live events. A terminal snapshot closes immediately. This does not promise exactly-once delivery, event-history replay, or cross-instance coordination.
4. **Separate supported event names from current producers.** The handler maps a matching nonterminal event to `submission.updated`, but only terminal result application currently calls the live status publisher. Creation and rejudge publish judge jobs through a different port, not SSE notifications. Treating those jobs as live updates would misstate the code.
5. **Preserve limitations.** A connection retains its initial Attempt, tickets are reusable and checked at admission, and slow subscribers retain only the latest pending event. Stronger replay, revocation, Attempt-switching, and fan-out guarantees would need another approved change.

## Current mechanisms

- Ticket issuance: authenticated `POST /api/v1/submissions/{submission_id}/events/ticket`; the use case checks the owner regardless of role. The HMAC-SHA256 ticket contains a fixed stream purpose, owner, Submission, issuance time and expiry. It has no Attempt binding, consumption record, or session-revocation lookup.
- Stream admission: `GET /events/submissions/{submission_id}` is ticket-authenticated rather than protected by the router's login middleware. The handler checks the identifier, origin, ticket, ticket Submission, current snapshot, and owner. The snapshot read selects only status metadata plus owner for authorization.
- Serialization: status JSON keys are `submission_id`, `attempt_id`, `status`, and `updated_at`. SSE IDs use `<submission>:<attempt>:<UTC RFC3339Nano update time>`. The first frame advertises `retry: 3000`. Heartbeats are `: heartbeat` comments. The handler flushes frames and removes its subscription on return.
- Publication: `applyJudgeResultUseCase.Execute` prepares a notification inside the transaction and calls the hub only after `ExecuteInTx` returns successfully. The concrete transaction manager returns successfully after GORM's transaction/commit finishes. Discarded results never assign an event to publish. This is not a durable SSE outbox and does not make post-commit publication crash-safe.
- Fan-out: `InitializeApp` constructs one hub shared by the handler and the result use case within that process. Each subscriber has a one-event buffer; `trySendLatest` replaces an unread event rather than waiting for the subscriber to drain it.
- Checked-in local defaults are a two-minute ticket lifetime, a 15-second heartbeat, and the localhost website origin. They are configurable and are not claims about deployed values. Envoy's generator adds the SSE route separately from `routes.json`, preserving the ticket query, with request timeout `0s`, idle timeout `75s`, and no per-route JWT requirement. Ticket issuance remains protected in the route inventory. No production configuration is changed.

## Evidence

One row corresponds to one requirement in `specs/realtime-updates/spec.md`. Existing tests corroborate selected branches; explicit source review covers the remaining scenarios. The table does not claim that every scenario has a dedicated automated test.

| Requirement | Implementation file path and function/handler | Corroborating checks / limits |
| --- | --- | --- |
| RT-01 Owner-only ticket issuance | `services/submission/internal/application/usecase/user/issue_stream_ticket.go` — `issueSubmissionStreamTicketUseCase.Execute`; `services/submission/internal/adapter/inbound/http/handler/user/issue_stream_ticket.go` — `IssueSubmissionStreamTicketHandler.Handle`; `services/submission/internal/adapter/inbound/http/router.go` — `Router.SetupRoutes` | `TestIssueSubmissionStreamTicketSuccess`, `TestIssueSubmissionStreamTicketRejectsInvalidActorAndRequest`, `TestIssueSubmissionStreamTicketRejectsOtherOwner`, `TestIssueSubmissionStreamTicketRepositoryAndTicketErrors`; source confirms all four roles and no privileged ownership override. |
| RT-02 Authentic purpose-bound expiring tickets | `services/submission/internal/adapter/outbound/stream/hmac_ticket.go` — `hmacSubmissionStreamTicketService.Issue`, `Verify`, `sign` | `TestHMACSubmissionStreamTicketIssueAndVerify`, `TestHMACSubmissionStreamTicketRejectsInvalidTickets`, `TestHMACSubmissionStreamTicketRejectsExpiredTicket`; source review additionally checks all required-claim guards. |
| RT-03 Submission-bound stream admission | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `SubmissionEventsHandler.Handle`, `parsePositiveInt64`; `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `submissionRepository.GetStreamSnapshot` | `TestSubmissionEventsHandlerRejectsInvalidTicketBeforeSnapshot`, `TestSubmissionEventsHandlerRejectsWrongSubmissionOrOwner`, `TestSubmissionRepositoryGetStreamSnapshotNotFound`; source confirms the identifier check and read-before-delivery order. |
| RT-04 Reusable tickets and admission-time authorization | `services/submission/internal/adapter/outbound/stream/hmac_ticket.go` — `Issue`, `Verify`; `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle`; `services/submission/internal/adapter/inbound/http/router.go` — `SetupRoutes`; `envoy/generate.py` — `build` | Source review: no ticket consumption, login-session lookup, or expiration timer in the stream loop; the stream route has no per-route JWT check. Expiration tests cover new ticket verification, not expiry or revocation during an active stream. |
| RT-05 Stream origin checks | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `NewSubmissionEventsHandler`, `SubmissionEventsHandler.applyCORS`, `Handle`; `services/submission/internal/container/providers.go` — `ProvideSSEConfig` | `TestSubmissionEventsHandlerSendsTerminalSnapshotAndCloses` checks matching-origin response headers. Source review covers mismatched/absent origin and the configured-origin fallback. |
| RT-06 Initial current-status delivery | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle`; `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `GetStreamSnapshot` | `TestSubmissionEventsHandlerSendsTerminalSnapshotAndCloses`, `TestSubmissionEventsHandlerHeartbeatAndContextCancelCleanup`; uses the existing terminal-status classification without redefining it. |
| RT-07 Status metadata without execution content | `services/submission/internal/domain/entity/submission_stream.go` — `SubmissionStreamSnapshot.Event` and its returned event's JSON fields; `services/submission/internal/domain/entity/submission.go` — `Submission.Event`; `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `writeSSEEvent` | `TestSubmissionEventsHandlerSendsTerminalSnapshotAndCloses`, `TestSubmissionEventsHandlerReceivesApplyJudgeResultCommittedEvent`; source establishes the exact four-field shape and event-ID format. |
| RT-08 Live event naming and terminal closure | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle` | `TestSubmissionEventsHandlerSendsHubTerminalEventAndIgnoresAttemptMismatch`; source review covers the `submission.updated` branch. Handler support does not establish an intermediate-event producer. |
| RT-09 Attempt fixed at connection time | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle` | `TestSubmissionEventsHandlerSendsHubTerminalEventAndIgnoresAttemptMismatch`; source confirms the captured Attempt is never refreshed, including when a stream survives until a later Attempt. |
| RT-10 Result notifications after commit | `services/submission/internal/application/usecase/result/apply_judge_result.go` — `applyJudgeResultUseCase.Execute`; `services/submission/internal/adapter/outbound/persistence/postgres/tx_manager.go` — `transactionManager.ExecuteInTx` | `TestApplyJudgeResultMatchingAttemptAppliesTerminalStatuses`, `TestApplyJudgeResultDoesNotPublishOnTransactionCommitFailure`, `TestApplyJudgeResultPropagatesRepositoryErrors`, `TestApplyJudgeResultStaleOrLegacyAttemptIsAckNoop`, `TestApplyJudgeResultDuplicateMatchingResultIsAckNoopAfterTerminalCommit`. These use transaction doubles; concrete commit ordering is also inspected in source. |
| RT-11 Current live-publication coverage | `services/submission/internal/application/usecase/result/apply_judge_result.go` — `Execute`; `services/submission/internal/application/usecase/user/create_submission.go` — `createSubmissionUseCase.Execute`; `services/submission/internal/application/usecase/admin/rejudge_submission.go` — `rejudgeAdminSubmissionUseCase.Execute`; `services/submission/internal/adapter/outbound/judge/kafka_judge.go` — `outboxJudgePublisher.Publish` | Source search of all production event-hub calls finds only result application. Creation/rejudge publish jobs through the outbox port, not the live status hub. No lifecycle or verdict rule is specified here. |
| RT-12 Reconnect reads current state without replay | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle`; `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `GetStreamSnapshot` | Source review: every connection reads a snapshot; the handler does not read a previous event identifier or query historical notifications. Terminal snapshot behavior is covered by `TestSubmissionEventsHandlerSendsTerminalSnapshotAndCloses`. |
| RT-13 Instance-local fan-out | `services/submission/internal/adapter/outbound/stream/event_hub.go` — `NewSubmissionEventHub`, `SubmissionEventHub.Subscribe`, `Publish`; `services/submission/cmd/server/wire_gen.go` — `InitializeApp` | `TestSubmissionEventHubMultipleSubscribers`, `TestSubmissionEventHubPublishWithoutSubscribersDoesNotBlock`; source confirms local-only subscriber storage and shared in-process wiring. No multi-instance delivery test or guarantee is claimed. |
| RT-14 Latest pending event for slow subscribers | `services/submission/internal/adapter/outbound/stream/event_hub.go` — `Subscribe`, `submissionSubscriber.trySendLatest` | `TestSubmissionEventHubSlowSubscriberGetsLatest`; source confirms the one-event buffer and replacement behavior. |
| RT-15 SSE setup and heartbeats | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle`, `writeRawSSE`, `writeSSEEvent`; `services/submission/internal/container/providers.go` — `ProvideSSEConfig` | `TestSubmissionEventsHandlerSendsTerminalSnapshotAndCloses`, `TestSubmissionEventsHandlerHeartbeatAndContextCancelCleanup`; source confirms retry value, flush calls, and configured ticker. |
| RT-16 Failure handling and subscription cleanup | `services/submission/internal/adapter/inbound/http/handler/user/submission_events.go` — `Handle`; `services/submission/internal/adapter/outbound/stream/event_hub.go` — `Subscribe`'s unsubscribe closure, `submissionSubscriber.close` | `TestSubmissionEventsHandlerMapsSnapshotRepositoryErrors`, `TestSubmissionEventsHandlerHeartbeatAndContextCancelCleanup`, `TestSubmissionEventHubSubscribePublishAndCleanup`, `TestSubmissionEventHubConcurrentPublishUnsubscribe`; source review covers write-error and closed-channel exits. |
| RT-17 Gateway stream duration | `envoy/generate.py` — `build`; generated SSE route in `envoy/envoy.yaml` and `envoy/envoy.prod.yaml`; `envoy/routes.json` — authenticated ticket-issuance entry | Read-only inspection confirms timeout `0s`, idle timeout `75s`, and ticket-authenticated SSE. This is configuration evidence, not an elapsed-time gateway integration test. |

## Risks / Trade-offs

- Source-derived absence claims (no replay, no intermediate publisher, no session recheck) can drift when new paths are added → review the complete stream flow and production publisher references when changing this capability.
- Unit tests and the result-to-handler test use repository/transaction doubles → retain the concrete transaction-manager source evidence and do not claim real PostgreSQL commit-fault, Kafka, replica, browser, or deployed acceptance verification.
- The behavior includes missed-notification, rejudge, and revocation limitations → preserve the proposal's Findings; this change does not repair or strengthen them.
- The OpenSpec CLI warns that the repository's artifact rules are strings rather than arrays and ignores those rules → enforce the requested restrictions during this review; do not edit the out-of-scope configuration.

## Interface and document impact

**NON-BREAKING:** no interface changes or new contract drafts. No architecture documents will be updated. The four codebase documents and glossary are read-only context; all new artifacts remain in this change directory. Main specs and other changes remain untouched.

## Migration Plan

None: no runtime deployment, data migration, or archive. Review, strict validation, a scoped documentation commit, and the explicitly requested feature-branch push are the complete deliverable.

## Open Questions

The actual deployment topology/configuration question remains in `proposal.md`; it does not alter this source baseline. No unresolved functional assumption is used as a requirement.
