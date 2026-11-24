## Purpose

Define how AstraCode operators and verification jobs evolve service-owned databases and establish schema readiness before services start.

## ADDED Requirements

### Requirement: Independent versioned schemas

The system SHALL use a separate, ordered series of versioned migrations and a separate history for each PostgreSQL-owning service. It SHALL preserve the identity, order, and contents of released migrations and use a new version for corrections. A release SHALL identify the approved tool artifact, migration files and their checksums, source revision, and target version for each owner.

#### Scenario: Initialize an empty service database

- **WHEN** the migrator runs on an approved empty database for a service
- **THEN** it applies that service's initial schema with structures, types, nullability, defaults, sequences, keys, uniqueness, indexes, and referential actions equivalent to the previously generated schema
- **AND** it records the new version only in that database

#### Scenario: Reject an invalid migration sequence

- **WHEN** the migration inputs have a duplicate, gap, unexpected order, changed released migration, checksum mismatch, or unversioned change
- **THEN** verification rejects the inputs before applying any migration

### Requirement: Verify the migration target before writing

The migrator SHALL establish the expected environment, PostgreSQL instance, database, schema, role, and service ownership using read-only inspection before any database write, including history initialization. The migration inputs SHALL correspond to that owner.

#### Scenario: Connection reaches an incorrect target

- **WHEN** a migration request resolves to an unrecognized target or any required identity or owner check fails
- **THEN** it reports failure and leaves the target schema, history, and application data unchanged

### Requirement: Validate history and schema on every migration run

The migrator SHALL verify the full applied history against a trusted prefix of the approved release and verify the corresponding live schema. It SHALL apply only the pending versions up to the approved target. An empty authorized database can start with no history.

#### Scenario: Advance a known applied prefix

- **WHEN** an authorized database matches a trusted earlier prefix and its live schema matches that prefix
- **THEN** only the pending approved versions apply and the resulting schema and history are verified

#### Scenario: Repeat at the verified target

- **WHEN** the database already has the target history and the matching schema
- **THEN** the migrator reports verification success without changing the schema, history, or application data

#### Scenario: Refuse untrusted history or drift

- **WHEN** a populated schema has no trusted history, history is missing a version or contains an unexpected or newer version, or the catalog disagrees with the history
- **THEN** migration fails before writing and leaves the database available for inspection

### Requirement: Serialize migration against each database

The system SHALL permit only one migration writer per database with bounded lock acquisition and execution. The lock SHALL cover authoritative history inspection through post-migration verification. Losing the lock SHALL stop the active attempt and block activation until the database is reconciled.

#### Scenario: Two runners target the same database

- **WHEN** one runner holds the migration lock and a second runner attempts an overlapping migration
- **THEN** the second runner either times out without writing or obtains the lock after release and checks the current history and schema before writing

#### Scenario: The lock is lost while a migration runs

- **WHEN** the lock-owning session is lost during migration
- **THEN** that runner cannot continue applying changes after another runner can acquire the lock
- **AND** the interrupted attempt reports failure and cannot authorize activation pending reconciliation

### Requirement: Preserve committed progress on failure

Each migration SHALL apply its changes and record its successful version in one transaction by default. An approved exception SHALL have a reviewed recovery procedure and a failed-run rehearsal. A batch spanning databases SHALL report each outcome, retain committed progress, and withhold activation until every target is verified.

#### Scenario: A transactional migration fails

- **WHEN** a statement fails partway through a transactional migration
- **THEN** changes from that migration are rolled back with no successful entry for its version

#### Scenario: A later database fails

- **WHEN** one database advances and a later database fails or has an unknown outcome
- **THEN** the batch fails, reports the outcome of each database, preserves the earlier commits, and withholds activation

#### Scenario: Resume after reconciliation

- **WHEN** the actual histories and schemas have been reconciled and the same approved migration batch is safe to resume
- **THEN** the batch rechecks every database and advances only the verified pending work

### Requirement: Enforce database roles

The system SHALL give dedicated migration roles the schema and history privileges for their owned databases. Application roles SHALL have only the reads, writes, sequence privileges, and history reads needed for service operation and verification. They SHALL have no application-schema DDL rights, direct or inherited object ownership, or write access to migration history.

#### Scenario: Migrate and operate with distinct credentials

- **WHEN** the provisioned migrator applies its owning service's schema and the application starts with its runtime role
- **THEN** both can complete their permitted operations with their own credentials and the runtime role remains scoped to its database

#### Scenario: A role attempts an out-of-scope write

- **WHEN** an application role attempts to modify schema or history, assume the migration role, or access another service's data, or a migration role targets another owner's schema
- **THEN** its privileges or target verification reject the attempt

### Requirement: Verify schema during service startup

Each PostgreSQL-owning service SHALL verify its own schema and migration history using read-only checks during startup. It SHALL fail startup before serving requests or processing background work if it cannot establish compatibility. Runtime startup SHALL leave schema and history unchanged.

#### Scenario: The service starts with a compatible schema

- **WHEN** the service starts with an approved compatible version and the required schema structure
- **THEN** it can start serving using its runtime role without altering schema or history

#### Scenario: The service starts with a missing or incompatible schema

- **WHEN** required history or schema is absent, incompatible, or unreadable
- **THEN** the service reports a startup failure before serving or starting background work

### Requirement: Gate local activation on current verification

Both containerized and direct local startup SHALL wait for healthy PostgreSQL and successful verification of all three service-owned databases for the current checkout and target. A completed migration run from an earlier checkout or another target SHALL NOT satisfy the gate.

#### Scenario: Start a fresh local environment

- **WHEN** the three databases have been provisioned and PostgreSQL is ready
- **THEN** the local startup workflow enables the database-owning services only after all three migrations and verifications succeed

#### Scenario: An earlier migration run is present

- **WHEN** a completed run belongs to a different checkout, migration bundle, or database instance
- **THEN** local startup waits for verification of the current checkout and target

#### Scenario: One local database does not pass verification

- **WHEN** PostgreSQL is unready or any required migration or verification fails
- **THEN** the startup workflow does not activate the application services

### Requirement: Protect local fixtures and reset targets

Development seeding SHALL be an explicit, rerunnable operation performed after schema verification. An existing database reset SHALL require explicit approval of the exact disposable local target. The workflow SHALL refuse shared, managed, unrecognized, and ambiguous targets and keep stale broker, cache, and object state out of the new fixture by isolation or separately approved cleanup.

#### Scenario: Repeat a seed after schema verification

- **WHEN** the operator explicitly repeats a seed against the verified schema
- **THEN** seeding follows its existing rerun behavior and creates no duplicate fixture data

#### Scenario: Reset approval is missing or the target is ineligible

- **WHEN** a reset request lacks exact approval or targets a shared, managed, unrecognized, or ambiguous database
- **THEN** the workflow rejects the reset without deleting data

#### Scenario: Related fixture state is stale

- **WHEN** the local cutover starts with broker, cache, or object state from an earlier dataset
- **THEN** it uses isolated state or requires separate, specifically authorized cleanup before reusing that state

### Requirement: Hold protected promotion pending the managed gate

A release containing the startup cutover SHALL be ineligible for protected promotion until the managed migration gate is implemented and rehearsed. The required evidence SHALL include verified schemas for all owning services and a compatible, schema-write-free application rollback target.

#### Scenario: Promote the cutover before the managed gate is proven

- **WHEN** promotion is requested and evidence of the managed gate and rollback rehearsal is missing or unverified
- **THEN** the protected release controls block the candidate before App or Judge activation
