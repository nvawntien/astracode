# ADR-0007 — Service boundaries and data ownership for new capabilities

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-11-24 |
| Milestone | M0-12 |
| Requirement | FRD-1 (owning service of each new capability); NFR-A04, NFR-S03, NFR-R04, NFR-C04 |
| Implementation | M1-13, M1-04, M1-06, M1-07, M1-08, M1-10, M2-01, M2-04, M3-04; Should capabilities in M4 |
| Owner | Orchestrator |
| Review | Service and capability owners |

This ADR is a **frame**. It assigns each new capability to a service and a data store, sets the rules for how services
talk to each other, fixes the direction of every cross-service dependency, and decides two cross-cutting mechanisms
(premium entitlement propagation and track access). Feature changes design their flows, schemas, contracts and
product rules **inside** this frame. A change that needs to move ownership or add a synchronous dependency to a core
journey needs a new ADR that supersedes this one.

Out of scope: event envelope, error format, versioning and compatibility rules (ADR-0005, M0-10, not yet written); event and API field definitions (contracts-first change M1-06 and each feature change); physical placement on
Azure (ADR-0004, M0-09); product rules (PRD Appendix A, then specs).
[Delivery plan](../../product/delivery-plan.md) · [FRD capability map](../../product/frd.md#2-capability-map) ·
[PRD features](../../product/prd.md#part-3--features)

## Context

AstraCode runs Auth, Problem and Submission services, each owning one PostgreSQL database (`auth_db`, `problem_db`,
`submission_db`) on one PostgreSQL server, and a Judge Worker without a database. Services read each other only
through gRPC; no service reads another service's tables. [Data ownership](../../codebase/DATA.md) ·
[Architecture](../../codebase/ARCHITECTURE.md)

Facts that shape this decision:

- **Events.** Kafka carries only the judging topics (jobs, results, DLT). Only Submission has a transactional outbox.
  Its relay reads pending rows without claiming them, so two relay instances would publish the same row twice.
  Reading the relay also shows that messages which reach the retry limit stay pending and are skipped forever: they
  can fill every batch, and a Kafka outage of a few poll cycles can strand accepted submissions (NFR-R01). These
  findings come from the code and are not yet reproduced (`TECH_DEBT.md`).
  [Outbox repository](../../../services/submission/internal/adapter/outbound/persistence/postgres/outbox.go) ·
  [Relay](../../../services/submission/internal/adapter/outbound/outbox/relay.go)
- **Realtime.** Submission pushes verdicts over SSE through an in-process `EventHub`. Delivery across replicas is not
  guaranteed (`TECH_DEBT.md`, NFR-C04).
- **Content moderation.** Drafts, publish and hide live in Problem, next to the catalog.
- **Email.** The only SMTP adapter is in Auth, for account emails.
- **Identity at the edge.** Envoy verifies the access JWT and maps `sub`, `role`, `username` and `iat` to `X-User-*`
  headers, stripping caller-supplied ones. Each service's middleware rejects tokens issued before the account's
  logout-all cutoff in Redis. On ordinary requests nothing reads `auth_db`. [Gateway routes](../../../envoy/ROUTES.md) ·
  [Middleware](../../../pkg/middleware/auth.go)
- **Refresh.** Access tokens last 15 minutes and refresh tokens 7 days (`services/auth/config/config.yaml`). Refresh
  loads the user record to check activation and suspension, but copies the role from the presented refresh token
  ([refresh use case](../../../services/auth/internal/application/usecase/auth/refresh_token.go);
  `identity-session` spec, "Refresh role and previous token"). A claim handled the same way would change only at the
  next sign-in, up to 7 days later.
- **Scope.** PRD v0.6 Must capabilities to place: membership, quiz, learning-roadmap, contest, rating, notification,
  kpi-analytics. Should: ai-assistant, social-follow, discussion, gamification, problem-leaderboard.
- **Constraints.** Budget of 5 student subscriptions × ~$100 (NFR-F01). The Azure topology (ADR-0004) is not decided;
  production today separates an App node and a Judge node. A 6-person team owns capabilities in parallel.

## Options

### Where new capabilities live

| Option | Trade-off |
|---|---|
| A. Extend the three existing services | Fewest processes. Problem and Submission grow several unrelated workloads; contest peaks and per-user progress writes share the judging critical path; ownership blurs across the team. |
| B. One new service per new capability | Clean ownership. About ten new processes and databases for a budget-bound single-environment deployment; many services with almost no logic. |
| **C. Extend where the data and lifecycle already are; new services for distinct workloads (chosen)** | Quiz joins the catalog and moderation lifecycle it shares. Learning, Contest, Notification and Analytics have their own data, load shape and failure isolation needs, so they become services. Four new processes, with a packaging escape hatch (below). |

### How services learn that a user is premium

| Option | Trade-off |
|---|---|
| **a. Entitlement claim in the JWT, refreshed from `auth_db` (chosen)** | No runtime dependency on Auth for reads; expiry exact; grants and revocations take effect within one access-token lifetime. Changes the gateway contract (additive) and the refresh behaviour. |
| b. Synchronous gRPC lookup to Auth on each request (with cache) | Always current. Every content read depends on Auth being up, which breaks NFR-A04 and adds latency to every read. |
| c. Local projection in every service from entitlement events | No runtime dependency and near-real-time. Every content service stores and maintains a copy of entitlement state; the most work and the most places to get wrong. |

## Decision

### 1. Ownership

**Must capabilities**

| Capability | Owning service | Data store | Notes |
|---|---|---|---|
| membership | Auth | `auth_db` | Entitlement, expiry, grant/revoke, mock checkout. Track-access *decisions* are made by the shared `TrackAccess` check (§4). |
| quiz | Problem | `problem_db` | Quizzes and quiz answers. Uses the same moderation lifecycle and track attribute as problems. |
| content-moderation | Problem | `problem_db` | Already there; extended to quizzes. Whether other content types (posts, design problems) reuse it stays open as FRD-2. |
| problem-catalog | Problem | `problem_db` | Also owns the visibility of problems reserved for a contest (§3). |
| learning-roadmap | **Learning** (new) | `learning_db` | Roadmaps, nodes, readings, user progress, "Continue learning", and a projection of the practice items each user has solved. |
| contest, rating | **Contest** (new) | `contest_db` | Scheduling, registration, record of contest submissions, standings, live leaderboard, rating job and rating history. |
| notification | **Notification** (new) | `notification_db` | Notification rules, in-app inbox, unread count, moderator digest, notification emails. Auth keeps account emails (verification, password reset). |
| kpi-analytics | **Analytics** (new) | `analytics_db` | Event-fed read model (per-user daily activity and daily counters) and the admin KPI API. |

Existing capabilities keep their owners: identity-session and user-profile in Auth; submission, statistics and
submission realtime updates in Submission; judging and code-run in Judge Worker. The profile page is composed by the
frontend from Auth (profile), Submission (statistics) and Contest (rating and history); there is no profile
aggregation service.

**Should capabilities** (placement reserved; details decided by their changes)

| Capability | Placement |
|---|---|
| ai-assistant | New AI service with its own database (vector storage per ADR-0010) |
| social-follow | Auth, next to user-profile |
| gamification | Learning, with other learner-progress data |
| problem-leaderboard | Submission, where accepted runtime and memory data live |
| discussion | Own service; how post moderation reuses the Problem lifecycle is decided with FRD-2 in M4-11 |

Each new service has its own database on the shared PostgreSQL server and its own Goose migrations, per
[ADR-0006](0006-schema-migration-policy.md). New services follow the module layout and boundaries in `AGENTS.md`.

### 2. Communication rules

1. A service reads and writes only its own database. Other services' data is reached through gRPC or events.
2. Every service that publishes domain events writes them in the same transaction as the state change, through a
   transactional outbox. All producers use one shared relay in `pkg/`. It claims rows so that several relay instances
   never publish the same row (§5), publishes in order, retries with time-based backoff so that a broker outage does
   not exhaust messages, and moves a message that finally fails to a visible failed state with a metric and an alert.
   M1-13 `fix-outbox-relay-delivery` builds it before any second producer is added.
3. Domain events travel over Kafka. Envelope, naming, versioning and compatibility follow ADR-0005.
4. Consumers are idempotent by event ID and tolerate redelivery and out-of-order delivery within a key (NFR-R04).
5. gRPC is for queries and for checks that must be answered before a write. Synchronous calls have a timeout and a
   defined behaviour when the callee is unavailable.
6. **Core journeys** (sign-in, catalog, problem page, practice submit, judging) have no synchronous dependency on
   Learning, Contest, Notification, Analytics or any Should service (NFR-A04).

### 3. Dependency map

Event names are descriptive; M1-06 and each producing change define the contracts.

**Synchronous (gRPC)**

| Caller → callee | Purpose | When the callee is unavailable |
|---|---|---|
| Submission → Problem | Problem metadata and access before a submission (existing) | Submit fails (existing behaviour) |
| Submission → Contest | Contest submission check (registered, inside the window, problem belongs to the contest). Only for submissions that carry a contest ID | Contest submissions fail; practice submissions are unaffected |
| Contest → Problem | Reserve the contest's problems and set when they become visible; release or reschedule them | Scheduling fails; running contests are unaffected |
| Learning → Problem | Batch metadata (title, difficulty, track) for practice items when a roadmap is read | Roadmap shows structure and progress without item metadata |
| Learning → Submission | One-time backfill of problems each user had already solved, at Learning's first deployment | Backfill retried; not on a request path |
| Notification → Problem | Count of items waiting for review, for the moderator digest | Digest skipped and retried |
| Any service → Auth | Entitlement lookup, only on paths with no user request (jobs, consumers) | Treated as no entitlement |

**Asynchronous (events through the outbox and Kafka)**

| Producer | Event (descriptive) | Consumers |
|---|---|---|
| Problem | Content submitted, pre-check result, moderation decision | Notification (outcomes), Analytics (review time, pre-check effectiveness) |
| Problem | Quiz answered | Learning (progress), Analytics (practice volume, activity) |
| Submission | Submission judged (final result of an attempt, with contest ID when present) | Contest (standings), Learning (progress), Analytics (practice volume, acceptance, activity) |
| Contest | Registered; starting soon; finished (standings and ratings final) | Notification (reminder), Analytics (participation, activity) |
| Learning | Node completed | Analytics (roadmap progress, activity) |
| Auth | User registered and verified; entitlement changed | Analytics (signups, retention, premium conversion); Notification (premium expiry, Should) |

Judge Worker keeps consuming only judge jobs and producing judge results. No new service sits on the judging path;
Contest, Learning and Analytics act after Submission has applied the result.

### 4. Premium entitlement and track access

**Propagation (option a).**

- Auth owns the entitlement and its expiry (`premium_until`).
- Access and refresh tokens carry a `premium_until` claim (absent for users without premium).
- **Refresh sets `premium_until` from the user record it already loads**, not from the presented token. It adds no
  database read. The role keeps its current behaviour (see Consequences).
- A successful mock checkout returns new credentials, so the buyer's next request carries the entitlement.
- An admin grant or revoke takes effect at the user's next refresh, at most one access-token lifetime later
  (15 minutes with the current configuration). Immediate removal of access remains available through the existing
  suspension and logout-all mechanisms.
- Expiry is exact: services compare `premium_until` with the current time.
- Envoy maps the claim to `X-User-Premium-Until` and strips any caller-supplied value, like the other `X-User-*`
  headers. The shared middleware exposes it in the request context. This is a NON-BREAKING gateway contract change.
- A missing or unparsable value means no entitlement (fail closed).

**Track access.**

- `TrackAccess` is a pure function in `pkg/`: inputs are the content's track, the caller's role, `premium_until` and
  the current time; the result is `full` or `teaser`. Moderators and Admins get `full`. The track list (`dsa`,
  `beyond-leetcode`, `system-design`) is a constant in `pkg/`; no service owns tracks.
- Every content read path and submit path calls it, and the change that adds the path adds its rows to the
  access-matrix test (NFR-S03; delivery plan rule 6). Read paths include list, detail, search, roadmap content and,
  later, AI retrieval.
- Paths without a user request (consumers, jobs) that need entitlement ask Auth through gRPC (§3).

### 5. Deployment independence

The decisions above are logical. ADR-0004 maps services to machines. To keep them valid when the topology changes
(one VM, an App VM plus a Judge VM, more judge workers, or several replicas of an application service):

1. **No in-process source of truth.** A service keeps no state in memory that another replica would need; its
   database is the source of truth.
2. **Outbox relay is replica-safe.** The relay claims rows (for example `FOR UPDATE SKIP LOCKED` with a lease) before
   publishing.
3. **Scheduled jobs run once across all replicas.** Examples: moderator digest, contest reminders, rating computation,
   premium expiry notices. A job holds a PostgreSQL advisory lock while it runs and is idempotent (it records what it has
   already done).
4. **Clocks are synchronized** (NTP) on every node, because contest windows, problem visibility and premium expiry
   depend on time.
5. **Realtime.** Until multi-replica realtime (NFR-C04, M4-06), each service that serves SSE (Submission, Contest,
   Notification) runs as one replica. Its push source is its own database or the events it consumes, never an
   in-process call from another use case, so M4-06 can add a shared pub/sub without moving boundaries. The contest load
   test (M2-07) measures Contest with one replica.
6. **Packaging.** By default each service is one deployable. If ADR-0004 or the FinOps model shows that resources are
   insufficient, several services may share one deployable, provided each keeps its own database, migrations and ports
   and they communicate only through the rules in §2.

## Trade-offs

- Four new services add processes, databases, migrations, gateway routes and pipelines to maintain. They also isolate
  failure (NFR-A04), give contest load its own process, and let capability owners work in parallel. The packaging rule
  limits the cost risk.
- Putting quiz in Problem keeps one moderation lifecycle but makes Problem the largest service. FRD-2 may revisit this
  when discussion arrives.
- Event-fed projections (Learning progress, Analytics) are eventually consistent: progress and KPIs lag events by
  seconds. Learning needs a one-time backfill.
- Premium changes made by an admin take up to one access-token lifetime to apply. Shortening the access-token lifetime
  would tighten this at the cost of more refreshes.
- A synchronous Submission → Contest check makes contest submissions depend on Contest. This is deliberate: a contest
  cannot run without its own service.

## Consequences

| Change | What it must do because of this ADR |
|---|---|
| M1-13 `fix-outbox-relay-delivery` | Moves the Submission relay to `pkg/` with the guarantees in §2 rule 2 and §5. Must merge before M1-07 and before the M2-07 fault-injection tests. |
| M1-04 `add-premium-entitlement` | Delta spec for `identity-session`: refresh carries the current entitlement; checkout returns new credentials. Gateway contract update (NON-BREAKING) for `X-User-Premium-Until`. `TrackAccess` and middleware support in `pkg/`. Access-matrix test with a locked-track fixture. |
| M1-06 `add-notification-event-contract` | Defines the events in §3 that M1 and M2 producers need, under ADR-0005. |
| M1-07 / M1-08 | Problem gains an outbox using the shared relay from M1-13 and publishes moderation and quiz events. |
| M1-10 `add-notifications-core` | Creates Notification with `notification_db`; digest via gRPC count; scheduled jobs follow §5. |
| M2-01 `add-contests` | Creates Contest with `contest_db`; Submission accepts an optional contest ID and calls Contest; Problem supports reserved visibility; Submission publishes the judged event. |
| M2-04 `add-learning-roadmaps` | Creates Learning with `learning_db`; consumes judged and quiz events; runs the backfill. |
| M3-04 `add-kpi-dashboard` | Creates Analytics with `analytics_db`; consumes the events in §3. |
| Every change adding a service | Gateway routes in `envoy/routes.json`, Compose entry, migrations per ADR-0006, health checks. |

Documentation:

- `frd.md` §2.2 records the owning services decided here, and FRD-1 is closed.
- `docs/codebase/TECH_DEBT.md` records that refresh copies the role from the presented token, so role changes apply
  only at the next sign-in (accepted, no fix planned), and the outbox relay defects that M1-13 fixes.
- `delivery-plan.md` adds M1-13 `fix-outbox-relay-delivery`; M1-07 depends on it.
- `application.md` and `data.md` (M0-15) describe the target structure from this ADR.
- PRD Appendix A receives the product rules agreed while preparing this ADR (contest problem visibility, rejection
  reason categories, digest and reminder timing) in a separate change.
