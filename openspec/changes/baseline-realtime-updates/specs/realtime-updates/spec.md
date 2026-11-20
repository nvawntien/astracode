## Purpose

Provide the owner of a Submission with its current status and live SSE status notifications. Verdict computation and Submission lifecycle rules belong to `judging` and `submission` respectively.

## ADDED Requirements

### Requirement: RT-01 Owner-only ticket issuance

The system SHALL issue a stream ticket and its expiration time only to an authenticated owner of an existing Submission with the User, legacy Contributor, Moderator, or Admin role. It SHALL reject an invalid Submission identifier, missing identity or role, and unsupported roles. Moderator and Admin roles SHALL NOT override stream-ticket ownership; a missing Submission and a Submission owned by someone else SHALL both produce a not-found outcome.

#### Scenario: Owner obtains a ticket

- **WHEN** an authenticated owner with an allowed role requests a ticket for an existing Submission
- **THEN** the system returns a ticket bound to that owner and Submission, together with its expiration time

#### Scenario: Privileged non-owner requests a ticket

- **WHEN** a Moderator or Admin requests a ticket for someone else's Submission
- **THEN** the system returns a not-found outcome and issues no ticket

#### Scenario: Missing Submission

- **WHEN** an authenticated owner requests a ticket for a Submission that does not exist
- **THEN** the system returns a not-found outcome and issues no ticket

#### Scenario: Invalid ticket request or actor

- **WHEN** a ticket request has an invalid Submission identifier, lacks identity or role, or supplies an unsupported role
- **THEN** the system rejects the request and issues no ticket

### Requirement: RT-02 Authentic purpose-bound expiring tickets

The system SHALL issue signed tickets specific to Submission streaming, with an owner identity, Submission identifier, issuance time, and expiration time determined by the configured ticket lifetime. It SHALL reject absent, malformed, tampered, wrongly purposed, or expired tickets, and tickets with missing required claims, a nonpositive Submission identifier, or an issuance time that is not before expiration. Expiration SHALL include the exact expiration instant.

#### Scenario: Ticket is within its lifetime

- **WHEN** an authentic Submission-stream ticket has valid required claims and is presented before its expiration
- **THEN** ticket verification accepts it

#### Scenario: Invalid or altered ticket

- **WHEN** a ticket is absent, malformed, tampered, has another purpose, or has invalid required claims
- **THEN** ticket verification rejects it

#### Scenario: Ticket expires

- **WHEN** a new connection presents a ticket at or after its expiration time
- **THEN** the system rejects the ticket as expired

### Requirement: RT-03 Submission-bound stream admission

The system SHALL admit a stream only for a valid positive Submission identifier and an accepted ticket identifying that same Submission. It SHALL read the current Submission owner and require it to match the ticket's owner identity before sending status data. A nonexistent Submission or owner mismatch SHALL produce a not-found outcome.

#### Scenario: Ticket belongs to another Submission

- **WHEN** an accepted ticket identifies a different Submission from the one requested
- **THEN** the system rejects the connection without sending status data

#### Scenario: Current owner does not match the ticket

- **WHEN** the Submission is missing or its current owner differs from the ticket's owner identity
- **THEN** the system returns a not-found outcome without sending status data

#### Scenario: Invalid Submission reference

- **WHEN** a stream request does not identify a positive integer Submission
- **THEN** the system rejects the connection without sending status data

### Requirement: RT-04 Reusable tickets and admission-time authorization

The system SHALL allow an unexpired ticket to be reused for stream connections that pass the Submission and owner checks, without requiring a separate signed-in session on those connections. It SHALL check ticket validity at admission and SHALL NOT terminate an established stream solely because that ticket later expires. Stream admission and ongoing delivery SHALL NOT perform a separate login-session revocation check.

#### Scenario: Ticket is reused without a login session

- **WHEN** a client without a signed-in session reuses an unexpired ticket and passes the Submission and owner checks
- **THEN** the system admits the stream without consuming the ticket

#### Scenario: Ticket expires after admission

- **WHEN** a stream was admitted before ticket expiration and the ticket expires while the stream remains open
- **THEN** ticket expiration alone does not close the stream

#### Scenario: Session is revoked after ticket issuance

- **WHEN** an unexpired ticket is presented after the issuing owner's login session is revoked and the Submission and owner checks still pass
- **THEN** stream admission does not reject it on the basis of that session revocation

### Requirement: RT-05 Stream origin checks

