# ADR-0006 — Schema Migration Policy (Goose)

| Field | Value |
|---|---|
| Project | AstraCode — Online Education Platform |
| Milestone | **M0-11** |
| Decision type | Architecture Decision Record (ADR) |
| Status | **Proposed — decisions agreed in discussion; not yet approved/merged through ADR review** |
| Date | 2026-11-23 |
| Owner | Orchestrator / review by Infra & service owners |
| NFR | **NFR-D05** — versioned, backward-compatible migrations; no runtime auto-migration in production |
| Implementation change | **M1-02 `add-versioned-migrations`** |
| Intended repository path | `docs/architecture/adr/0006-schema-migration-policy.md` |

> **Decision scope.** This ADR selects the schema-management approach and specifies the local cutover and future release safety rules. It does not claim that Goose migrations, new runtime images, CI gates, or a database reset have been implemented.

## 1. Context and verified repository state

AstraCode currently uses **one PostgreSQL server with three separate databases** created by `infra/postgres/init.sql`: `auth_db`, `problem_db`, and `submission_db`. Auth owns `users`; Problem owns `problems`, `tags`, `problem_tags`, `test_cases`; Submission owns `submissions`, `submission_attempts`, `submission_results`, `outbox_messages`. Services use GORM as an ORM.

Repository constructors currently execute GORM `AutoMigrate`. In particular, `NewSubmissionAttemptRepository` invokes both `AutoMigrate(&SubmissionAttemptDAO{})` and `db.Migrator().AlterColumn(&SubmissionAttemptDAO{}, "TriggeredByUserID")` during construction. Several AutoMigrate results are ignored. There is no checked-in versioned SQL migration runner. `docker-compose.yml` mounts `infra/postgres/init.sql` for initial database creation, which does **not** create the application tables.

The protected production deployment currently performs application/config rollout and health verification, **not a database-migration gate**. Existing PostgreSQL integration tests create fresh fixture databases and must be adapted to use the managed schema rather than relying on runtime AutoMigrate.

**Explicit project-specific assumption accepted by the user:** the current operational dataset is local/development-only and **may be discarded**. No existing PostgreSQL data needs preservation or historical adoption. This assumption must never be extended implicitly to shared staging, production, or another contributor's environment.

## 2. Final decisions

