# AstraCode — Non-Functional Requirements (NFR)

| Field | Value |
|---|---|
| Document ID | NFR |
| Version | 0.1 (draft for team review) |
| Status | Draft |
| Owner | Infra/CI owner, with Orchestrator |
| Location | `docs/product/nfr.md` |
| Related | `prd.md` (KPIs, launch scenario) · `frd.md` (use cases) · `docs/architecture/*` (how each NFR is met) · `docs/evidence/*` (measured results) |

> **Scope of this document.** The NFR answers *how well* the system must work and *how we prove it*. Every NFR has
> a **target** and a **verification method**. It does **not** describe how targets are achieved (→ architecture docs
> and ADRs, which reference NFR IDs) and does **not** hold measured results (→ `docs/evidence/`).
>
> Targets are **proposals** sized for the launch scenario and the budget; they change only by PR. Priority:
> **Must** = verified before release-ready · **Should** = verified if time allows, otherwise explained.

---

## 1. Basis

### 1.1 Launch scenario (from PRD §2.4)

| Parameter | Value |
|---|---|
| Registered users after month 1 | 2,000 |
| Daily active users | ~300 |
| Weekly contest participants | up to 200 concurrent |

Conversion to request rates, peak factors and capacity is in `docs/architecture/workload-capacity.md`. The contest
load profile used for testing is defined in NFR-C01.

### 1.2 Constraints that shape the targets

- Budget: 5 student Azure subscriptions × ~$100, not poolable (PRD §1.3). A single-VM production environment is
  expected (topology ADR), so targets accept a single point of failure and avoid multi-zone or HA-database requirements.
- Course rubric: performance, scalability, reliability, security, observability, cost and AI evaluation must each be
  **demonstrated with evidence**, not only described.

### 1.3 Measurement windows

- Latency targets: measured under the load profile of NFR-C01 unless stated otherwise.
- SLOs (NFR-A01–A03): measured over rolling 30 days in production, from milestone M3 when production runs continuously.

---

## 2. Performance

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-P01 | Read APIs (catalog, problem page, quiz, profile, posts, roadmap) respond quickly | p95 ≤ 500 ms | k6 load test at launch load; APM latency dashboard | Must | F-02, F-06, F-11, F-13, F-15 |
| NFR-P02 | Write APIs (submit, answer quiz, post, comment, follow) acknowledge quickly; judging excluded | p95 ≤ 800 ms | k6 load test | Must | F-02, F-06, F-12, F-13 |
| NFR-P03 | Time from submission to verdict, for problems with time limit ≤ 2 s and ≤ 20 testcases | p95 ≤ 10 s normal load; p95 ≤ 30 s at contest peak (NFR-C01) | k6 contest scenario; trace submit→verdict | Must | F-02, F-09, UC-02, UC-04 |
| NFR-P04 | Contest leaderboard reflects an accepted submission | ≤ 10 s after verdict (p95) | Contest load test with leaderboard probe | Must | F-09, UC-04 |
| NFR-P05 | In-app notification appears after the triggering event | ≤ 10 s (p95) | Integration test + metric (event time → delivery time) | Should | F-21 |
| NFR-P06 | AI assistant returns a complete answer | p95 ≤ 8 s | AI eval run timings; production AI latency metric | Must | F-19, UC-06 |
| NFR-P07 | Main pages load quickly in the browser | Largest Contentful Paint p75 ≤ 2.5 s on desktop | Lighthouse in CI on key pages | Should | — |
| NFR-P09 | Custom run returns its result, for problems with time limit ≤ 2 s and user input ≤ 64 KB | p95 ≤ 5 s normal load | k6 scenario; trace | Should | F-02, UC-02 |
| NFR-P08 | Automatic pre-check completes | ≤ 2 min for a coding problem within package limits (NFR-S06) | Integration test with reference packages | Should | F-03, UC-01 |

---