When an allowed origin is configured, the system SHALL reject a stream request with a different nonempty origin. It SHALL accept an absent origin subject to the other admission checks, and SHALL allow a matching origin with an explicit origin allowance that varies by origin.

#### Scenario: Origin matches

- **WHEN** a request's origin matches the configured allowed origin and admission otherwise succeeds
- **THEN** the stream response allows that origin and declares that the response varies by origin

#### Scenario: Origin differs

- **WHEN** a request supplies a nonempty origin different from the configured allowed origin
- **THEN** the system returns a forbidden outcome without starting the status stream

#### Scenario: No origin is supplied

- **WHEN** a request has no origin and passes the ticket and ownership checks
- **THEN** the absence of an origin does not prevent stream admission

### Requirement: RT-06 Initial current-status delivery

On successful admission, the system SHALL send the current persisted Submission status as the first status event. A nonterminal status SHALL be named `submission.snapshot` and leave the stream open. A terminal status, as recognized by `submission`, SHALL be named `submission.completed` and close the stream after it is sent.

#### Scenario: Nonterminal snapshot

- **WHEN** a connection is admitted while the current Submission status is nonterminal
- **THEN** the first status event is `submission.snapshot` for the current Attempt and the stream remains open

#### Scenario: Already completed Submission

- **WHEN** a connection is admitted while the current Submission status is terminal
- **THEN** the first status event is `submission.completed` and the stream closes after sending it

### Requirement: RT-07 Status metadata without execution content

Every status event SHALL contain only the Submission identifier, Attempt identifier, status, and update timestamp as its JSON data. The event identifier SHALL combine the Submission identifier, Attempt identifier, and UTC update timestamp. Status events SHALL NOT include owner identity, source code, compiler diagnostics, runtime diagnostics, execution measurements, testcase inputs, expected outputs, or actual outputs.

#### Scenario: Snapshot or live notification is serialized

- **WHEN** the system sends any snapshot or live status event
- **THEN** its JSON data contains exactly those four status metadata values and its event identifier is derived from the same Submission, Attempt, and update time
- **AND** no execution content or owner identity is included

### Requirement: RT-08 Live event naming and terminal closure

For a live event that passes the stream's Submission and Attempt checks, the system SHALL send `submission.completed` when its status is recognized as terminal by `submission`, and SHALL close the stream after sending it. Other passing live status events SHALL be named `submission.updated` and SHALL leave the stream open. This naming behavior SHALL NOT imply that intermediate status events are currently published.

#### Scenario: Matching terminal event

- **WHEN** an open stream receives a matching live event with a recognized terminal status
- **THEN** it sends `submission.completed` and closes

#### Scenario: Matching nonterminal event

- **WHEN** an open stream receives a matching live event with a nonterminal status
- **THEN** it sends `submission.updated` and remains open

### Requirement: RT-09 Attempt fixed at connection time

An open stream SHALL deliver live status events only for its requested Submission and the Attempt captured in its initial snapshot. It SHALL ignore events for any other Submission or Attempt and SHALL NOT automatically switch to a later Attempt after a rejudge.

#### Scenario: Event belongs to another Submission or Attempt

- **WHEN** a live event identifies another Submission or a different Attempt from the initial snapshot
- **THEN** the stream does not send that event

#### Scenario: Current Attempt changes while a stream remains open

- **WHEN** a rejudge changes the current Attempt while a stream for the previous Attempt is still open
- **THEN** the stream continues to ignore the new Attempt's events until the client establishes a new connection

### Requirement: RT-10 Result notifications after commit

When `submission` applies a terminal result, the system SHALL publish its status notification only after the result transaction commits successfully, using the applied Submission's identifier, Attempt, status, and update timestamp. It SHALL publish no notification if result processing fails, the transaction fails to commit, or `submission` discards the result without applying a change.

#### Scenario: Result application commits

- **WHEN** a terminal result is applied successfully and its transaction commits
- **THEN** the system publishes the applied status metadata after commit

#### Scenario: Processing or commit fails

- **WHEN** result processing fails or the result transaction fails to commit
- **THEN** the system publishes no status notification for that result

#### Scenario: Result is discarded without a change

- **WHEN** `submission` discards a stale, duplicate, or otherwise inapplicable result without changing the Submission
- **THEN** the system publishes no status notification for that result

### Requirement: RT-11 Current live-publication coverage

The system SHALL currently publish live status notifications only from successful application of terminal results. Creating a Submission, requesting a rejudge, and intermediate judging progress SHALL NOT independently publish live status notifications. Their current persisted status SHALL remain observable through the initial snapshot on a new connection.

