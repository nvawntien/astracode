# AstraCode — Delivery Plan

| Field | Value |
|---|---|
| Document ID | DELIVERY-PLAN |
| Version | 0.2 |
| Owner | Orchestrator |
| Location | `docs/product/delivery-plan.md` |
| Related | `prd.md` (features, milestones) · `frd.md` (capabilities) · `nfr.md` (enablers) · `../process/workflow.md` |

> **What this document holds:** the planned **changes** per milestone, what they implement, which capabilities they
> touch, and what they depend on. It holds **decisions only**.
>
> **What it does not hold:** status. Live status comes from OpenSpec (`openspec list` = in progress,
> `openspec/changes/archive/` = done) and the GitHub Project board. Tasks live in each change's `tasks.md`.
>
> **Who edits it:** the Orchestrator, during weekly planning, by PR. **Agents never edit this file.**

## Change types

| Type | Meaning |
|---|---|
| Harness | Agent harness, workflow and CI gates |
| Baseline | Records existing behaviour as specs (all requirements ADDED; no code change) |
| Enabler | Engineering work required by NFRs, not by a PRD feature |
| Feature | Implements a PRD feature |
| Content | Authoring content (e.g. readings), not code |
| ADR | Architecture decision (a document, reviewed like a change) |

Change IDs below are OpenSpec change names. Owner is assigned when the change is picked up.

---

## M0 — Foundation

Goal: harness working, current behaviour specified, existing platform running on Azure through the pipeline.

| ID | Change | Type | Implements | Capabilities | Depends on | Owner |
|---|---|---|---|---|---|---|
| M0-01 | `setup-agent-harness` — `openspec init` (Claude Code + Codex), merged `AGENTS.md`, `CLAUDE.md`, `openspec/config.yaml`, PR template, `openspec validate` in CI | Harness | NFR-D07 | — | — | TBD |
| M0-02 | `baseline-identity-session` | Baseline | — | identity-session | M0-01 | TBD |
| M0-03 | `baseline-user-profile-statistics` | Baseline | — | user-profile, statistics | M0-01 | TBD |
| M0-04 | `baseline-problem-catalog` | Baseline | — | problem-catalog | M0-01 | TBD |
| M0-05 | `baseline-content-moderation` (current contributor drafts, publish, hide) | Baseline | — | content-moderation | M0-01 | TBD |
| M0-06 | `baseline-submission` | Baseline | — | submission | M0-01 | TBD |
| M0-07 | `baseline-judging` | Baseline | — | judging | M0-01 | TBD |
| M0-08 | `baseline-realtime-updates` | Baseline | — | realtime-updates | M0-01 | TBD |
| M0-16 | `baseline-code-run` — custom runs from the editor (direct judge-worker path, outside the submission queue; results not stored as submissions) | Baseline | — | code-run | M0-01 | TBD |
| M0-09 | [ADR-0004](../architecture/adr/0004-azure-topology-and-subscription-layout.md) — Azure topology and subscription layout with an indicative budget sanity check. Measure the Azure/k3s footprint and initial costs at M0-13. | ADR | NFR-F01 | — | — | TBD |
| M0-10 | ADR-0005 API and event conventions (error format, event envelope, versioning, compatibility) | ADR | — | — | — | TBD |
| M0-11 | ADR-0006 Schema migration policy (replace runtime auto-migration) | ADR | NFR-D05 | — | — | TBD |
| M0-12 | ADR-0007 Service boundaries and data ownership for new capabilities | ADR | FRD-1 | all new | M0-02…M0-08, M0-16 | TBD |
| M0-13 | `azure-walking-skeleton` — IaC for staging, unchanged release deployed through the pipeline, health checks. At the checkpoint, measure Azure/k3s footprint and initial costs in S3 Testing, validate sizing and resource limits, and check provisioning in target subscriptions and regions as needed. | Enabler | NFR-D01, D02, D04, D06 | — | M0-09 | TBD |
| M0-14 | `observability-baseline` — centralized logs, health and basic service metrics on staging | Enabler | NFR-O01, O02 (partial) | — | M0-13 | TBD |
| M0-15 | Architecture docs v1: `deployment.md`, `finops.md`, `security.md` draft, `workload-capacity.md`, `application.md`, `data.md`, `canvas.md` | Enabler | — | — | M0-09, M0-12 | TBD |

