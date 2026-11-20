# Tasks

This baseline has review tasks only. PC references identify the requirement rows in `design.md`. No task authorizes implementation or changes outside this change directory. Record completion evidence in `progress.md` before checking a task.

## 1. Review requirement evidence

- [x] 1.1 Verify PC-01–PC-04 against public routing, slug lookup, pagination binding, and list/count source; verify the evidence audit reports matching requirement rows and record the Problem module `go test ./...` and `go vet ./...` results.
- [x] 1.2 Verify PC-05–PC-08 against request binding, `applyFilters`, `filterProblemIDsByTagSlug`, and `escapeLikePattern`; record the source-review result and distinguish it from database-backed filter testing.
- [x] 1.3 Verify PC-09–PC-13 against the public mapper, response declarations, example decoding, and attached-tag loading; record source evidence for every scenario and the coverage limits of `TestTestCaseMetadataDoesNotSerializeStorageKey`.
- [x] 1.4 Verify PC-14–PC-18 against public/own/staff/internal read composition and access checks; record `TestListTagsReturnsOnlyThePublicAuthoringCatalog`, `TestListMyProblemsRoleAndOwnershipMatrix`, `TestAdminListRequiresModerator`, and the individual-read access matrix results, retaining the cache-state limitation.
- [x] 1.5 Verify PC-19–PC-24 against tag validation, administration, deactivation, and seed source; record `TestAdminTagListRequiresModerator`, `TestTagMutationRoleMatrix`, and seed test results, identifying which scenarios have source evidence only.

## 2. Review limitations and boundaries

- [ ] 2.1 Answer proposal questions Q1–Q3 with code or permitted local verification evidence; if an answer remains unavailable, leave this task open and keep that behaviour outside normative claims.
- [x] 2.2 Review every scenario against its evidence row and the proposal Findings; verify 24 ADDED requirements, WHEN/THEN scenarios, no implementation identifiers in the spec, and no unsupported guarantee. Record the evidence-audit command output in `progress.md`.
- [x] 2.3 Review documentation and contract impact: verify the NON-BREAKING documentation-only classification, reference-only boundary with `content-moderation`, and that `git diff --cached --name-only` contains exclusively this change directory. Record that no code, main spec, other baseline, or architecture document is staged.

## 3. Validate the review artifacts

- [x] 3.1 Run `openspec validate baseline-problem-catalog --strict`, record its exact result in `progress.md`, and verify `git diff --check` and the final staged whitespace check pass.
