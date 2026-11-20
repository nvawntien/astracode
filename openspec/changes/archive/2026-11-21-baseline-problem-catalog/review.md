---
change: baseline-problem-catalog
round: 1
max_rounds: 3
reviewed_commit: 9f3fb58b4ca8d8c6536d7a0ae3025d8848ab3035
status: approved
---

## Round 1 findings

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| — | — | — | No blocking or minor findings. | — |

### Verification performed

- `openspec validate baseline-problem-catalog --strict` → `Change 'baseline-problem-catalog' is valid`.
- `spec.md` has 24 ADDED requirements and 50 WHEN/THEN scenarios; `design.md`'s Evidence table has exactly one matching row per requirement (PC-01–PC-24), consistent with `progress.md`'s reported evidence-audit counts.
- Every requirement and every scenario was traced to the cited file/function and confirmed true of the code, including the security-sensitive role checks (own-catalog, staff-catalog, privileged individual read, internal gRPC metadata read, taxonomy administration):
  - PC-01–PC-08 (public visibility, slug lookup, pagination, ordering/totals, difficulty, search, tag filter, combined filters): confirmed against `router.go`, `list_problems.go`/`get_problem.go` (user), `problem.go` (`applyFilters`, `filterProblemIDsByTagSlug`, `escapeLikePattern`), `dto/problem.go` binding tags, and `pkg/response/handle.go`.
  - PC-09–PC-13 (identity/metadata, statement structure incl. legacy example-output fallback in `ExamplesJSON.Scan`, limits, public/private separation, attached-tag representation): confirmed against `mappers.go`, `problem.go`, `tag.go`, `dto/problem.go`, `dto/tag.go`.
  - PC-14–PC-18 (public tag directory, own-catalog, staff-catalog, privileged individual read, internal metadata read incl. distinct invalid-input/unauthenticated/forbidden gRPC codes and the 5s cache TTL): confirmed against `tag.go`, `list_my_problems.go`, admin `list_problems.go`/`get_problem.go`, `usecase/problem/get_problem.go`, the gRPC handler, and `pkg/rbac/role.go`.
  - PC-19–PC-24 (taxonomy admin access, default-active creation + slug uniqueness, selective updates, text validation/slug normalization, protected deactivation, curated seeding): confirmed against `admin/tag/*.go`, `shared.go`, `tag.go`, `dto/tag.go`, `entity/tag.go`, `seed/tags/seed.go`, `seed/tags/tags.go`.
- Boundary check against `docs/process/templates/baseline-prompt.md`: all 24 requirements fall under `problem-catalog`'s in-scope list (read visibility incl. own/staff exceptions, tag taxonomy). No requirement specifies draft authoring, testcase upload, or publish/hide (content-moderation); those are referenced by name only, per `proposal.md`'s "Scope boundaries".
- `spec.md` contains no endpoints, file/class names, or other implementation identifiers (checked by pattern search).
- Scope: `git show --stat 9f3fb58` touches exactly the 6 files under `openspec/changes/baseline-problem-catalog/` — no code, main specs, or other changes modified.
- `envoy/routes.json` declares `GET /api/v1/problems`, `/api/v1/problems/{slug}`, `/api/v1/tags` with `"auth": false, "authorization": "Public"`, consistent with PC-01's no-entitlement-check claim.
- Finding 5 (GORM `default:true` + missing `IsActive` copy-back in `tagRepository.Create`) was independently verified at `services/problem/internal/adapter/outbound/persistence/postgres/tag.go:21,47-60`: the bug is real as described, and correctly kept out of PC-20's normative text (PC-20 only asserts the omitted-activation/default-active case, where the zero-value quirk doesn't trigger). Q1–Q3 in `proposal.md` require database execution, a deployed environment, or a product decision respectively — none answerable from source, correctly left open.
- No service-local `AGENTS.md`/`CLAUDE.md` exists under `services/problem/` or `openspec/`, consistent with `design.md`'s claim.

No author response table — this is round 1, no prior findings exist.

STATUS: approved
