# progress.md - baseline-problem-catalog

## Verified state

- Branch `docs/apply-m0-baselines` at verification input `271acc20a5228820d2f5b77dc3e5050e579a8e09`. The relevant implementation matches the inspected source revision `728aef2`.
- With Go 1.25.8, `QUICK=1 scripts/verify.sh` passed in the working checkout and `scripts/verify.sh` passed in a disposable checkout. The full gate ran Go tests, vet and race tests, website typecheck and build, Compose config, and strict validation of all eight changes.
- `openspec validate baseline-problem-catalog --strict` exited 0 with `Change 'baseline-problem-catalog' is valid`. The audit found 24 ADDED requirements, 50 WHEN/THEN scenarios, 24 matching Evidence rows and 25 existing evidence paths.

## Last session

- Task 2.1, Q1 resolved. `git diff --exit-code 3faa936 HEAD -- services/problem pkg` confirmed the audited tag-create source is unchanged. The M0-05 PostgreSQL 15.6 probe returned HTTP 201 with `is_active=false` for explicit false, while both the database and repository reread returned true. Omitted activation returned and stored true. The probe used fixture Moderator claims and GORM v1.31.1. Explicit-inactive creation remains a finding outside PC-20.
- Task 2.1, Q3 resolved. Catalog mapping copies both stored numbers. The shared execution helpers treat valid time values below 50 as seconds and values at or above 50 as legacy milliseconds. Configured memory is converted from MiB to KiB. The website uses the same time threshold and displays the raw memory number as MB. `TestGetTestCaseNormalizesCanonicalExecutionLimits`, `TestGetTestCaseRejectsUnusableExecutionLimitsBeforePresigning`, `TestRunCodeUseCaseForwardsNormalizedProblemLimits` and all six tests in `npm test -- tests/format.test.ts` passed again.
- Task 2.1, Q2 remains open. The source audit counted 209 unique curated slugs. `TestDesiredDefinitionsAreCanonicalAndValid`, `TestSeedIsIdempotent`, `TestSeedPreservesExistingConflictingTag` and `TestSeedCountsCreationFailures` passed. `docker ps -a` found no local AstraCode containers, `docker volume ls` found no project PostgreSQL volume, and `ss -H -ltn` found no listener on the local gateway (8080), Problem (8082), or PostgreSQL (5432) port.
- Tasks 1.1 through 1.5 retain the reviewed catalog, access and taxonomy evidence in `review.md` and the Evidence table. Tasks 2.2, 2.3 and 3.1 retain their completed status.

## Broken or unverified

- The seed tests use an in-memory repository. The PostgreSQL probe covers tag creation, while catalog filter SQL and the deployed tag inventory remain outside its evidence.
- The website build passed with existing lint warnings. The original staging audit applies to the initial baseline commit `9f3fb58`.

## Next action

- OpenSpec reports 8 of 9 tasks complete. To resolve Q2, compare the 209 curated slugs against a read-only inventory of active and inactive tags from an identified existing Problem catalog.
