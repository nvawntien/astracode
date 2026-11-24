## Local execution

The maintainer approved the simpler design recorded in ADR-0011. Keep the
current branch, initial SQL and PostgreSQL 15.6 capture. Use the official
Goose v3.30.0 distribution pinned by digest or release checksums. The existing
Compose file builds a one-shot migration image containing the three SQL
directories. A short script applies each sequence in order after PostgreSQL's
TCP health check passes. Goose keeps one ledger and one transaction per
migration in the owning database. The supported local workflow runs one
migration invocation at a time.

Migration input bytes are part of the image build. On `docker compose --profile
dev --profile worker up -d --build`, a changed migration image replaces the
prior one-shot container. Owning services require the current job to complete
successfully and restart after Compose updates that dependency. A failed job
prevents application startup for the candidate. A rerun applies pending
versions only. Local failures can be corrected and retried without rolling
back earlier commits in other databases.

## Runtime and fixtures

Each service verifies its own database and explicitly expected Goose version
before starting work. The check reads the ledger with runtime credentials.
GORM retains application queries, transactions and repository ownership.
Local defaults use per-service database roles. Protected deployment credentials
are supplied separately by infrastructure owners.

PostgreSQL integration tests retain fixed fixture database and role identities,
loopback access and empty-data guards. Each suite gets a fresh temporary
PostgreSQL 15.6 instance migrated using the same pinned Goose CLI.

## Contracts and documentation

**BREAKING — startup prerequisite.** Local Compose applies migrations before
activation. Direct Go development requires running migrations explicitly first.
An absent or incompatible schema causes startup to fail.

**NON-BREAKING — application behavior.** APIs, gRPC, Kafka, Auth, Problem and
testcase behavior, and the Submission–Attempt–Outbox transaction remain intact.

Update the project and contributor quick starts, codebase data/development
guides, service READMEs and deployment guide. Preserve the legacy evidence and
accepted ADR history. The infrastructure guide requires successful migrations
before deployment activation. Managed rollout design is future work.
[ADR-0011](../../../docs/architecture/adr/0011-local-goose-migrations.md) ·
[NFR-D05](../../../docs/product/nfr.md)
