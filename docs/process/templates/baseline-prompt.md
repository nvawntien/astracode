# Baseline change prompt (template)

Location: `docs/process/templates/baseline-prompt.md`. Copy the prompt, fill the `<…>` fields from the boundary
table, and run it in a fresh agent session inside the change's own worktree.

## Prompt

```text
Use the OpenSpec propose workflow to create the change `baseline-<capability>`.

Goal: record the CURRENT behaviour of the capability `<capability>` as it exists in the code today.
This is a baseline: every requirement is ADDED; there is NO code change.

In scope (this capability owns): <in-scope list from the boundary table>
Out of scope (owned by other baselines — do not specify, only reference by name): <out-of-scope list>

Sources to read: <code paths>, docs/codebase/<relevant files>, the AGENTS.md of the touched modules, if one exists.
Read code to confirm every behaviour; documentation alone is not evidence.

Rules:
1. Behaviour only: requirements with SHALL and WHEN/THEN scenarios. No endpoints, tables, class or file names in spec.md.
2. In design.md, add an "Evidence" table: one row per requirement → file path and function/handler that implements it.
3. If you cannot confirm a behaviour from the code, do not write it as a requirement. List it under "Open questions" in proposal.md.
4. Describe what the code does, not what it should do. If you find a likely bug, keep the requirement truthful and list the bug under "Findings" in proposal.md.
5. Keep the spec under ~25 requirements. Use terms from docs/process/glossary.md.
6. tasks.md contains review tasks only: verify evidence for each requirement group, answer open questions, run `openspec validate baseline-<capability> --strict`.
7. Modify nothing outside openspec/changes/baseline-<capability>/. Do not edit docs/, code, or other changes.
8. Finish by running `openspec validate baseline-<capability> --strict` and report the result.
```

## Boundary table

Draft boundaries from the README and `docs/codebase/*`; the reviewer of each baseline confirms them against the code.

| Change | Capability | In scope | Out of scope (owner) | Code paths |
|---|---|---|---|---|
| M0-02 `baseline-identity-session` | identity-session | Registration, email verification, sign-in, refresh, logout, logout-all, password reset/change, roles and role checks, suspension, session invalidation | Public profile, user search, avatar (user-profile) | `services/auth/`, `gateway/` (JWT validation) |
| M0-03 `baseline-user-profile-statistics` | user-profile, statistics | Public profile, user search (active, non-suspended), profile media; solved/attempted totals, verdict and language distributions, 365-day activity | Submission history and detail (submission) | `services/auth/` (profile), `services/submission/` (statistics) |
| M0-04 `baseline-problem-catalog` | problem-catalog | Public catalog listing, search, filters, tags, difficulty, limits, statement structure, who can see which problems, tag taxonomy | Draft authoring, testcase upload, publish/hide (content-moderation) | `services/problem/` |
| M0-05 `baseline-content-moderation` | content-moderation | Contributor drafts and ownership, structured authoring, testcase package management for drafts, publish, hide, admin catalog actions | Catalog read behaviour (problem-catalog) | `services/problem/`, `website/` (contributor workspace, admin console) |
| M0-06 `baseline-submission` | submission | Creating a submission (validation, problem access), attempts, history, detail, rejudge, applying results (current attempt only; stale/duplicate ignored) | Execution (judging); live push (realtime-updates) | `services/submission/` |
| M0-07 `baseline-judging` | judging | Job consumption, testcase retrieval, compile and execute with limits, verdict determination, supported languages, retries and dead-letter | Custom runs (code-run); result application (submission) | `workers/judge/`, `build/sandbox/` |
| M0-08 `baseline-realtime-updates` | realtime-updates | Live status stream: who can subscribe, which events are pushed, when (after commit) | Verdict computation (judging, submission) | `services/submission/` (SSE), `envoy/` |
| M0-16 `baseline-code-run` | code-run | Custom run request, input limits, execution path, returned result, not stored as a submission | Official judging (judging) | `workers/judge/` (run-code service) |

## Running baselines in parallel

- One worktree and one agent session per baseline; branches `feature/baseline-<capability>`.
- Collisions are not expected: each change writes only its own folder `openspec/changes/baseline-<capability>/` and a distinct spec domain.
- The real risk is **overlap**, two baselines specifying the same behaviour. The boundary table prevents it; reviewers reject requirements that belong to another capability.
- Alternate tools: write half the baselines with Claude Code and half with Codex; cross-review evidence with the other tool.
- Archive in any order; the spec domains are disjoint.