#### Scenario: Submission creation or rejudge

- **WHEN** a Submission is created or a rejudge is requested
- **THEN** that action does not publish a live status notification

#### Scenario: Intermediate judging progress

- **WHEN** judging is in progress without a terminal result being applied
- **THEN** the stream receives no intermediate progress notification from the current result publisher

### Requirement: RT-12 Reconnect reads current state without replay

On every admitted reconnection, the system SHALL read and send a new current-status snapshot using the same initial-event naming rules. It SHALL NOT replay historical events or resume an event history from a previously received event identifier.

#### Scenario: Reconnect after a missed completion

- **WHEN** a client reconnects after a terminal result committed while it was disconnected
- **THEN** it receives the current status as `submission.completed` and the connection closes

#### Scenario: Reconnect supplies a prior event identifier

- **WHEN** a reconnecting client supplies the identifier of a previously received event
- **THEN** the stream starts with current persisted status and does not replay intervening historical events

### Requirement: RT-13 Instance-local fan-out

Live status publication SHALL fan out to the currently registered streams for that Submission in the same service instance. It SHALL NOT forward notifications between service instances or retain events for clients that were not subscribed when publication occurred.

#### Scenario: Multiple local subscribers

- **WHEN** a status event is published with several subscribed streams for that Submission in the same instance
- **THEN** each local subscriber is offered the event, subject to its Attempt filter and slow-subscriber behavior

#### Scenario: Subscriber is on another instance or connects later

- **WHEN** a client is connected to another instance, or subscribes only after an event was published
- **THEN** that publication is not forwarded or retained for that client by the live stream mechanism

### Requirement: RT-14 Latest pending event for slow subscribers

The system SHALL retain at most one pending live event per subscriber and replace an unread pending event with the latest publication for that subscriber. A slow subscriber SHALL NOT require the publisher to wait for it to read its pending event.

#### Scenario: Two events arrive before the subscriber reads

- **WHEN** two live events are published for a subscriber before it reads the pending event
- **THEN** the pending event is the later publication and the earlier pending event is dropped

### Requirement: RT-15 SSE setup and heartbeats

The system SHALL establish accepted streams as SSE with response directives against caching, transformation, and proxy buffering, and SHALL flush the retry instruction and each status event. It SHALL advertise a reconnect delay of 3000 milliseconds before the first status event. While a nonterminal stream remains open, it SHALL send and flush heartbeat comments at the configured heartbeat interval.

#### Scenario: Stream starts

- **WHEN** a stream is admitted and begins its response
- **THEN** it identifies its content as SSE, sends response directives against caching, transformation, and proxy buffering, and sends a flushed 3000-millisecond retry instruction before the first status event

#### Scenario: Heartbeat interval elapses

- **WHEN** the configured heartbeat interval elapses while a nonterminal stream is open
- **THEN** the system sends and flushes a heartbeat comment without treating it as a status event

### Requirement: RT-16 Failure handling and subscription cleanup

The system SHALL send no status data when the initial status read fails or the underlying response writer lacks flushing support. Once registered for live delivery, a stream SHALL release its subscription on every exit. It SHALL end delivery when the client disconnects, its request is cancelled, live delivery closes, or a stream write fails.

#### Scenario: Initial read fails

- **WHEN** the initial status cannot be read
- **THEN** the system returns an error without starting status delivery and releases any registered subscription

#### Scenario: Response does not support flushing

- **WHEN** setup writes the retry instruction and attempts to flush it through an underlying response writer without flushing support
- **THEN** setup ends before writing a status event and releases the subscription

#### Scenario: Active stream exits

- **WHEN** the request is cancelled, the client disconnects, live delivery closes, a write fails, or a terminal event ends delivery
- **THEN** the system stops streaming and releases the subscription

### Requirement: RT-17 Gateway stream duration

The gateway SHALL permit the ticket-authenticated status stream without an overall request deadline and SHALL apply a 75-second stream idle timeout. Ticket-based stream admission SHALL remain responsible for stream authorization.

#### Scenario: Active status stream exceeds ordinary request durations

- **WHEN** a status stream remains active beyond ordinary request durations
- **THEN** the gateway does not close it because of an overall request deadline

#### Scenario: Stream is idle

- **WHEN** a status stream has no activity for 75 seconds
- **THEN** it reaches the gateway's configured idle timeout
