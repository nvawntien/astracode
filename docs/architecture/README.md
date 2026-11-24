# docs/architecture — index

> System-level documents: **how AstraCode is built and run**. Product intent lives in `docs/product/`
> (PRD, FRD, NFR); behaviour lives in `openspec/specs/`; measured results live in `docs/evidence/`.
> Each document below owns one concern, references NFR IDs instead of restating targets, and is updated through
> the doc-impact checklist of the PR that changes it.

## Documents

| Document | Status | Responsibility (owns) | Must NOT contain | First needed | Updated when | Course part |
|---|---|---|---|---|---|---|
| `adr/NNNN-*.md` | Planned | One decision each: context, options, decision, trade-offs, consequences. Immutable once accepted; superseded by a new ADR | Anything not about that decision | **M0** (topology, conventions, migrations) | A new decision is taken | P1–P5 |
| `workload-capacity.md` | Planned | Launch scenario → average/peak request rates → contest load profile → capacity per component, headroom, 10× analysis | Targets (→ NFR), measured results (→ evidence) | **M0** (rates); capacity after the stack footprint is measured | Load-test results change assumptions | P1, P4 |
| `deployment.md` | Planned | Environments (dev, staging, production), branch and release flow, CI/CD pipeline, registry, IaC layout, App/Judge node topology, feature flags, rollback, schema migration procedure, deployment freeze | Security controls (→ security.md), cost (→ finops.md) | **M0** (walking skeleton) | Pipeline or topology changes | P3 |
| `finops.md` | Planned | Subscription layout and purpose, cost model per environment, burn rate vs credit, unit costs, 5× estimate, cost controls | Targets (→ NFR-F) | **M0** (first model from measured footprint) | Weekly burn review; new paid resource | P4, P5 |
| `security.md` | Planned | Threat model (asset → threat → control, top risks), authentication/authorization model (roles vs entitlement), premium enforcement points, sandbox isolation, secrets, network segmentation, scanning, audit | Requirement text (→ NFR-S) | **M0** draft; expanded in M1 (community content, premium) and with F-19 (AI, M4) | New attack surface (new endpoint type, new external system) | P3, P5 |
| `application.md` | Planned | Component diagram, responsibilities, service boundaries, sync vs async decisions, failure handling per dependency (timeouts, retries, fallbacks) | Data schemas (→ data.md), event schemas (→ contracts/) | **End of M0**, after baseline specs and the service-boundary ADR | A change adds/moves a component or dependency | P2 |
| `data.md` | Planned | Data model (conceptual), data ownership per service, database selection, object storage, cache strategy (what, TTL, invalidation) | Column-level schema (code/migrations own it) | **End of M0** | New entity or ownership change | P2 |
| `integration-events.md` | Planned | Event model (topics, envelope, producers, consumers), outbox/idempotency rules, retry and dead-letter handling, external systems (email, LLM API) | Message field definitions (→ contracts/) | **M1** (notification event contract is the first consumer) | New event or external system | P2 |
| `contracts/` | Planned | Machine-readable interfaces: REST (OpenAPI), gRPC (`proto/`), event schemas; `README.md` indexes them and states compatibility/versioning rules | Behaviour rules (→ specs) | **M1**, first contracts-first change | Every interface change (marked BREAKING / NON-BREAKING) | P2 |
| `reliability-observability.md` | Planned | Scaling strategy (judge workers by queue backlog), single points of failure, DR procedure (backup/restore, RTO/RPO mechanism), logs/metrics/traces, dashboards, alerts, SLO measurement, KPI measurement | Targets (→ NFR-A/R/O) | **M0** basic (health, logs); **M2** scaling; **M3** SLOs, alerts, DR | Monitoring or scaling changes | P4 |
| `ai.md` | Planned | AI use-case definition, architecture (retrieval + generation), corpus and access-aware retrieval, prompt/model strategy and versioning, guardrails, evaluation design and datasets, AI observability, token cost model, failure/fallback | Targets (→ NFR-AI) | **M2** (corpus design and evaluation set while readings are authored); full before the F-19 change in M4 | Model, prompt or retrieval change | P5 |
| `canvas.md` | Planned | One-page Architecture Canvas (business, users, requirements, NFR, workload, data, architecture, cloud, security, cost): one line per box + link to the owning document | Facts of its own | First version **end of M0**; refreshed at each milestone end | Milestone end | P1 |

Existing source-grounded notes in `docs/codebase/` (OVERVIEW, ARCHITECTURE, SERVICES, DOMAIN, DATA, FLOWS,
CONCURRENCY, DEVELOPMENT, TECH_DEBT) and `docs/DEPLOYMENT.md` remain the code-level reference. The documents above
**link to them** rather than repeating them, and add the target state and decisions.

## How they are used

| Who | How |
|---|---|
| Agents | Routed from `AGENTS.md` ("where to look") only when the task touches that concern. A change's `design.md` cites the relevant document and NFR IDs; if the change alters the concern, the same PR updates the document. |
| Change owners | Doc-impact checklist in the PR template forces the update (structure → application.md / ADR, data → data.md, interface → contracts/, deployment → deployment.md, new attack surface → security.md). |
| Reviewers | Gate 2 checks that the doc-impact boxes match the diff. |
| Graders | `canvas.md` is the entry point; each canvas box links to its owning document; each NFR links to its evidence. |

## Rule of thumb

- A **target** is in `nfr.md`; **how** we meet it is here; **proof** is in `docs/evidence/`.
- A **behaviour** is in a spec; a **decision** is in an ADR; a **structure** is here.
