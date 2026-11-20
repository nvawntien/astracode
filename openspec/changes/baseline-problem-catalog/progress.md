# progress.md — baseline-problem-catalog

## Verified state
- Branch / worktree: `feature/baseline-problem-catalog`; initially clean, no staged paths.
- Source revision: `728aef24cc0d6f624f79fd612265e904406d3d44`.
- Last module verify: from `services/problem`, `TMPDIR=/dev/shm/problem-catalog-go-tmp GOTMPDIR=/dev/shm/problem-catalog-go-tmp go test ./...` and the same environment with `go vet ./...` → PASS (exit 0).
- Last strict validation: `openspec validate baseline-problem-catalog --strict` → `Change 'baseline-problem-catalog' is valid` (exit 0), using the Node invocation below.
- Task 1.1: reviewed PC-01–04 binding/routing/read/count source; module test and vet commands above PASS; evidence audit below PASS.
- Task 1.2: reviewed PC-05–08 binding, filter conjunction, literal search, and active-tag predicates in the cited functions; evidence audit PASS; SQL execution not claimed.
- Task 1.3: reviewed PC-09–13 mapping/decoding/tag loading; module run includes passing `TestTestCaseMetadataDoesNotSerializeStorageKey` (adjacent coverage only); evidence audit PASS.
- Task 1.4: module run PASS includes `TestListTagsReturnsOnlyThePublicAuthoringCatalog`, `TestListMyProblemsRoleAndOwnershipMatrix`, `TestAdminListRequiresModerator`, `TestGetProblemRoleAndOwnershipMatrix`, and `TestCachedGetProblemPreservesHiddenAccessMatrix`; reviewed PC-14–18 source.
- Task 1.5: module run PASS includes `TestAdminTagListRequiresModerator`, `TestTagMutationRoleMatrix`, `TestSeedIsIdempotent`, `TestSeedPreservesExistingConflictingTag`, `TestSeedCountsCreationFailures`; reviewed PC-19–24 source and SQL coverage limits.
- Task 2.2: inline Node evidence audit → `PASS evidence audit: 24 ADDED requirements, 50 WHEN/THEN scenarios, 24 matching evidence rows, 25 existing source paths, 9 review tasks.` Manual review maps each scenario to the implementing functions and retains Findings/Q1–Q3 exclusions.
- Task 2.3: `git diff --cached --name-only` and inline Node scope guard → `PASS staged scope: exactly 6 files, exclusively openspec/changes/baseline-problem-catalog/`; no code, docs, main specs, or other baselines staged.
- Task 3.1: strict validation above PASS; `git diff --check` and `git diff --cached --check` → no output, exit 0.

## Last session
- Goal: record existing `problem-catalog` behaviour with ADDED requirements and review-only tasks.
- Changed: change metadata, proposal, spec, design/evidence, review tasks, and this progress record only.
- Read root instructions, glossary, all four requested codebase documents, and implementation/tests; no nested module instructions exist.

## Broken or unverified
- `/tmp` quota prevented initial npm bootstrap and Go build setup; reused an existing OpenSpec installation and reran Go successfully with both temporary-directory variables above.
- Whole-repository `scripts/verify.sh` was not run because it writes environment/dependency/build files outside the permitted change boundary.
- No PostgreSQL-backed catalog execution or deployed-stack verification was performed; see evidence-table coverage limits.
- Proposal Q1–Q3 remain unanswered; task 2.1 stays open.

## Next action
- Next task: reviewer answers Q1–Q3 (task 2.1); all planning artifacts exist and the remaining questions do not authorize implementation.
- Do not touch: code, docs, main specs, other baselines, production configuration; do not merge or archive.

## Notes for the reviewer
- OpenSpec is invoked with `node /dev/shm/content-moderation-tools/node_modules/@fission-ai/openspec/bin/openspec.js` (no executable on PATH).
- CLI warns that existing config rules are strings rather than arrays; follow the read constraints manually and do not edit config.