| ID | Decision | Policy |
|---|---|---|
| M11-01 | Tool | **Pressly Goose v3**, standalone SQL-capable CLI/container; do not add Goose as a runtime dependency of Auth, Problem, or Submission. |
| M11-02 | Tool pinning | Target **Goose v3.30.0** for M1-02. Resolve and pin the verified OCI digest/tool artifact in implementation; do not use `latest` in CI or deployments. Review compatibility and security before merging. |
| M11-03 | Migration language | **SQL-only migrations**, not Go migration callbacks in this phase. |
| M11-04 | Versioning | Sequential, zero-padded numeric filenames beginning at `00001`, independent per database, e.g. `00001_initial_schema.sql`; never reuse a version within its owner. |
| M11-05 | Ownership | Each service exclusively owns the schema migrations and version history of its own database. No cross-service table DDL or direct cross-database reads. Judge Worker has no PostgreSQL migration ownership. |
| M11-06 | History | Default Goose tracking table `goose_db_version` **in each database independently**. Track release/source revision and migration content hash separately in CI/release evidence; do not treat Goose's version table as a migration-file checksum store. |
| M11-07 | Runtime responsibility | **No schema mutation at service initialization**: remove `AutoMigrate`, `AlterColumn`, and analogous startup DDL from production and local service constructors. GORM remains for ordinary DML/querying. |
| M11-08 | Fresh database | `infra/postgres/init.sql` creates databases only; a dedicated Goose job creates application tables, constraints, defaults, indexes and version metadata before services start. |
| M11-09 | Existing local database | **Destructive local cutover is permitted**. No schema adoption, version forcing, old-data backfill or compatibility with pre-Goose local volumes is required. |
| M11-10 | Local cutover safety | Reset **only explicitly named local/dev PostgreSQL data** after an explicit opt-in. The reset script must verify project/environment/volume identity and reject staging/production; never use broad destructive wildcard cleanup. Do not reset other contributors' volumes. |
| M11-11 | Initial schema fidelity | Initial SQL migrations must reproduce all tables, column types/nullability/defaults, primary keys, foreign keys, uniqueness rules and indexes needed by the existing GORM DAOs and behaviors, including `attempt_id`, Submission outbox and Problem-tag relationships. |
| M11-12 | Seeds vs schema | Keep development sample data and the existing curated-tag seeding workflow **separate** from schema migrations. Seed steps must be explicit, environment-aware, rerunnable, and not alter Goose history. |
| M11-13 | Execution timing | Run migrations through a **dedicated one-shot job**, not on every application replica start. For local Compose: PostgreSQL healthy → Goose migrations pass → application services start. For a future protected release: preflight → approved compatible migrations → verify → activate release. |
| M11-14 | Serialization | **One runner per database**. M1-02 must enforce deployment/runner serialization and test two concurrent attempts. For multi-runner/shared environments, use an explicitly implemented PostgreSQL-backed lock held across the entire Goose invocation (e.g. session advisory lock via wrapper / a separate migrator using Goose Provider `WithSessionLocker`); do **not** assume the stock Goose CLI automatically locks. |
| M11-15 | Migration transactions | Use Goose's transactional SQL migration behavior by default. `-- +goose NO TRANSACTION` is exception-only; its file must contain a recovery procedure and be validated on a disposable database. |
| M11-16 | Changes after initial cutover | Use **Expand → Backfill/Adapt → Contract** for backward compatibility. A released migration must not be edited or deleted; corrective changes get a new version. |
| M11-17 | Rollback | **Never automatically run `goose down` during application rollback.** Verify old/new application compatibility with the migrated schema before allowing production promotion. Destructive `Down` is not part of the standard protected release path. |
| M11-18 | Failure behavior | Any migration error, unknown state, unverified version, lock conflict, or schema incompatibility **blocks service activation/promotion**. No partial success claim across three databases; recovery is manual and evidence-based. |
| M11-19 | Permissions | Migration identity has scoped DDL rights for its owned database; runtime service identities should not have DDL rights in managed environments. Secrets stay outside images, source, CI logs and migration files. |
| M11-20 | CI/quality gates | Validate migration syntax/sequence, fresh installs, no-op second `up`, DAO/contract compatibility, deterministic fixture tests, failed-migration behavior, concurrent-run exclusion and application smoke tests. |
| M11-21 | Docs and OpenSpec | This is an **infrastructure implementation change, not a product behavior change**. Do not edit existing `openspec/changes/archive/**` or `openspec/specs/**` solely to replace AutoMigrate with Goose. Add fresh verification evidence. If behavior actually changes, propose an independent OpenSpec delta. |
| M11-22 | Scope split | **M0-11:** approve this ADR. **M1-02:** implement migrations, database reset tooling, refactor runtime constructors/tests, pipeline integration and evidence. |

### Tooling rationale

Goose supports versioned SQL files with `-- +goose Up`, optional `-- +goose Down`, transactional execution by default and opt-out with `-- +goose NO TRANSACTION`. As of the decision date the v3.30.0 release provides an official `ghcr.io/pressly/goose` image for SQL migrations. Goose v3.28+ requires Go 1.26 if compiled from source, while AstraCode CI uses Go 1.25.8; keeping Goose as a pinned, external image/binary avoids coupling this decision to a runtime Go upgrade. An exact deployable digest, platform and binary behavior still require verification in M1-02.

## 3. Target repository layout (proposed; M1-02 creates these)

```text
services/
  auth/migrations/
    00001_initial_schema.sql
  problem/migrations/
    00001_initial_schema.sql
  submission/migrations/
    00001_initial_schema.sql
scripts/migrations/
  migrate.sh                 # one-shot, scoped migrations; fail-closed
  reset-local-postgres.sh    # explicitly opt-in local-only operation
  verify.sh                  # schema/version/compatibility checks
```