## M1 — Community core and premium

Premium stays early (PRD D-17): every content feature from M1-07 onward enforces track access from its first version.

| ID | Change | Type | Implements | Capabilities | Depends on | Owner |
|---|---|---|---|---|---|---|
| M1-01 | `remove-contributor-role` — **pilot change** | Feature | F-01, F-03 | identity-session, content-moderation | M0-02, M0-05 | TBD |
| M1-02 | `add-versioned-migrations` | Enabler | NFR-D05 | all existing | M0-11 | TBD |
| M1-03 | `add-content-tracks` — required track attribute on content (`dsa`, `beyond-leetcode`); track-aware catalog | Feature | F-02 | problem-catalog | M0-04, M1-02 | TBD |
| M1-04 | `add-premium-entitlement` (minimal) — entitlement owned by Auth, 30-day expiry, admin grant/revoke with audit, mock checkout, entitlement propagated through the gateway as decided in ADR-0007 (contract change marked NON-BREAKING), `TrackAccess` check, catalog teasers, access-matrix test with a locked-track fixture | Feature | F-16, NFR-S03, S11 | membership, identity-session, problem-catalog | M1-03, M0-12 | TBD |
| M1-05 | ADR-0008 Feature-flag mechanism | ADR | NFR-D08 | — | — | TBD |
| M1-06 | `add-notification-event-contract` — **contracts first**: event envelope and event types for all producers | Feature | F-21 | notification (contract only) | M0-10 | TBD |
| M1-07 | `add-community-submission-lifecycle` — eligibility, auto pre-check, review queue, claim, decisions | Feature | F-03 | content-moderation | M1-01, M1-04, M1-06, M1-13 | TBD |
| M1-08 | `add-quizzes` — including quiz teasers and access-matrix rows | Feature | F-06 | quiz, content-moderation | M1-07 | TBD |
| M1-10 | `add-notifications-core` — in-app inbox, unread count, moderation outcomes, moderator digest, email channel (the contest reminder event is produced by M2-01) | Feature | F-21, NFR-R04 | notification, realtime-updates | M1-06, M1-11 | TBD |
| M1-11 | ADR-0009 Email delivery — reuse the existing Auth SMTP adapter or adopt a provider | ADR | F-21 | — | — | TBD |
| M1-12 | `seed-beyond-leetcode-pilot` — moderator-authored pilot content: ~5 problems, then ~10 quizzes | Content | F-16 | — | M1-04 (quizzes: M1-08) | TBD |
| M1-13 | `fix-outbox-relay-delivery` — shared outbox relay in `pkg/` (ADR-0007): row claiming, ordered publishing, time-based backoff, visible failed state with metric and alert; fixes head-of-line blocking and message loss on broker outage | Enabler | NFR-R01, A03 | submission | M0-12 | TBD |

## M2 — Competition and learning

| ID | Change | Type | Implements | Capabilities | Depends on | Owner |
|---|---|---|---|---|---|---|
| M2-01 | `add-contests` — scheduling, registration, window, ranking; problems from the DSA track only; contest reminder event | Feature | F-09 | contest, problem-catalog | M1-03, M1-10 | TBD |
| M2-02 | `add-contest-live-leaderboard` | Feature | F-09, NFR-P04 | contest, realtime-updates | M2-01 | TBD |
| M2-03 | `add-elo-rating` | Feature | F-10, NFR-R03 | rating, user-profile | M2-01 | TBD |
| M2-04 | `add-learning-roadmaps` (DSA track first) — progress, next-node recommendation, "Continue learning" block on the home page, roadmap teasers and access-matrix rows | Feature | F-15 | learning-roadmap | M1-03, M1-04, M1-08 | TBD |
| M2-05 | DSA readings: first set of node readings (also the corpus for the AI assistant) | Content | F-15, F-19 | — | M2-04 | TBD |
| M2-06 | `scale-judge-workers` — scaling by queue backlog; custom-run capacity isolated or limited so runs cannot starve contest submissions | Enabler | NFR-C02, C03, C06 | judging, code-run | M0-13, M0-16 | TBD |
| M2-07 | Contest load test + 10× analysis (evidence) | Enabler | NFR-C01, C05, P01–P04, R01 | — | M2-01, M2-06, M1-13 | TBD |
| M2-08 | `add-backups-and-dr` — daily external backups to S4 and a restore drill with S5 as the preferred target | Enabler | NFR-R07, R08 | — | M0-13 | TBD |
| M2-09 | ADR-0010 LLM provider and vector storage (AI preparation) | ADR | F-19 | — | — | TBD |
| M2-10 | `ai.md` v1 — corpus, retrieval, guardrails, evaluation design and evaluation set (AI preparation) | Enabler | F-19 | — | M2-05, M2-09 | TBD |
| M2-11 | Beyond LeetCode pilot roadmap ("OS basics") | Content | F-16, F-15 | — | M2-04, M1-12 | TBD |

