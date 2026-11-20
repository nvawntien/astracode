---
change: baseline-content-moderation
round: 1
max_rounds: 3
reviewed_commit: 770abaebe302db56c956d0747eb31d5134cbc5c7
status: approved
---

## Round 1 findings

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | proposal.md: "OQ-1 — Explicitly inactive tag creation" | The code answers this. `createTagUseCase.Execute` (`services/problem/internal/application/usecase/admin/tag/create_tag.go:41-51`) sets `tag.IsActive = false` when the caller explicitly requests it, but `tagRepository.Create` (`services/problem/internal/adapter/outbound/persistence/postgres/tag.go:49-61`) passes the whole DAO to `gorm.Create` and only copies `ID`/`CreatedAt`/`UpdatedAt` back onto the entity (`tag.go:58-61`). `TagDAO.IsActive` is tagged `gorm:"not null;default:true;index"` (`tag.go:21`); GORM's default-value handling replaces a zero-value (`false`) field with its parsed literal default (`true`) in the INSERT when the field equals its Go zero value, so an explicitly-inactive creation persists as active while the returned response still shows the caller-supplied `false` (never reloaded). | OQ-1 can be resolved: explicitly inactive tag creation does **not** remain inactive after a database reload; the create response is stale. This is inferred from GORM's documented default-value substitution rather than a runtime persistence test, so a real DB check would still make it conclusive, but the baseline can state the mechanism instead of leaving it fully open. |
| 1.2 | minor | design.md Evidence rows for CM-09, CM-11, CM-13, CM-14 | `updateProblemUseCase`, `deleteProblemUseCase`, `publishProblemUseCase`, and `hiddenProblemUseCase` all call `invalidateSubmissionProblemCache` (`services/problem/internal/application/usecase/admin/problem/submission_cache.go:9-19`) after a successful mutation, via the `NewCached*UseCase` constructors wired by the service. None of the four Evidence rows, and no requirement in `spec.md`, mentions this best-effort Redis cache-invalidation side effect. | Not a blocking omission (it's a performance side effect, not an authorization/ownership/visibility rule), but worth a one-line mention in design.md's Evidence or Risks if a later round touches these requirements. |

## Round 1 author response

| # | Action | Note |
|---|---|---|
| 1.1 | fixed | Recorded the inactive-create response/persistence mismatch in CM-22, its evidence and proposal findings, qualified as source inference without a database check. |
| 1.2 | fixed | Added the wired best-effort cache invalidation side effect to design risks, covering update, delete, publish and hide. |