## 3. Capacity and scalability

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-C01 | The system handles the **contest load profile**: 200 concurrent participants; 5 submissions/s sustained for 5 minutes at contest start and end, ~2 submissions/s otherwise; custom runs at the rate defined in `workload-capacity.md`; leaderboard viewers polling or subscribed | NFR-P01–P04 met; error rate ≤ 1%; no lost submissions | k6 contest scenario on a production-sized environment; results in `docs/evidence/load-tests/` | Must | F-09, UC-04 |
| NFR-C02 | Judge throughput scales horizontally: adding judge workers increases verdict throughput | Doubling workers ≥ 1.6× throughput on the contest profile | Load test at 1× and 2× workers | Must | F-09 |
| NFR-C03 | Judge scaling is driven by queue backlog, not CPU | Scaling rule/runbook uses consumer lag; documented threshold | Review of `reliability-observability.md`; load test shows lag recovery | Should | — |
| NFR-C04 | Application services are stateless: any replica can serve any request, including live updates | Live updates work with ≥ 2 replicas of the serving service | Integration test with 2 replicas | Should | F-09, F-21 |
| NFR-C05 | Behaviour at 10× load is understood | Documented analysis of bottlenecks at 10× and a stress test to the breaking point | `workload-capacity.md` + stress-test evidence | Must | — |
| NFR-C06 | Custom runs cannot starve official submissions at contest peak | Submission verdict latency still meets NFR-P03 with custom runs included in the load | Contest load test with mixed runs and submissions | Must | F-02, F-09 |

---

## 4. Availability and SLOs

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-A01 | SLO — core journeys available (site loads, sign-in, catalog, submit) | ≥ 99.5% per 30 days (error budget ≈ 3.6 h/month) | Synthetic probes every minute; SLO dashboard | Must | — |
| NFR-A02 | SLO — server errors | 5xx ≤ 1% of requests per 30 days | Gateway metrics; SLO dashboard | Must | — |
| NFR-A03 | SLO — judging completeness | ≥ 99.9% of submissions reach a final verdict or system-error status within 5 min | Metric: submissions without final state after 5 min | Must | F-02, F-09 |
| NFR-A04 | Graceful degradation: failure of the AI assistant, notifications, KPI analytics or problem leaderboards does not break sign-in, catalog, submit or judging | Core journeys keep working with each optional capability stopped | Fault-injection test (stop each optional component) | Must | F-19, F-20, F-21, F-04 |
| NFR-A05 | AI unavailability fallback: when the LLM call fails or exceeds the timeout, the assistant shows search results instead | Fallback shown within 15 s of the question | Test with LLM endpoint blocked | Must | F-19, UC-06 |
| NFR-A06 | No planned deployment or maintenance during a contest window | 0 deployments during contests | Pipeline check against contest schedule; deployment log | Must | F-09 |

---

## 5. Reliability and data integrity

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-R01 | No accepted submission request is silently lost, including during broker or worker restarts | 0 lost submissions in fault-injection tests | Kill worker / restart broker during load test; reconcile counts | Must | F-02, F-09 |
| NFR-R02 | Judge results are applied exactly once per attempt; stale and duplicate results are ignored | 0 double-applied or stale results | Duplicate-delivery test; existing attempt checks | Must | F-02 |
| NFR-R03 | Contest ranking and ratings are computed exactly once per contest; recomputation produces the same result | Idempotent rating job | Run rating job twice in test; compare | Must | F-10 |
| NFR-R04 | Each notification is delivered at most once per triggering event, even if the event is redelivered | 0 duplicates under redelivery | Redelivery test | Must | F-21 |
| NFR-R05 | XP is awarded at most once per user and item | 0 duplicate XP awards | Concurrency test (parallel accepted submissions) | Should | F-07 |
| NFR-R06 | Messages that fail after retries are kept in a dead-letter topic and can be replayed | Replay tool exists; replayed messages processed idempotently | Test: force failure → DLT → replay | Should | — |
| NFR-R07 | Recovery point objective (data loss after a disaster) | RPO ≤ 24 h | Daily backups of all databases and object storage, copied to a separate subscription | Must | — |
| NFR-R08 | Recovery time objective (time to restore service after losing the production environment) | RTO ≤ 4 h | Restore drill into the reserve subscription; evidence in `docs/evidence/` | Must | — |

---

