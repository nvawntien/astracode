# database-schema-migrations Specification

## Purpose
Define how each service manages its database schema versions and verifies schema
compatibility before startup while preserving existing data and behavior.

## Requirements

### Requirement: Service-owned schema versions
Each PostgreSQL-owning service SHALL maintain its own ordered versioned schema
and migration history. Released migrations SHALL remain immutable.

#### Scenario: Initialize fresh databases
- **WHEN** all owning databases are empty and the migration job runs successfully
- **THEN** each database has its initial schema and its own recorded version

#### Scenario: Rerun an applied sequence
- **WHEN** the migration job reruns the same successfully applied versions
- **THEN** it adds neither duplicate schema objects nor duplicate history entries

#### Scenario: Advance one database
- **WHEN** only one owning service adds a migration to its sequence
- **THEN** only that database's migration version advances

### Requirement: Migration prerequisite for startup
The local stack SHALL wait for PostgreSQL readiness and successful migration of
all owning databases before application startup. Changed migration inputs
SHALL require a fresh migration job. Future deployments SHALL execute
migrations successfully before activating applications.

#### Scenario: Changed inputs and failed migration
- **WHEN** the stack is built and started with changed migration inputs that fail
- **THEN** the prior successful job does not authorize application startup

### Requirement: Read-only service compatibility check
Each owning service SHALL check its expected database schema version before
starting work. Services SHALL perform no runtime schema DDL.

#### Scenario: Missing or incompatible version
- **WHEN** a service starts without its expected schema version
- **THEN** it refuses to start without initializing or changing the schema

### Requirement: Preserve existing data and behavior
The migration workflow SHALL preserve service ownership and existing business
behavior. Seeds SHALL remain explicit. Existing local databases SHALL be
preserved unless a reset of a specific disposable target is explicitly authorized.

#### Scenario: Fresh local development and testing
- **WHEN** a contributor starts a fresh local stack or a fresh PostgreSQL test fixture
- **THEN** migrations initialize its schema before application or test writes
- **AND** the workflow leaves other developer databases intact
