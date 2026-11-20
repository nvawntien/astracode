# progress.md — baseline-problem-catalog

## Verified state

- Branch `docs/apply-m0-baselines` at verification input `fe345d297248fcb1b24949ca3afcae3580df3f50`. The relevant implementation matches the inspected source revision `728aef2`.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` and `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed in a disposable checkout. The full gate ran the Problem module tests, vet and race tests, website typecheck/build, Compose config and strict validation of all eight changes.
- `openspec validate baseline-problem-catalog --strict` exited 0 with `Change 'baseline-problem-catalog' is valid`. The audit found 24 ADDED requirements, 50 WHEN/THEN scenarios, 24 matching Evidence rows and 25 existing evidence paths. `git diff --check` passed. The scoped diff contains this progress record, `proposal.md` and `design.md`.

## Last session

- Task 2.1, Q1 resolved. `git diff --exit-code 3faa936 HEAD -- services/problem pkg` confirmed the audited tag-create source is unchanged. The M0-05 PostgreSQL 15.6 probe returned HTTP 201 with `is_active=false` for explicit false, while both the database and repository reread returned true. Omitted activation returned and stored true. The probe used fixture Moderator claims and GORM v1.31.1. Explicit-inactive creation remains a finding outside PC-20.
- Task 2.1, Q3 resolved. Catalog mapping copies both stored numbers. The shared execution helpers treat valid time values below 50 as seconds and values at or above 50 as legacy milliseconds. Configured memory is converted from MiB to KiB. The website uses the same time threshold and displays the raw memory number as MB. `TestGetTestCaseNormalizesCanonicalExecutionLimits`, `TestGetTestCaseRejectsUnusableExecutionLimitsBeforePresigning`, `TestRunCodeUseCaseForwardsNormalizedProblemLimits` and `npm test -- tests/format.test.ts` passed.
- Task 2.1, Q2 remains open. The source audit counted 209 unique curated slugs and the four focused seed tests passed. Local Docker inventory found no running Compose Problem or PostgreSQL service. A listener check found no service on the documented local gateway, Problem or PostgreSQL ports. These checks did not establish an installed taxonomy.
- Tasks 1.1–1.5 retain the reviewed catalog, access and taxonomy evidence in `review.md` and the Evidence table. Tasks 2.2, 2.3 and 3.1 retain their completed status after current structure, scope and validation checks.

## Broken or unverified

- The seed tests use an in-memory repository. The PostgreSQL probe covers tag creation, while catalog filter SQL and the deployed tag inventory remain outside its evidence.
- The full build reported existing lint warnings. The original module-only checks and staging audit apply to the initial baseline commit `9f3fb58`. The commands above cover the current review evidence.

## Next action

- OpenSpec reports 8 of 9 tasks complete. Task 2.1 requires a read-only inventory from an identified running environment to resolve Q2.
