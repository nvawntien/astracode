# AstraCode — Team Workflow

| Field | Value |
|---|---|
| Document ID | WORKFLOW |
| Version | 0.1 |
| Owner | Orchestrator |
| Location | `docs/process/workflow.md` |
| Related | `AGENTS.md` (agent rules) · `docs/product/delivery-plan.md` · `.github/pull_request_template.md` |

> How the six of us and our coding agents (Claude Code and Codex) turn PRD features into merged, deployed,
> specified behaviour. Agent-side rules (session protocol, hard constraints) live in `AGENTS.md`; this document
> covers roles, gates, branches and cadence for humans.

## 1. Roles

| Role | Responsibility |
|---|---|
| Orchestrator | PRD/FRD/NFR, delivery plan, Gate 1 for cross-capability changes, workflow upkeep |
| Infra/CI owner | NFR, architecture docs for deployment/observability/cost, CI/CD, Azure, harness scripts |
| Change owner | Any member who picks up a change from the delivery plan; responsible from proposal to archive |
| Reviewer | A member other than the change owner; performs Gate 1 and Gate 2 |

Capability owners are not assigned yet; until they are, the Orchestrator reviews changes to hotspot capabilities
(membership, content-moderation, notification).

## 2. Documentation zones

| Zone | Content | Changed by | Read by agents |
|---|---|---|---|
| A — product | `docs/product/*` | Humans, by PR, on significant change only | Only as stated in the product-document rule in §8 (F-xx section at propose time; `nfr.md` for cited NFR IDs) |
| B — shared truth | `openspec/specs/*` (via archive only), `docs/architecture/*`, contracts, ADRs, `docs/codebase/*`, glossary | Change PRs, with doc-impact checklist | When relevant |
| C — agent harness | `AGENTS.md`, `CLAUDE.md`, `openspec/config.yaml`, module `AGENTS.md`, scripts | Humans, by PR | Every session |

## 3. Branches, environments and releases

The repository's existing release flow is kept:

```
feature/<change-id>  ──PR (Gate 2)──►  develop  ──auto-deploy──►  STAGING   (auto-deploy and staging: planned, M0-13)
                                         │
                              milestone release PR
                                         ▼
                                       main ──► tag vX.Y.Z ──► release images ──► manual deploy ──► PRODUCTION
```

- One change = one branch `feature/<change-id>` from `develop` = one git worktree per agent session.
- Gate 1 is a **draft PR** containing only the change folder (and contract files).
- Gate 2 is the same PR, ready for review.
- No deployment during a contest window (NFR-A06).

## 4. Change lifecycle

| # | Step | Who | Tool | Exit criterion |
|---|---|---|---|---|
| 1 | Pick the next unblocked change from the delivery plan; create/assign the GitHub issue | Change owner | GitHub | Dependencies archived |
| 2 | `git worktree add` on `feature/<change-id>` | Change owner | git | Clean worktree; `scripts/verify.sh` green |
| 3 | Propose: give the agent the F-xx user stories and acceptance (pasted from the PRD), related NFR IDs and ADRs; run the OpenSpec propose command | Change owner + agent | OpenSpec | `openspec validate <id> --strict` passes |
| 4 | **Gate 1 — spec review** (checklist §5) on a draft PR | Reviewer (Orchestrator for hotspots / cross-capability) | GitHub | Approved |
| 5 | Apply in sessions following the `AGENTS.md` protocol; update `progress.md` each session | Change owner + agent | OpenSpec apply | All tasks ticked with evidence; CI green |
| 6 | Cross-agent review: the **other** agent reviews the diff against the delta spec (Claude Code reviews Codex work and vice versa) | Change owner | Claude Code / Codex | Findings fixed or answered in the PR |
| 7 | **Gate 2 — PR review** (checklist §6) | Reviewer | GitHub | Approved; CI green |
| 8 | Merge to `develop` → auto-deploy to staging → smoke tests (planned: M0-13) | Pipeline | GitHub Actions | Staging healthy |
| 9 | Archive the change (specs updated) in a follow-up commit on `develop` | Change owner | OpenSpec archive | `openspec/specs` reflects the change |
| 10 | Close the issue | Change owner | GitHub | — |