The actual structure may adapt to packaging constraints, but **ownership and three independent migration histories are fixed**. The initial SQL is generated/reviewed against the existing GORM DAOs and verified PostgreSQL schema behavior—not guessed from a simplified entity diagram.

Example migration syntax (illustrative **only**, not a complete AstraCode schema):

```sql
-- +goose Up
CREATE TABLE example_record (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL
);

-- +goose Down
DROP TABLE example_record;
```

For the real initial schema, the `Down` section may be omitted rather than shipping an easily misused destructive production rollback; Goose permits an optional Down. Local reset is an explicit separate procedure, not a standard `down-to 0` deployment.

## 4. Local cutover sequence (M1-02)

1. **Inventory** all existing AutoMigrate/`AlterColumn` locations and dependent test setup. Capture the legacy schema shape sufficiently to define a functionally equivalent fresh schema (not to preserve local records).
2. **Create** three initial Goose SQL migrations, including the exact foreign keys/indexes/defaults that ensure existing code invariants. Build the schema on empty PostgreSQL 15.6 databases and inspect it.
3. **Refactor** repository constructors and service startup: remove startup DDL, preserve dependency-injection interfaces, and make schema absence an explicit startup/test failure rather than silently migrating.
4. **Refactor test fixtures** to run Goose on disposable databases first. Existing PostgreSQL integration suites must no longer assume DAO constructors implicitly create tables.
5. **Introduce one-shot migrations** in local bootstrapping with explicit PostgreSQL health/readiness dependencies; ensure applications are not started against a missing/partially migrated schema.
6. **Approve local reset** using an environment-guarded exact PostgreSQL volume/database target; reset dev-only PostgreSQL data. Coordinate with Kafka/MinIO/Redis/dev fixtures because stale submission IDs, user references and testcase objects may otherwise remain. Reset those stores **only when explicitly intended**, not via a generic `docker compose down -v` default.
7. **Run** the three Goose migration sets, rerun `up` to confirm no-op, and run any required idempotent development seed workflows separately.
8. **Build new application images** and test Auth, Problem, Submission, Judge Worker interactions, including the complete Submit → Outbox → Kafka → Judge → Verdict journey.
9. **Record evidence**: clean schema versions for all three databases, table/index/constraint verification, tests, new image identifiers, reset scope, known limitations and a follow-up plan for release migrations.

No legacy data import, historical baselining or migration `force`/fake version step is part of this cutover.

## 5. Future managed deployment order

```text
Approved release candidate
  → verify immutable source/config/migration artifact and target environment
  → check schema versions, ownership permissions, migration serialization
  → run only backward-compatible pending migrations (Auth, Problem, Submission)
  → verify ALL required migration outcomes and compatibility
  → continue existing protected App/Judge release sequence
  → smoke + evidence
```

There is **no atomic transaction across three PostgreSQL databases**. Earlier successful compatible migrations may remain applied if a later database fails; in that event stop deployment and reconcile explicitly. A successful application rollback does not reverse applied database migrations. In-place destructive schema operations require a later separately reviewed Contract phase after the supported rollback window closes.

If production deployment remains an App/Judge coordinated rollout, the migration gate must be added **without weakening** the existing Worker suspension, Kafka-group and cross-node rollback protections. This is implementation work for M1-02 / subsequent release-pipeline changes, not an action performed by this ADR.

## 6. Risk register — revised for the local reset decision

