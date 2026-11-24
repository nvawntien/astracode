Addresses: NFR-D05 | Follows: ADR-0006

## Why

Auth, Problem, and Submission run GORM schema changes during repository construction, often without propagating errors. M1-02 makes schema changes versioned and reviewable and establishes the migration prerequisite for M1-03 (`add-content-tracks`). [ADR-0006](../../../docs/architecture/adr/0006-schema-migration-policy.md) · [Delivery plan](../../../docs/product/delivery-plan.md#m1--community-core) · [NFR-D05](../../../docs/product/nfr.md#9-deployability-and-maintainability)

## What Changes

- Capture the legacy schema on disposable PostgreSQL 15.6 and verify parity with an independent initial SQL migration for each of the three service-owned databases. GORM continues to handle persistence. Judge Worker has no PostgreSQL migration sequence.
- Add a dedicated one-shot migrator using a verified Pressly Goose v3.30.0 artifact. Prove first that the pinned Provider and driver can perform migration and history operations on the same physical session that holds the advisory lock, and that a lost session ends the attempt. Verify the provisioned target, bundle, applied checksums, and live schema before advancing. A repeat run against a verified target reports success without changing the database.
- **BREAKING — operational startup.** Compose and direct Go startup require fresh verification of all three databases for the current checkout. Each service also checks its own database before starting and fails on a missing or incompatible schema. Move development role provisioning to database bootstrap and run seeds explicitly after the gate.
- Migrate disposable PostgreSQL fixtures with the same tool, preserve fixture guards, and require the existing Problem mutation, testcase mutation, and Submission detail suites to execute. Rehearse clean startup and the full submission and rejudge path with rebuilt images.
- Hold cutover revisions from protected promotion until ADR-0006's managed migration gate is implemented and rehearsed. Record the release blocker and the enforcement required before the cutover can land. [Protected deployment workflow](../../../.github/workflows/deploy-production.yml) · [Deployment guide](../../../docs/DEPLOYMENT.md#normal-protected-rollout)

## Capabilities

### New Capabilities

- `database-schema-migrations` — the maintainer-approved operational capability for versioned schema changes, verified targets, startup gating, and safe recovery across the three service-owned databases. [Operational delta](specs/database-schema-migrations/spec.md)

### Modified Capabilities

None. Existing specifications remain the regression contract. Identity and authorization, the Problem catalog and authoring, testcase lifecycle, and Submission and judging behavior are all affected by the cutover for testing purposes.

## Impact

- **Dependency.** M0-11 is satisfied by the accepted ADR merged into `develop`. M1-03 depends on the completed and verified M1-02 cutover, including the ability to add the next Problem migration.
- **Implementation.** Auth, Problem, and Submission persistence and startup wiring, local PostgreSQL bootstrap and Compose, the dedicated migrator, the PostgreSQL CI fixtures, and contributor and operator guides. HTTP, gRPC, Kafka, and service database ownership remain compatible.
- **Main risks.** DAO declarations alone can miss PostgreSQL schema details, so require legacy-to-Goose catalog parity. Reject unmanaged databases and unexpected history. Hold the migration lock on the session doing the work. Block activation on partial success, stale startup evidence, or an unverified protected release.

### Out of scope

Content Tracks, Quiz, Contest, other product features, changes to service boundaries or ownership, ORM replacement, domain redesign, speculative schema tuning, unrelated refactors, unmanaged database adoption, shared or managed resets, Azure or production deployments, and production pipeline redesign. The scope includes identifying the protected-release gap and enforcing a hold before promotion. It preserves accepted ADRs and historical OpenSpec archives.

### Execution strategy

Keep M1-02 as one OpenSpec change, one feature branch, and one PR with 12 tasks. Execute schema capture and initial parity, the guarded runner, the all-service runtime cutover, local Compose and CI fixture integration, and then regression verification, documentation, and release safety in order. The maintainer approved an exception to the 1–4 working-day limit. Implementation targets completion on November 24, 2026. Retain the estimate of **7–10 working days** and require every acceptance check before completion. [Change-size rules](../../../docs/process/workflow.md#change-size) · [Design](design.md#delivery-estimate-and-execution)