### Change size

One verb-object title; 1–2 capabilities (max 3); 5–15 tasks; 1–4 days; one owner. Refactors are separate changes.

## 5. Gate 1 checklist — spec review

- [ ] Proposal states `Implements: F-xx | Addresses: NFR-xx | Follows: ADR-xxxx`.
- [ ] Scope matches the PRD feature; nothing added that the PRD does not ask for; non-goals respected.
- [ ] Delta specs describe behaviour only (no endpoints, tables, class names).
- [ ] Every scenario is testable.
- [ ] MODIFIED/REMOVED requirements exist in current specs; no conflict with another in-flight change (`openspec list`).
- [ ] Design respects referenced NFRs and ADRs.
- [ ] Interface changes include contract drafts marked BREAKING / NON-BREAKING.
- [ ] Size within limits; otherwise split.

## 6. Gate 2 checklist — PR review

- [ ] CI green: build, tests, `openspec validate`, lint, security scans.
- [ ] Every delta scenario is covered by a test or a recorded manual check (NFR-D09).
- [ ] Cross-agent review done; findings resolved.
- [ ] Doc-impact checklist in the PR template matches the diff.
- [ ] No secrets, no debug leftovers, no unrelated changes.
- [ ] Unfinished user-facing behaviour is behind a feature flag.

## 7. Definition of done (per change)

1. Gate 2 approved and merged to `develop`.
2. Deployed to staging and smoke-tested (planned: M0-13).
3. Change archived; specs updated.
4. Doc impact handled (architecture docs, contracts, ADRs).
5. Issue closed.

## 8. Agents: Claude Code and Codex

| Topic | Rule |
|---|---|
| Instructions | Both follow `AGENTS.md` (Codex reads it directly; Claude Code reads `CLAUDE.md`, which imports `AGENTS.md`). Agent-specific notes go only in `CLAUDE.md`. |
| OpenSpec commands | Installed for both tools by `openspec init`; regenerated with `openspec update` after upgrading OpenSpec. |
| Context | A session starts from `AGENTS.md`, the module `AGENTS.md`, if one exists, the change folder and `progress.md`; product documents: During implementation, do not read prd.md or frd.md. Read nfr.md only for the NFR IDs cited in the change. At propose time, use only the F-xx section given in the prompt. |
| Parallelism | One agent session per worktree; never two agents in one worktree. |
| Autonomous loops | Allowed only for changes with automated tests as the stop condition, with an iteration cap, on a feature branch, outside sandbox, authentication, outbox and production-deployment code. |
| Reviewing | The agent that wrote the code does not review it; the other tool does (step 6), then a human (Gate 2). |
| Secrets | Agents never receive production secrets or real user data. |

## 9. Changing product documents

- PRD/FRD/NFR change only when product scope or quality targets change, by PR reviewed by the Orchestrator.
- In-flight changes that reference an affected F-xx or NFR-xx are re-checked at their next gate.
- Product rules move from PRD Appendix A into specs when the first change of that capability is archived.

## 10. ADRs

- Any decision that is costly to reverse or affects several capabilities gets an ADR (`docs/architecture/adr/NNNN-title.md`).
- Status: Proposed → Accepted / Rejected; later Superseded by a newer ADR. Accepted ADRs are not edited.
- An ADR is reviewed like a change (draft PR, one reviewer).

## 11. Cadence

| When | What | Who |
|---|---|---|
| Daily (async) | Three lines: done / next / blocked, with change IDs | Everyone |
| Twice weekly | Gate 1 review slot | Reviewers |
| Weekly (30 min) | Delivery-plan review; cost burn check; one member runs the fresh-session test (a new agent session must answer: what is this system, how is it organized, how to run it, how to verify it, what is in progress) | Orchestrator + team |
| Milestone end | Release to production; `canvas.md` refresh; retro; prune outdated rules in `AGENTS.md` | Everyone |