## 6. Security and privacy

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-S01 | All non-public endpoints require an authenticated session | 100% of non-public routes | Automated route test with anonymous client | Must | F-01 |
| NFR-S02 | Authorization is enforced server-side: role checks (moderator/admin) and ownership checks on every write; no UI-only checks | 100% of write endpoints | Authorization test suite per role | Must | F-03, F-13 |
| NFR-S03 | **Premium entitlement is enforced on every read path**: pages and API, search, AI assistant retrieval and answers, notification previews, leaderboards, roadmap content. Users without access receive teasers only | 0 premium content leaks | Access-matrix test (free vs premium user on every path); AI red-team set (NFR-AI04) | Must | F-14, F-16, F-17, F-18, F-19, F-21 |
| NFR-S04 | Submission permissions (eligibility, track access, pending limit) are enforced server-side | 100% of submission endpoints | API tests bypassing the UI | Must | F-03, F-06 |
| NFR-S05 | All user and community code — submissions, custom runs, reference solutions, pre-checks — runs only in the sandbox with CPU, memory, time, process and output limits, and without network access | 100% of executions | Sandbox configuration review; abuse tests (fork bomb, infinite loop, network call) | Must | F-02, F-03 |
| NFR-S06 | Uploaded packages are validated: size, file count and format limits | Limits defined and enforced | Upload tests with oversized/malformed packages | Must | F-03 |
| NFR-S07 | Rate limits protect sign-in, submissions, custom runs, comments, content submissions and the AI assistant | Limits defined per endpoint; excess requests rejected | Load test hitting each limit | Must | F-01, F-13, F-19 |
| NFR-S08 | No secrets in the repository, images or logs; secrets stored in a secret manager and injected at runtime | 0 secrets found | Secret scanning in CI; image inspection | Must | — |
| NFR-S09 | Public traffic uses HTTPS only; databases, broker, cache and internal services are not reachable from the internet | 100% | External port scan; network rule review | Must | — |
| NFR-S10 | Dependencies and container images are scanned; critical vulnerabilities block release | 0 unwaived critical findings at release | CI scan reports | Must | — |
| NFR-S11 | Moderator and admin actions are audited (actor, action, target, time) | 100% of moderation and admin actions | Audit-log test | Must | F-03, F-16, UC-08 |
| NFR-S12 | Each service accesses only its own data store with least-privilege credentials | 100% of services | Credential/permission review | Should | — |
| NFR-S13 | Privacy: no personal data (email, name, account IDs) sent to the LLM provider; no passwords, tokens or personal data in logs | 0 violations | Log and prompt sampling review | Must | F-19 |

---

## 7. AI quality, safety and cost

Evaluation design, datasets and model/prompt strategy are owned by `docs/architecture/ai.md`; results go to
`docs/evidence/ai-eval/`. The evaluation set must contain normal questions, out-of-corpus questions, solution
requests, running-contest questions, premium-content probes and prompt-injection attempts.

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-AI01 | Every link in an answer points to an existing page the user can access | 100% | Automatic link validation on eval set and in production | Must | F-19 |
| NFR-AI02 | Answers are correct and relevant to in-corpus questions | ≥ 80% judged correct and relevant | Eval set scored by LLM judge with human spot-check of ≥ 20% | Must | F-19 |
| NFR-AI03 | The assistant abstains on out-of-corpus questions | ≥ 90% abstention on the out-of-corpus subset | Eval set | Must | F-19 |
| NFR-AI04 | Guardrails hold: no solutions, no premium content without entitlement, refusal for running-contest problems | 0 violations on the red-team subset | Eval set | Must | F-19 |
| NFR-AI05 | Prompt-injection attempts do not change assistant behaviour | 0 policy violations on the injection subset | Eval set | Must | F-19 |
| NFR-AI06 | At least two configurations (e.g. models, retrieval settings) are compared before choosing one | Comparison report with metrics above | `docs/evidence/ai-eval/` | Must | F-19 |
| NFR-AI07 | Any change to model, prompt or retrieval is regression-evaluated before release | Eval run attached to the change | Gate 2 checklist | Must | F-19 |
| NFR-AI08 | Token use per answer is bounded | Average ≤ 3,000 input and ≤ 400 output tokens; per-user limit on questions per day | AI usage metrics | Must | F-19 |
| NFR-AI09 | Each AI request is observable: model, prompt version, retrieved items, tokens, latency, outcome, user feedback | 100% of requests | Trace/log sampling | Must | F-19, F-20 |

---