| Risk | Local-cutover disposition | Future managed-environment guardrail |
|---|---|---|
| R1 — Incorrect initial schema | **HIGH / BLOCKER.** May violate archived behavioral specs even with no data. Require table/index/default/FK parity, fixture tests and E2E smoke. | Mandatory compatibility tests and schema review. |
| R2 — Loss of existing PostgreSQL records | **ACCEPTED for user-approved local dev data only.** Reset scope must be explicit. | **NOT ACCEPTED** for shared, staging or production data. Require backup/recovery policy. |
| R3 — Old image incompatibility / old AutoMigrate | **ACCEPTED locally:** deploy freshly built DDL-free images; no local legacy-image rollback requirement. | Require tested rollback target and backward-compatible expand migrations; block unsafe old images. |
| R4 — Partial migration | **HIGH.** Transactional default, explicit recovery for nontransactional files. | Stop promotion and reconcile, no automatic `down`. |
| R5 — Concurrent migration runners | **HIGH.** One-shot serial jobs; test concurrency. | DB-backed cross-runner lock or equivalent demonstrated serialization, not an assumed CLI feature. |
| R6 — Lock-heavy or destructive DDL | Not a concern for empty initial local schema, but validate new migrations. | Lock/statement timeout; review indexes and large-table backfills. |
| R7 — Three databases on different versions | **MEDIUM.** Verify all before application starts. | Fail-closed version gate; compatible phased deployments. |
| R8 — ORM vs SQL drift | **HIGH.** Compare against DAOs and application behavior. | CI schema contract tests. |
| R9 — Edited/reordered migration histories | **MEDIUM.** Sequential naming and PR checks. | Hash/manifest checking outside Goose history table. |
| R10 — Toolchain/version drift | **LOW if isolated.** Pin official SQL migration image/tool, never `latest`. | Verify selected digest, platform and CLI behavior. |
| R11 — Stale Kafka, Redis or MinIO state after DB reset | **MEDIUM.** Coordinate explicit dev fixture reset or isolation; do not accidentally delete non-Postgres volumes. | Forbid destructive reset in managed environments. |
| R12 — CI tests rely on runtime AutoMigrate | **HIGH.** Update existing fresh-DB integration suites to run Goose first. | Regression gates remain required. |

## 7. OpenSpec and documentation impact

**No modifications required just because of the migration tool swap:**

- `openspec/changes/archive/**` (immutable history and past verification context).
- `openspec/specs/**` for existing capabilities, provided all observable behavior remains the same.
- Product PRD/FRD and NFR-D05, which already demands versioned compatible migrations.

**Artifacts to create/update:**

| Stage | Artifact | Action |
|---|---|---|
| M0-11 | `docs/architecture/adr/0006-schema-migration-policy.md` | Review and accept this ADR through a draft PR; do not mark Accepted before approval. |
| M1-02 | `services/{auth,problem,submission}/migrations/` | Add first schema and subsequent SQL migrations. |
| M1-02 | GORM repository constructors and tests | Remove startup DDL, migrate fixture setup. |
| M1-02 | Compose/startup, CI and protected deployment scripts | Add one-shot Goose execution and verification, preserve current rollout protections. |
| M1-02 | `docs/codebase/DATA.md`, `docs/codebase/DEVELOPMENT.md`, `CONTRIBUTING.md`, `AGENTS.md` | Replace outdated AutoMigrate guidance with Goose workflow. |
| M1-02 | `docs/architecture/deployment.md` (when created) | Record managed migration order and rollback compatibility. |
| M1-02 | `docs/evidence/` or approved CI artifacts | New schema comparison, functional regression and migration-gate evidence. |

**Archived baseline rule:** replacing infrastructure does not require rewriting behavioral specs. If a migration causes an externally observable behavior change (e.g. a uniqueness guarantee disappears or a submission is not durably created), that is a defect against an existing spec, **not** justification to edit archive history. Restore compliance or propose a separate reviewed behavior change.

### Important evidence distinction

The archived `baseline-problem-catalog` includes a dated local tag inventory snapshot. Once the developer database is reset, those row counts no longer describe the live local instance; the archive remains a truthful historical record. Seed and verify new fixtures as necessary; do not rewrite that archived evidence.

## 8. Gate 1 — M0-11 ADR acceptance

