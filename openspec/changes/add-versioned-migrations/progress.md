# progress.md — add-versioned-migrations

## Scope

The maintainer authorized ADR-0007 and simplification in PR #66 before
implementation. Scope record `b19b025` preserves the previous review and ADR.
The prior implementation is `be4758d`. Session-start quick verification passed.

## Verification

- 1.1: Both strict OpenSpec validations passed. The artifact rules were checked manually because of the existing YAML limitation.
- 1.2: The pinned official OCI index advertises Linux amd64 and arm64, and its amd64 CLI reported Goose v3.30.0. All three PostgreSQL 15.6 schema-only dumps matched the legacy captures with blank lines and Goose objects excluded. The initial files and captures are unchanged.
- 2.1: A fresh disposable Compose stack migrated all three databases. An explicit repeat preserved schema and full ledger fingerprints. A changed image replaced the successful migration container. A deliberately invalid file failed, rolled back its DDL, and prevented all candidate service starts. A test-only Problem migration advanced versions to Auth 1, Problem 2, Submission 1.
- 2.2: Built servers refused a missing Auth ledger and a newer Problem version. Failed startup did not initialize history. Source audit found no runtime `AutoMigrate` or `AlterColumn`.
- 3.1: `scripts/test-postgres-integration.sh` passed `TestProblemMutationPostgresConcurrency`, `TestTestcaseMutationPostgresConcurrency` and `TestGetCurrentDetailPostgresSnapshots` without skips.
- 3.2: A disposable gateway smoke test passed Auth registration, activation, roles and suspension, Problem uniqueness and logical deletion, immutable testcase replacement, submission, official judging, rejudge and an injected Outbox write failure that rolled back Submission and Attempt writes. Full `scripts/verify.sh` passed.
- 4.1: Verified the documented Compose startup and explicit `docker compose run --build --rm migrate` workflow. Direct Go tag seeding created 209 tags and preserved all 209 on repeat. No existing developer volume was reset.
- 4.2: The deployment guide requires successful migrations before app activation. The protected Compose render excludes the local migration job and role defaults. The existing release workflows were left intact.

## Pending

Hosted CI and independent Gate 2 review. Managed
deployment work belongs to the infrastructure implementation under ADR-0007.