## M3 — KPIs and production readiness

The last milestone of the Must features.

| ID | Change | Type | Implements | Capabilities | Depends on | Owner |
|---|---|---|---|---|---|---|
| M3-04 | `add-kpi-dashboard` — every PRD §2.4 KPI except AI usefulness (added with F-19) | Feature | F-20, NFR-O07 | kpi-analytics | M1-04, M1-10, M2-01, M2-04 | TBD |
| M3-05 | `add-slo-dashboards-and-alerts` | Enabler | NFR-A01–A03, O03–O05 | — | M0-14 | TBD |
| M3-06 | `harden-security` — rate limits, scans as release gates, access-matrix tests, audit log | Enabler | NFR-S01–S13 | — | M1-04 | TBD |
| M3-07 | Production always-on; drills (rollback, recreate, fault injection) | Enabler | NFR-D03, D04, A04 | — | M3-05 | TBD |

## M4 — Extensions (after Musts are demoable)

Order: the AI assistant first (M4-08, M4-09), then the other Should features, then Could features.

| ID | Change | Type | Implements | Capabilities | Depends on |
|---|---|---|---|---|---|
| M4-08 | `add-ai-assistant` — minimal scope (PRD F-19): access-aware retrieval, guardrails, rate and token limits, search fallback, request observability, helpful rating; adds the AI usefulness KPI | Feature | F-19, NFR-AI01–AI05, AI08, AI09, P06, A05, S13 | ai-assistant, kpi-analytics | M2-05, M2-10, M1-04, M3-04 |
| M4-09 | AI evaluation runs (≥ 2 configurations); AI outage and fault-injection drill | Enabler | NFR-AI06, AI07, A04, A05 | — | M4-08 |
| M4-10 | `add-follow` — including the "someone followed you" notification | Feature | F-12 | social-follow, user-profile, notification | M1-06, M1-10 |
| M4-11 | `add-discussion-posts` — posts, tags, likes, comments, reports, and their notifications | Feature | F-13 | discussion, content-moderation, notification | M1-07, M1-10 |
| M4-01 | `add-premium-discussion-tags` | Feature | F-14 | discussion | M4-11, M1-04 |
| M4-02 | `add-problem-leaderboard` | Feature | F-04 | problem-leaderboard | — |
| M4-03 | `add-xp-and-levels` | Feature | F-07 | gamification | — |
| M4-04 | `extend-profile-statistics` | Feature | F-11 | statistics, user-profile | — |
| M4-12 | `add-premium-expiry-notifications` — premium granted / about to expire (in-app + email) | Feature | F-16, F-21 (Should events) | notification, membership | M1-04, M1-10 |
| M4-05 | `add-dlt-replay` | Enabler | NFR-R06 | judging, submission | — |
| M4-06 | `add-multi-replica-realtime` | Enabler | NFR-C04 | realtime-updates | — |
| M4-07 | Could features: F-05, F-08, F-17 (full track), F-18, F-22 | Feature | — | — | — |

---

## Sequencing rules

1. Baselines before features: a feature change may not modify a capability whose baseline is not archived.
2. Contracts first: shared interfaces (notification events, membership checks) merge before their consumers.
3. One in-flight change per requirement: check `openspec list` before proposing.
4. Pilot first: no other M1 feature change starts before M1-01 has gone through both gates and been archived.
5. Enablers are not optional: each milestone's enablers count toward its completion like features.
6. Track access from the first version: every change that adds a content read path or submit path uses the
   `TrackAccess` check and adds its rows to the access-matrix test (NFR-S03).
7. Stable IDs: a change keeps its ID while it stays in its milestone; a change that moves to another milestone gets
   a new ID there, and the move is recorded in the PRD decision log.
