# progress.md - baseline-problem-catalog

## Verified state

- Branch `docs/apply-m0-baselines` at verification input `271acc20a5228820d2f5b77dc3e5050e579a8e09`. The relevant implementation matches the inspected source revision `728aef2`.
- With Go 1.25.8, `QUICK=1 scripts/verify.sh` passed in the working checkout and `scripts/verify.sh` passed in a disposable checkout. The full gate ran Go tests, vet and race tests, website typecheck and build, Compose config, and strict validation of all eight changes.
- `openspec validate baseline-problem-catalog --strict` exited 0 with `Change 'baseline-problem-catalog' is valid`. The audit found 24 ADDED requirements, 50 WHEN/THEN scenarios, 24 matching Evidence rows and 25 existing evidence paths.

## Last session

- Task 2.1, Q1 resolved. `git diff --exit-code 3faa936 HEAD -- services/problem pkg` confirmed the audited tag-create source is unchanged. The M0-05 PostgreSQL 15.6 probe returned HTTP 201 with `is_active=false` for explicit false, while both the database and repository reread returned true. Omitted activation returned and stored true. The probe used fixture Moderator claims and GORM v1.31.1. Explicit-inactive creation remains a finding outside PC-20.
- Task 2.1, Q3 resolved. Catalog mapping copies both stored numbers. The shared execution helpers treat valid time values below 50 as seconds and values at or above 50 as legacy milliseconds. Configured memory is converted from MiB to KiB. The website uses the same time threshold and displays the raw memory number as MB. `TestGetTestCaseNormalizesCanonicalExecutionLimits`, `TestGetTestCaseRejectsUnusableExecutionLimitsBeforePresigning`, `TestRunCodeUseCaseForwardsNormalizedProblemLimits` and all six tests in `npm test -- tests/format.test.ts` passed again.
- Task 2.1, Q2 resolved by the local PostgreSQL snapshot below. Prior seed tests used an in-memory repository.
- Tasks 1.1 through 1.5 retain the reviewed catalog, access and taxonomy evidence in `review.md` and the Evidence table. Tasks 2.2, 2.3 and 3.1 retain their completed status.

## Local taxonomy inventory

- On 2026-11-21 at 01:12 ICT, `docker inspect judge_problem judge_postgres` identified the stopped local Compose services in project `go-judge-system`. The Problem service targeted `postgres:5432/problem_db`. PostgreSQL 15.6 stored data in `go-judge-system_postgres_data`.
- Exported `Desired()` from `services/problem/internal/seed/tags/tags.go` at `b540cc0` using `GOWORK=off GOTOOLCHAIN=go1.25.8 go run <scratch>/definitions.go <scratch>/export.go`. The copied definition file used package `main`, and the exporter encoded the returned definitions as JSON. The source supplied 209 unique slugs, all active.
- Mounted the cleanly stopped source volume read-only in a temporary container using the original PostgreSQL image and `--network none`. Started PostgreSQL over a tmpfs copy and queried `problem_db` with `psql -X -v ON_ERROR_STOP=1`. Within `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, checked `current_database()`, `server_version`, and `transaction_read_only`, then ran the inventory equivalent of `SELECT slug, name, description, is_active, deleted_at IS NOT NULL FROM public.tags` and `ROLLBACK`. The query included soft-deleted rows.
- Compared every persisted slug and checked the matching curated rows against their source names, descriptions, and activation flags. The snapshot contained 217 rows and 217 distinct slugs, with 0 missing curated slugs and 0 duplicate slugs. All 209 curated rows were active and nondeleted, with zero field differences. The 8 additional slugs were all inactive, with 6 nondeleted and 2 soft-deleted. This left 209 active and 6 inactive nondeleted tags.
- `QUICK=1 scripts/verify.sh` and `scripts/verify.sh` passed with Go 1.25.8. `openspec validate problem-catalog --type spec --strict --no-interactive` passed. The documentation audit confirmed all nine review tasks are complete, preserved the Q1 and Q3 evidence, and matched the unchanged main spec to the archived delta. `git diff --check` passed.

## Broken or unverified

- The Q1 probe covers tag creation and the Q2 snapshot covers the local persisted inventory. Live catalog-filter SQL and production inventory remain unverified.
- The website build passed with existing lint warnings. The original staging audit applies to the initial baseline commit `9f3fb58`.

## Archive

- Archived on 2026-11-21 with approval to proceed while task 2.1 remained open. The main `problem-catalog` spec matches the delta's purpose, 24 requirements, and 50 scenarios.
- With Go 1.25.8, `QUICK=1 scripts/verify.sh` passed before the sync and `scripts/verify.sh` passed after archiving. Strict OpenSpec validation passed for all nine main specs.
