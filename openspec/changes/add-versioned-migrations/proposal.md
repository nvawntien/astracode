Addresses: NFR-D05 | Follows: ADR-0011

## Why

AstraCode's first deployment will already use versioned migrations. M1-02
introduces Goose and removes runtime schema DDL. A maintainer scope correction
supersedes the earlier assumption of a production cutover.

## What changes

- Keep the three independent initial SQL migrations and their PostgreSQL 15.6
  parity evidence. Keep GORM repositories, business behavior and contracts.
- Use the pinned official Goose CLI in the existing Compose startup flow.
  Ship the migration files in the job image and require successful migration
  before Auth, Problem and Submission startup.
- Retain a read-only schema compatibility check for each service, explicit
  seeds and the three existing PostgreSQL regression suites.
- Remove the Provider runner and custom migration state and promotion hold.
  Future deployments must successfully migrate before activating applications.
  Managed rollout, backup, release compatibility planning and deployment
  orchestration are outside this change.

## Capability and dependencies

- `database-schema-migrations` records the operational behavior. Existing
  product capabilities and contracts stay intact.
- M0-11 supplies the original decision. M1-03 continues to depend on M1-02.
  [ADR-0006](../../../docs/architecture/adr/0006-schema-migration-policy.md) ·
  [ADR-0011](../../../docs/architecture/adr/0011-local-goose-migrations.md)
