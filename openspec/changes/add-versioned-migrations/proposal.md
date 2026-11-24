Addresses: NFR-D05 | Follows: ADR-0006

## Why

Auth, Problem, and Submission run GORM schema changes during repository construction, often without propagating errors. M1-02 makes schema changes versioned and reviewable and establishes the migration prerequisite for M1-03 (`add-content-tracks`). [ADR-0006](../../../docs/architecture/adr/0006-schema-migration-policy.md) · [Delivery plan](../../../docs/product/delivery-plan.md#m1--community-core) · [NFR-D05](../../../docs/product/nfr.md#9-deployability-and-maintainability)

## What Changes

- Capture the legacy schema on disposable PostgreSQL 15.6 and verify parity with an independent initial SQL migration for each of the three service-owned databases. GORM continues to handle persistence. Judge Worker has no PostgreSQL migration sequence.
- Add a dedicated one-shot migrator using a verified Pressly Goose v3.30.0 artifact. It verifies target identity, migration files, history, and schema, then serializes forward migration per database. A repeat run against a verified target reports success without changing the database.
- **BREAKING — operational startup.** Compose and direct Go startup require fresh verification of all three databases for the current checkout. Each service also checks its own database before starting and fails on a missing or incompatible schema. Move development role provisioning to database bootstrap and run seeds explicitly after the gate.
- Migrate disposable PostgreSQL fixtures with the same tool, preserve fixture guards, and require the existing Problem mutation, testcase mutation, and Submission detail suites to execute. Rehearse clean startup and the full submission and rejudge path with rebuilt images.
- Hold cutover revisions from protected promotion until ADR-0006's managed migration gate is implemented and rehearsed. Record the release blocker and the enforcement required before the cutover can land. [Protected deployment workflow](../../../.github/workflows/deploy-production.yml) · [Deployment guide](../../../docs/DEPLOYMENT.md#normal-protected-rollout)

## Capabilities

### New Capabilities

- `database-schema-migrations` — operational requirements for versioned schema changes, verified targets, startup gating, and safe recovery. The current capability inventory specifies product behavior and has no home for a database lifecycle shared by three services. Gate 1 should approve one operational capability for these requirements. [Canonical capability inventory](../../specs)

### Modified Capabilities

None. Existing specifications remain the regression contract. Identity and authorization, the Problem catalog and authoring, testcase lifecycle, and Submission and judging behavior are all affected by the cutover for testing purposes.

## Impact

- **Dependency.** M0-11 is satisfied by the accepted ADR merged into `develop`. M1-03 depends on the completed and verified M1-02 cutover, including the ability to add the next Problem migration.
- **Implementation.** Auth, Problem, and Submission persistence and startup wiring, local PostgreSQL bootstrap and Compose, the dedicated migrator, the PostgreSQL CI fixtures, and contributor and operator guides. HTTP, gRPC, Kafka, and service database ownership remain compatible.
- **Main risks.** DAO declarations alone can miss PostgreSQL schema details, so require legacy-to-Goose catalog parity. Reject unmanaged databases and unexpected history. Hold the migration lock on the session doing the work. Block activation on partial success, stale startup evidence, or an unverified protected release.

### Out of scope

Content Tracks, Quiz, Contest, other product features, changes to service boundaries or ownership, ORM replacement, domain redesign, speculative schema tuning, unrelated refactors, unmanaged database adoption, shared or managed resets, Azure or production deployments, and production pipeline redesign. The scope includes identifying the protected-release gap and enforcing a hold before promotion. It preserves accepted ADRs and historical OpenSpec archives.

### Change size

One operational capability and one owner fit the workflow, with 12 tasks. The estimated **7–10 working days** exceed the 1–4 day limit. Proposed Gate 1 decomposition is schema capture and parity (1–2 days), guarded migrator and failure tests (3–4 days), then an all-service local cutover (3–4 days). The first two changes run only against disposable verification targets. The final cutover changes schema ownership and activation together and retains the M1-03 dependency. [Change-size rules](../../../docs/process/workflow.md#change-size) · [Design](design.md#delivery-estimate-and-decomposition)