## 8. Observability

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-O01 | Structured logs with a correlation ID that follows a request across gateway, services, broker and judge worker | 100% of services | Trace one submission end-to-end by ID | Must | — |
| NFR-O02 | Metrics for the four golden signals (latency, traffic, errors, saturation) per service, plus broker consumer lag and judge throughput | All services | Dashboard review | Must | — |
| NFR-O03 | Distributed tracing on the submit → verdict path and the AI assistant path | Both paths traced | Trace screenshots in evidence | Must | UC-02, UC-06 |
| NFR-O04 | Dashboards: SLOs, contest operations, business KPIs (PRD §2.4), cost | 4 dashboards | Evidence screenshots | Must | F-20 |
| NFR-O05 | Alerts reach the team for: SLO burn, error-rate spikes, judge backlog, disk/memory saturation, budget thresholds | Each alert tested once | Alert test log | Must | — |
| NFR-O06 | During an incident the team can answer within 5 minutes: is the system healthy, are users affected, which component fails, since when, what changed | Answered in a game-day exercise | Game-day record in evidence | Should | — |
| NFR-O07 | Every business KPI in PRD §2.4 can be computed from collected data | 100% of KPIs | KPI dashboard review | Must | F-20 |

---

## 9. Deployability and maintainability

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-D01 | Every merge to the main branch is built, deployed to staging and smoke-tested automatically | 100% of merges | Pipeline history | Must | — |
| NFR-D02 | Production runs the same immutable image that passed staging; promotion requires manual approval | 100% of releases | Pipeline history | Must | — |
| NFR-D03 | Rollback to the previous release | ≤ 15 min | Rollback drill | Must | — |
| NFR-D04 | All cloud infrastructure is defined as code; a complete environment can be recreated in another subscription | ≤ 2 h from empty subscription to running stack | Recreation drill | Must | — |
| NFR-D05 | Database schema changes use versioned, backward-compatible migrations (no runtime auto-migration in production) | 100% of schema changes | CI check; migration review | Must | — |
| NFR-D06 | Configuration is externalized; the same image runs in every environment | 100% of services | Image/config review | Must | — |
| NFR-D07 | CI gates every pull request: build, tests, spec validation, lint, security scans; a failing gate blocks merge | 100% of PRs | Branch protection settings | Must | — |
| NFR-D08 | Unfinished features are deployable but switched off via feature flags | All in-progress Must features | Flag inventory | Should | — |
| NFR-D09 | Every spec scenario of a changed capability is covered by an automated test or a recorded manual check | 100% per change | Gate 2 checklist | Must | — |

---

## 10. Cost (FinOps)

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-F01 | Spend stays within credits | Each subscription ≤ its ~$100 credit for the semester; burn rate tracked weekly | Azure cost reports; `finops.md` | Must | — |
| NFR-F02 | Budget alerts on every subscription | Alerts at 50%, 80%, 100% | Alert configuration review | Must | — |
| NFR-F03 | Non-production compute stops outside working hours | Staging off ≥ 12 h/day | Schedule configuration; cost report | Must | — |
| NFR-F04 | Unit costs are reported | Cost per 1,000 submissions, per contest, per AI answer, per active user | `finops.md` | Must | F-20 |
| NFR-F05 | Cost at 5× the launch scenario is estimated | Documented estimate with top 3 cost drivers | `finops.md` | Must | — |

---

## 11. Usability and compatibility

| ID | Requirement | Target | Verification | Priority | Related |
|---|---|---|---|---|---|
| NFR-U01 | Responsive web interface | Usable from 360 px width | Manual check on key pages | Should | — |
| NFR-U02 | Supported browsers | Latest two versions of Chrome, Edge, Firefox, Safari | Manual smoke test | Should | — |
| NFR-U03 | Languages | UI in English; AI assistant answers in English and Vietnamese | Eval set includes both languages | Must | F-19 |

---

## 12. Out of scope

- Multi-region deployment and multi-zone redundancy.
- Zero-downtime deployments (short maintenance windows outside contests are accepted).
- High-availability (replicated) databases; production availability above 99.5%.
- Payment-security compliance (no real payments).
- Formal accessibility certification.

---

## 13. Verification summary

| Evidence | Location | Covers |
|---|---|---|
| Load and stress tests | `docs/evidence/load-tests/` | P01–P04, P09, C01, C02, C05, C06, R01, S07 |
| Fault-injection and drills (worker kill, AI outage, rollback, restore, recreate) | `docs/evidence/drills/` | A04, A05, R01, R06, R08, D03, D04 |
| AI evaluation reports | `docs/evidence/ai-eval/` | P06, AI01–AI08, S03 (AI path), U03 |
| Security scans and access-matrix tests | CI reports; `docs/evidence/security/` | S01–S13 |
| Dashboards and alert tests | `docs/evidence/dashboards/` | A01–A03, O01–O07, F02 |
| Cost reports | `finops.md` | F01–F05 |
