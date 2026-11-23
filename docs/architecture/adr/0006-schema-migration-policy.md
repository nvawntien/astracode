# ADR-0006 — Version PostgreSQL schema migrations with Goose

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-11-23 |
| Milestone | M0-11 |
| Requirement | NFR-D05, backward-compatible versioned migrations and no runtime auto-migration in production |
| Implementation | M1-02 `add-versioned-migrations` |
| Owner | Orchestrator |
| Review | Infrastructure and service owners |

M0-11 records the decision. M1-02 implements the initial schemas, local cutover and verification. A protected release may use managed migrations once the release gate in this ADR is implemented and rehearsed. [Delivery plan](../../product/delivery-plan.md) · [NFR-D05](../../product/nfr.md) · [ADR workflow](../../process/workflow.md#10-adrs)

## Context

Local Compose runs PostgreSQL 15.6. On first initialization, `infra/postgres/init.sql` creates `auth_db`, `problem_db` and `submission_db`. GORM repository constructors create or reconcile application tables with `AutoMigrate`. Several callers discard its errors, and the Submission attempt repository also invokes `AlterColumn` on `TriggeredByUserID`. The current protected App/Judge rollout verifies application and worker health without a schema migration gate. [Local Compose](../../../docker-compose.yml) · [Database bootstrap](../../../infra/postgres/init.sql) · [Submission attempt repository](../../../services/submission/internal/adapter/outbound/persistence/postgres/submission_attempt.go) · [Deployment guide](../../DEPLOYMENT.md)

Running DDL at startup ties schema changes to replica restarts and leaves no reviewed, versioned path from one release schema to the next. M1-02 can start from empty databases for new development installations and explicitly approved disposable local data. The contents and ownership of shared or managed databases require separate verification. [Data ownership](../../codebase/DATA.md) · [Development workflow](../../codebase/DEVELOPMENT.md)

## Options

| Option | Trade-off |
|---|---|
| Keep GORM startup migration | Convenient for fresh development databases. Schema changes still depend on application startup and lack an explicit version history and deployment gate. |
| Run SQL scripts directly | Makes DDL reviewable. AstraCode would need to maintain its own ordering, transaction handling and migration history. |
| Use Goose with SQL migrations | Provides ordered SQL, per-file transactions and database-local history. AstraCode supplies target verification, runner serialization and release compatibility checks. |

## Decision

### Tool and ownership

Use Pressly Goose v3 as a dedicated one-shot migration tool. M1-02 targets **v3.30.0** and must verify the binary checksum or OCI digest, target architecture and PostgreSQL CLI behavior before pinning the artifact for local and CI use. Protected releases use the same verified pin. The upstream SQL-only image supports Linux amd64 and arm64 and runs without a shell. A wrapper, if needed, runs outside that stock image or in dedicated migrator packaging. Keep Goose out of the application binaries and their Go modules. Building this Goose version from source requires Go 1.26, while AstraCode CI pins Go 1.25.8. [Goose v3.30.0 release](https://github.com/pressly/goose/releases/tag/v3.30.0) · [Tagged Go module](https://github.com/pressly/goose/blob/v3.30.0/go.mod) · [AstraCode CI](../../../.github/workflows/ci.yml)

| Owner | Database | Migration directory | Initial schema to verify |
|---|---|---|---|
| Auth | `auth_db` | `services/auth/migrations/` | `users`, including UUID identity, username/email uniqueness and independent activation and suspension flags |
| Problem | `problem_db` | `services/problem/migrations/` | `problems`, `tags`, `problem_tags` and `test_cases`, including slug and join uniqueness, soft deletion and one testcase metadata row per problem |
| Submission | `submission_db` | `services/submission/migrations/` | `submissions`, `submission_attempts`, `submission_results` and `outbox_messages`, including unique attempt IDs, the current-attempt reference used by reads, and nullable `triggered_by_user_id` |

Each owner manages only its own schema and its own `goose_db_version` table. Services communicate through APIs and events across database boundaries. Judge Worker owns no PostgreSQL migrations. Derive each initial schema from the DAOs, queries and the PostgreSQL schema produced on a disposable database. Check types, nullability, defaults, sequences, keys, foreign keys, delete actions and indexes. Preserve the Problem mutation transaction, the Submission/attempt/outbox transaction and attempt-aware result handling. [Data ownership](../../codebase/DATA.md) · [Submission and Problem flows](../../codebase/FLOWS.md)

### Migration files and release history

- Use SQL-only files with sequential, zero-padded versions starting at `00001_initial_schema.sql` per database. Each file has one `-- +goose Up` section. A `Down` section is optional and requires a verified reversal. Deployment uses the forward path.
- Preserve the name, version and contents of every released migration. Correct an already released migration with a new version. CI rejects duplicate versions, gaps, and changes to the released sequence. The runner rejects out-of-order or unversioned execution.
- Bind the source revision, Goose artifact pin, file names and content hashes, and each database's target version to the release. Goose records applied versions. CI and release evidence retain file hashes separately, and schema checks detect drift a version number alone cannot identify.
- Use one transaction per migration file by default. For `-- +goose NO TRANSACTION`, require a reviewed recovery procedure and a disposable-database failure rehearsal. For example, a failed concurrent index build can leave an invalid index. Check the actual object state before resuming.
- Keep development fixtures and curated Problem tags in explicit, rerunnable seed commands after the schema gate. Schema changes may include data changes needed for compatibility. Large backfills run as separately verified, bounded batches with progress that survives a restart. [Goose SQL migrations](https://github.com/pressly/goose/tree/v3.30.0#sql-migrations) · [PostgreSQL concurrent index builds](https://www.postgresql.org/docs/15/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY) · [Problem tag seeder](../../../services/problem/cmd/seed-tags/main.go)

### Execution and privileges

The runner must verify the environment, PostgreSQL instance, database, schema and role before any write. The migration directory and database must correspond to the same owner. Use read-only catalog queries for initial inspection. In Goose v3.30.0, `status` can create the version table on an empty database, so it belongs inside the guarded migration path. [Goose v3.30.0 status implementation](https://github.com/pressly/goose/blob/v3.30.0/status.go)

| State at preflight | Runner behavior |
|---|---|
| Confirmed empty application schema without Goose history | Apply the initial migration and the rest of the approved sequence. |
| Known history and schema matching an applied prefix of the release manifest | Apply only the pending versions up to the release target. At the target version, finish without DDL after verification. |
| Application objects without trusted history, or an unexpected schema or version | Stop. Resolve legacy adoption or drift separately before applying migrations. This includes missing, unknown, or newer applied versions. |

A dedicated migrator holds the DDL rights and writes the version history for its database. In managed environments, application roles receive only the required reads, writes and sequence privileges on their own databases. They have no application-schema DDL rights, direct or inherited object ownership, or write access to the Goose ledger. Keep migration credentials separate from runtime credentials and out of source, images and logs. [PostgreSQL privileges](https://www.postgresql.org/docs/15/ddl-priv.html)

Run one migrator at a time per database. Shared environments require a PostgreSQL-backed lock with the same identity across releases and entry points. Hold it from history inspection through migration and post-checks. The stock Goose CLI has no such lock configured. Use a PostgreSQL session advisory lock in a wrapper or configure locking in a dedicated Goose Provider runner. A wrapper using a separate lock connection must demonstrate that migration DDL cannot continue once the lock is lost and another runner can enter. Use bounded acquisition and execution time. On lock loss, abort and block promotion until the database is reconciled. A second runner must either time out without writing or acquire the lock and recheck the history before applying anything. Serialize the managed release across all three databases so releases cannot interleave. [Goose locking options](https://pressly.github.io/goose/documentation/provider/#withsessionlocker) · [Goose v3.30.0 CLI](https://github.com/pressly/goose/blob/v3.30.0/cmd/goose/main.go) · [PostgreSQL advisory locks](https://www.postgresql.org/docs/15/explicit-locking.html#ADVISORY-LOCKS)

## Local cutover in M1-02

1. Capture the legacy schema on disposable PostgreSQL 15.6 and build and compare the three initial migration sets. Remove startup `AutoMigrate`, `AlterColumn` and equivalent DDL from application constructors and startup paths. Make missing or incompatible schemas fail startup through a read-only check. GORM continues to handle queries and writes.
2. Keep database creation in Compose bootstrap. Start the one-shot migration job after PostgreSQL is healthy. On a fresh deployment, Auth, Problem and Submission wait for successful migration and verification of all three databases. Make the same gate available for services run directly from Go. Ensure local startup uses migration results for the current checkout so a prior successful job cannot satisfy a newer schema. [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)
3. For an existing, explicitly disposable local dataset, require opt-in for the exact Docker context, Compose project and PostgreSQL volume or database before any reset. Refuse shared, managed, unrecognized or ambiguous targets. Keep reset separate from routine startup and avoid broad volume cleanup. Reconcile stale Kafka jobs, Redis state and MinIO references through explicit fixture isolation or separately approved cleanup. There is no legacy data import or version adoption in the local cutover.
4. Apply the three migration sets, check that a second run performs no schema changes, and run the required seeds separately. Start newly built application images and exercise Auth, Problem and Submit → Outbox → Kafka → Judge → Verdict, including rejudge correlation. Record the exact reset scope if a rehearsal uses a reset.

## Managed releases and recovery

Before the first managed rollout, verify that each target is either new or already managed under a trusted Goose history. An existing pre-Goose managed database requires a separately reviewed, data-preserving adoption plan with schema and data checks, backup, a compatible DDL-free rollback target and a rehearsed recovery path. Routine deployment must stop on that state. Manual edits to mark unverified versions as applied and destructive resets are forbidden for shared and managed targets.

1. **Preflight.** Validate the promoted artifact and target, inspect all three histories and confirm the tested schema range for the running and rollback application versions. Review the backup and recovery point and the applicable PostgreSQL lock and statement timeouts.
2. **Migrate and verify.** Apply only approved forward migrations compatible with the live release. Verify all three target histories and required schema invariants before activating the candidate. Retain redacted evidence with the source revision, tool pin, migration hashes, target identity, before/after versions and check results.
3. **Activate.** Continue the protected App/Judge rollout with the existing Worker suspension, Kafka consumer-group verification and cross-node rollback protections. An application rollback leaves the database versions in place and requires a verified compatible application target. Legacy images that perform startup DDL are ineligible as routine rollback targets after adoption. Never invoke `goose down` automatically. [Protected rollout](../../DEPLOYMENT.md#normal-protected-rollout) · [Rollback](../../DEPLOYMENT.md#rollback)

Use **Expand → Backfill/Adapt → Contract**. Expand with changes the running and rollback versions can tolerate. Complete and verify resumable backfill before switching reads or requiring new data. Schedule removal or tighter constraints in a later reviewed release once no deployed or eligible rollback version depends on the legacy schema. Review table locks and rewrite costs on representative data.

There is no transaction spanning the three databases or multiple migration files. If a later step fails, earlier successful migrations remain applied. Stop activation, retain the per-database outcome and inspect the actual history and schema before an operator retries. Resume the same approved artifact only when the remaining work is safe. Use a reviewed forward repair for partial nontransactional changes or a tested restore when forward repair is unsafe. Treat runner contention, lock loss, compatibility failure and unknown outcomes as failed promotion.

## Consequences and implementation evidence

Schema changes become reviewable and application replicas no longer need to coordinate startup DDL. The trade-off is a required migration step for developer setup, test fixtures and managed releases, plus maintenance of immutable release history and rehearsed recovery.

| Gate | Evidence expected |
|---|---|
| Artifact and history | Record the pinned Goose checksum or digest and verify it on the target platform. Validate SQL and reject duplicate, out-of-order, modified or unknown migrations. Run against empty PostgreSQL 15.6, rerun at target and compare the schema with the DAO contract. |
| Upgrade and failure | Test an upgrade from a prior managed schema when one exists, including representative data. Inject transactional and applicable nontransactional failures and a failure after another database has advanced. Verify service activation is blocked and that recovery checks use the recorded versions and actual schema. |
| Serialization and privileges | Demonstrate two concurrent runner attempts and lock-loss behavior. Verify that application roles can perform required operations and cannot modify the schema or migration history. |
| Local startup and fixtures | Rehearse a clean Compose installation, a repeat run and refusal of out-of-scope reset targets. Apply Goose to each disposable PostgreSQL CI fixture before running its suite. Require the existing Problem mutation, testcase mutation and Submission detail suites to run and pass. [Existing fixture workflow](../../codebase/DEVELOPMENT.md#build-test-and-quality-checks) |
| Behavior and release | Build images and run service smoke tests and the complete submission/rejudge path against the migrated schema. Before first managed use, rehearse the protected gate and compatibility of the supported rollback version against the resulting schema. |

M1-02 updates the data and development guides, contributor setup and relevant operator documentation as those workflows change. Record fresh verification evidence. Historical OpenSpec archives, including the dated Problem tag inventory, remain historical records. Preserve the behavior in the current specs. Any intentional externally observable change requires a separately reviewed OpenSpec delta. [Workflow and documentation policy](../../process/workflow.md)