- [ ] Reviewer confirms the accepted **local-only data-loss assumption** and prohibition against implicit managed-environment data resets.
- [ ] Goose, SQL-only, version sequencing and three database owners are explicit.
- [ ] Initial schema fidelity and no runtime DDL are non-negotiable.
- [ ] One-shot migration ordering, failure behavior and serialization policy are recorded.
- [ ] Future compatibility/rollback policy is explicit even though today's cutover discards local data.
- [ ] OpenSpec archives and behavioral main specs are correctly protected from unnecessary changes.
- [ ] M1-02 implementation/verification tasks and documentation impacts are stated.
- [ ] ADR reviewed/merged under the repository's ADR approval workflow.

## 9. M1-02 handoff / Definition of Done (not part of M0-11 implementation)

- [ ] All 3 fresh PostgreSQL databases migrate from empty to target Goose versions.
- [ ] No production/local application constructor calls `AutoMigrate`, `AlterColumn`, or equivalent schema-mutating GORM methods.
- [ ] DB version table exists independently in each of `auth_db`, `problem_db`, `submission_db`.
- [ ] Schema constraints/indexes/defaults are validated against DAO expectations and archived behavior.
- [ ] Goose `up` on an already-current database is a no-op; duplicate versions are rejected.
- [ ] Two concurrent migration attempts do not overlap their DDL execution.
- [ ] Local reset is explicit and refuses environments/volumes outside approved developer scope.
- [ ] Auth, Problem, Submission and complete judge submission journey pass on newly migrated schema.
- [ ] PostgreSQL integration tests are migrated to Goose-owned schema setup.
- [ ] CI fails closed for migration syntax/version/schema/behavior regression.
- [ ] New application image release is built and tested; deployment evidence includes schema versions.
- [ ] Docs/harness guidance updated; no existing archive or main behavioral spec modified solely for tooling.

## 10. Remaining verification tasks, not open architecture decisions

No further user choice is necessary to draft/review M0-11. The following are intentionally **implementation evidence gates** for M1-02, not unspecified ADR policy:

1. Verify the exact pinned Goose v3.30.0 image digest and supported CLI invocation in the target environment.
2. Derive the full initial SQL schemas from current DAOs and test against PostgreSQL 15.6; this ADR is not a generated DDL dump.
3. Identify the exact Compose project/volume in each developer environment before any destructive reset.
4. Verify that cross-process locking and failure recovery work as designed.
5. Run integration/E2E tests and collect new evidence after rebuilding the application images.

---

## Sources

### Internal (reviewed on `develop`)

- [Delivery plan: M0-11 / M1-02](https://github.com/nvawntien/astracode/blob/develop/docs/product/delivery-plan.md)
- [NFR-D05](https://github.com/nvawntien/astracode/blob/develop/docs/product/nfr.md)
- [OpenSpec config](https://github.com/nvawntien/astracode/blob/develop/openspec/config.yaml)
- [Team workflow / ADR rules](https://github.com/nvawntien/astracode/blob/develop/docs/process/workflow.md)
- [PostgreSQL data ownership and AutoMigrate](https://github.com/nvawntien/astracode/blob/develop/docs/codebase/DATA.md)
- [Repository development / integration tests](https://github.com/nvawntien/astracode/blob/develop/docs/codebase/DEVELOPMENT.md)
- [SubmissionAttempt constructor runtime DDL](https://github.com/nvawntien/astracode/blob/develop/services/submission/internal/adapter/outbound/persistence/postgres/submission_attempt.go)
- [Current production deployment contract](https://github.com/nvawntien/astracode/blob/develop/docs/DEPLOYMENT.md)
- [Archived catalog review snapshot](https://github.com/nvawntien/astracode/blob/develop/openspec/changes/archive/2026-11-21-baseline-problem-catalog/progress.md)

### Tool documentation

- [Pressly Goose CLI/SQL documentation](https://github.com/pressly/goose)
- [Pressly Goose releases](https://github.com/pressly/goose/releases)
- [Goose Provider and locking](https://pressly.github.io/goose/documentation/provider/)
- [Goose CLI commands](https://pressly.github.io/goose/documentation/cli-commands/)
