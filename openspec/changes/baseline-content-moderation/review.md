---
change: baseline-content-moderation
round: 2
max_rounds: 3
reviewed_commit: 1791a719d6b6baf484d54afb364649acd06a4a46
status: approved
---

## Round 2 ownership review

Compared the incoming M0-05 text with `origin/feature/baseline-problem-catalog` at `a248892441e3e633ec07ba4776509594f51ebdf8`. The Problem service, shared helpers, and website had identical source on those two revisions. Evidence below uses the Problem service's `internal/` paths unless indicated otherwise.

| Requirements | Handler, use case, repository, and test evidence | Verdict and M0-05 disposition |
|---|---|---|
| PC-15 / CM-04 | `ListMyProblemsHandler.Handle` binds the shared query and claims. `listMyProblemsUseCase.Execute` passes the actor to `ListByAuthor` and `CountByAuthor`. Both use GORM's live-row scope and the same filters; tag lookup accepts inactive tags. `TestListMyProblemsRoleAndOwnershipMatrix` checks the role and author argument with a fake repository. | Duplicate backend own-list contract, including the shared rules PC-03–PC-06 and PC-08. CM-04 now describes the Contributor Workspace's Draft/Published labels and the links each state offers. |
| PC-16 / CM-12 | `ListProblemsHandler.Handle` binds the shared query and claims. The staff `listProblemsUseCase.Execute` calls `List` and `Count` with hidden inclusion and maps private fields. `TestAdminListRequiresModerator` and `TestModeratorAdminRoutesRoleMatrix` exercise access checks. | Duplicate backend staff-list contract, including the shared list rules. CM-12 now describes the Admin Console role gate and its Open, Delete, Publish, and Hide actions. |
| PC-19 / CM-21 and CM-01 | `ListTagsHandler.Handle` and the tag mutation handlers are Moderator-gated. `listTagsUseCase.Execute` uses `ListAll` and `MapTagToAdminResponse` for the full ordered inventory. `TestAdminTagListRequiresModerator`, `TestTagMutationRoleMatrix` and the router role matrix cover authorization. | Duplicate taxonomy access and inventory. Removed CM-21 and the taxonomy and staff-list clauses in CM-01. |
| PC-20 / CM-22 | `CreateTagHandler.Handle` binds `CreateTagRequest`. `createTagUseCase.Execute` defaults activation to true and maps the create result. `tagRepository.Create` writes the DAO and maps a slug uniqueness conflict. The role test creates via a fake; the focused PostgreSQL probe covers the activation cases. | Default-active creation and slug conflicts duplicate PC-20. Explicitly inactive creation was an additional defect claim, now a finding without a SHALL. |
| PC-21 / CM-22 | `UpdateTagHandler.Handle` binds the optional fields; `updateTagUseCase.Execute` applies them, uses `tagRepository.Update`, and rereads with `GetByID`. The role test checks the update path with a fake. | Duplicate selective edits and reactivation. Removed from CM-22. |
| PC-22 / CM-22 | The create/update handlers bind `dto/tag.go` length constraints; normalization and blank-name rejection run in the use cases via helpers in `application/usecase/admin/tag/shared.go`. The role test covers write access. | Duplicate text and slug normalization. Removed from CM-22. |
| PC-23 / CM-23 | `DeleteTagHandler.Handle` and `UpdateTagHandler.Handle` invoke use cases sharing `ensureTagCanBeDeactivated`. `CountPublishedProblemsByTagID` excludes deleted problems; `Deactivate` and `Update` retain associations. The role test's fake reports zero usage. | Duplicate deactivation and Published-usage guard. Removed CM-23. CM-10 and CM-13 retain the separate assignment and publication decisions. |
| PC-17 / CM-05 | `GetProblemHandler.Handle`, `getProblemUseCase.Execute`, and `GetByID` implement privileged problem reads. `TestGetProblemRoleAndOwnershipMatrix` covers access. | Narrowed CM-05 to editing/deletion permissions. CM-15 and CM-19 retain distinct package metadata behavior. |

## Round 2 inactive-tag result

**CONFIRMED on isolated PostgreSQL 15.6.** The Problem tests have no PostgreSQL tag-create round trip. The role tests use a fake tag repository and seeding tests use an in-memory repository.

1. `adapter/inbound/http/handler/admin/tag/create_tag.go:18–20` uses `HandleWithClaims`, which binds JSON before invoking the use case. `application/dto/tag.go:29–34` declares `IsActive *bool` without a binding constraint, so explicit false is accepted and remains distinct from omission.
2. `application/usecase/admin/tag/create_tag.go:41–53` dereferences the non-nil pointer and builds the entity with false. `adapter/outbound/persistence/postgres/tag.go:154–163` copies it to the DAO's plain bool. Its `default:true` tag is at line 21.
3. GORM's create documentation describes defaults for zero values. The installed v1.31.1 `schema/field.go:235–239` parses the default to true and `callbacks/create.go:337–344` substitutes it for the zero field in the bound INSERT. The probe observed the DAO and the INSERT values through GORM callbacks.
4. `tagRepository.Create` copies only ID and timestamps back (lines 47–59). `application/usecase/mappers.go:118–124` reads activation from the original entity. `GetByID` and `toTagEntity` reread activation from the stored DAO.

