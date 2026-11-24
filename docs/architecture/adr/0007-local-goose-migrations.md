# ADR-0007 — Use the Goose CLI for M1-02

| Field | Value |
| --- | --- |
| Status | Accepted by maintainer direction |
| Date | 2026-11-24 |
| Change | M1-02 `add-versioned-migrations` |
| Requirement | NFR-D05 |
| Supersedes | Local execution and protected cutover provisions of ADR-0006 |
| Review | PR #66 and independent implementation review at Gate 2 |

## Context

The maintainer confirmed that AstraCode has yet to deploy to production. Its
first deployment will use versioned Goose migrations. The earlier design
assumed a production cutover from runtime GORM migration. That assumption drove
the custom Provider runner, durable recovery metadata and promotion freeze.

## Decision

- Keep the three service-owned SQL sequences, initial schema parity, Goose
  v3.30.0 artifact verification, and immutable released migrations. Keep GORM
  for data access. Each service checks its own expected schema version read-only
  and performs no runtime schema DDL.
- Run the official Goose CLI from a single local Compose migration service.
  After PostgreSQL is healthy, it migrates Auth, Problem and Submission in
  order. Applications depend on the job's successful completion. Compose
  builds the job image with its migration inputs, so the supported build and
  startup command uses an updated job when those inputs change. Local migration
  invocations are operated sequentially.
- Goose owns the migration history and transactional execution in each
  database. This supersedes local requirements from ADR-0006 for a custom
  runner, session locking, independently enrolled target identity, external
  checksums for applied files, and persistent migration reconciliation. On local
  failure, fix the cause and rerun the same sequence. Earlier committed
  migrations stay applied.
- Replace the protected cutover freeze with a deployment prerequisite. The
  first and subsequent deployments must successfully execute migrations before
  activating applications. Managed database rollout, backup, release
  compatibility and advanced orchestration belong to the infrastructure
  implementation. No protected release settings change under M1-02.

## Consequences

Contributors can use the existing Compose workflow and can run migrations
explicitly before direct Go startup. Existing developer data stays in place.
A legacy local database requires a fresh separate project or explicitly approved
reset of its disposable PostgreSQL volume. ADR-0006 remains the record of the
earlier decision and continues to govern provisions retained above.