The focused Go probe drove the real handler with fixture Moderator claims, the real create use case, and the PostgreSQL repository. It ran in the locally cached `postgres:15.6-alpine` image with `--rm --pull never --network none`, temporary data, and only the probe binary mounted read-only. It observed the following values.

| Request | HTTP | DAO entering GORM | INSERT value | Response | Direct PostgreSQL SELECT | Repository reread |
|---|---:|---|---|---|---|---|
| Explicit `is_active=false` | 201 | false | true | false | true | true |
| Omitted activation | 201 | true | true | true | true | true |

[GORM create defaults](https://gorm.io/docs/create.html#Default-Values) · [GORM v1.31.1 create callback](https://github.com/go-gorm/gorm/blob/v1.31.1/callbacks/create.go#L337-L348)

## Round 2 moderation review

| Requirements | Review evidence |
|---|---|
| CM-01–CM-05, CM-11–CM-12 | Router and use-case role checks, author from claims, forced hidden creation, hidden-only Contributor mutation, soft deletion without package cleanup, and both website role gates. The role/ownership matrices and `roles.test.ts` exercise their covered checks. |
| CM-06–CM-10 | Binding and normalization, legacy expected-output fallback, ordered structured fields, browser validation and initial limits, slug lookup and uniqueness mapping, sequential partial edits, and transactional problem-tag association writes. |
| CM-13–CM-14 | Staff-only transitions, inactive-tag check before publish, absence of package/pre-check dependencies, and hidden state enabling author mutations again. Cache invalidation after a successful mutation remains best effort. |
| CM-15–CM-20 | Owner/staff permission branches, structural ZIP validation and declared-size check, sequential versioning and best-effort cleanup, redacted metadata and absence, and storage removal before metadata deletion. The three testcase access matrices and metadata serialization test corroborate the covered branches. |
| CM-24 | Form, list, and package-manager guards and confirmations, mutation feedback, detail/list refresh, and navigation after creation. Package success feedback follows the awaited detail reload. |

The remaining findings are non-blocking for the documentation baseline. The inactive-create defect and execution-limit mismatch affect current behavior. Package payload integrity, concurrent replacement and partial-failure recovery, and reuse of a soft-deleted slug have the evidence limits recorded in the proposal. The final gate results are recorded in `progress.md`.

## Round 1 findings

Historical findings for the incoming revision. Round 2 supersedes the inactive-tag disposition.

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | proposal.md: "OQ-1 — Explicitly inactive tag creation" | The code answers this. `createTagUseCase.Execute` (`services/problem/internal/application/usecase/admin/tag/create_tag.go:41-51`) sets `tag.IsActive = false` when the caller explicitly requests it, but `tagRepository.Create` (`services/problem/internal/adapter/outbound/persistence/postgres/tag.go:49-61`) passes the whole DAO to `gorm.Create` and only copies `ID`/`CreatedAt`/`UpdatedAt` back onto the entity (`tag.go:58-61`). `TagDAO.IsActive` is tagged `gorm:"not null;default:true;index"` (`tag.go:21`); GORM's default-value handling replaces a zero-value (`false`) field with its parsed literal default (`true`) in the INSERT when the field equals its Go zero value, so an explicitly-inactive creation persists as active while the returned response still shows the caller-supplied `false` (never reloaded). | OQ-1 can be resolved: explicitly inactive tag creation does **not** remain inactive after a database reload; the create response is stale. This is inferred from GORM's documented default-value substitution rather than a runtime persistence test, so a real DB check would still make it conclusive, but the baseline can state the mechanism instead of leaving it fully open. |
| 1.2 | minor | design.md Evidence rows for CM-09, CM-11, CM-13, CM-14 | `updateProblemUseCase`, `deleteProblemUseCase`, `publishProblemUseCase`, and `hiddenProblemUseCase` all call `invalidateSubmissionProblemCache` (`services/problem/internal/application/usecase/admin/problem/submission_cache.go:9-19`) after a successful mutation, via the `NewCached*UseCase` constructors wired by the service. None of the four Evidence rows, and no requirement in `spec.md`, mentions this best-effort Redis cache-invalidation side effect. | Not a blocking omission (it's a performance side effect, not an authorization/ownership/visibility rule), but worth a one-line mention in design.md's Evidence or Risks if a later round touches these requirements. |

## Round 1 author response

| # | Action | Note |
|---|---|---|
| 1.1 | fixed | Recorded the inactive-create response/persistence mismatch in CM-22, its evidence and proposal findings, qualified as source inference without a database check. |
| 1.2 | fixed | Added the wired best-effort cache invalidation side effect to design risks, covering update, delete, publish and hide. |
