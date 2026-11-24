# Development workflow

## Prerequisites and configuration

Use Go 1.25.8 for application builds, checks and local JWK generation. The
migration runner builds in an isolated module using Go 1.26.11, Goose v3.30.0
and a verified Linux amd64 or arm64 checksum. Use Docker Engine with Compose
2.24.4+, Bash, jq, OpenSSL, and flock. The frontend uses Node.js 22.12+ in the
Node 22 series and npm.

Runtime configuration lives under `services/*/config/` and
`workers/judge/config/`. Local Compose uses the ignored
`environment/postgres.env`, `environment/redis.env` and
`environment/service.env` files. Viper maps dotted config paths to uppercase
underscore names such as `JWT_ACCESS_SECRET`.

## Run the full stack

Prepare the three local env files and generate or verify the ignored Envoy
JWK using the root quick start. Use a named development project on an explicit
local Docker context.

```bash
bash scripts/local-stack.sh default astracode-dev-local up
docker --context default compose -p astracode-dev-local ps
```

The launcher pairs the base file with `docker-compose.local.yml`. It verifies
the local Docker engine, project and PostgreSQL volume, enrolls an empty
instance, and waits for healthy PostgreSQL. The one-shot migrator connects
with distinct migration roles. Auth, Problem, and Submission start only
after verification succeeds for all three owners with a fresh receipt for
the current run. Each service also checks its live schema read-only.

The launcher stores enrollment, separate role credentials and the migration
journal in an owner-only directory under
`${XDG_STATE_HOME:-$HOME/.local/state}/astracode/migrations`. Compose and direct
Go share that state for the same context and project. The three services load
their own runtime role credentials. Keep the state directory with the
enrolled database and out of source control.

Envoy is available at `http://localhost:8080`. The local launcher also enables
MailHog, Kafka UI, and the Worker. Envoy waits for JWK provisioning. Follow
the key replacement and activation procedure if the Auth access secret
changes. [Quick start](../../README.md#start-the-local-judge-stack) ·
[Envoy configuration](../../envoy/README.md#configuration-and-secrets)

```bash
docker --context default compose -p astracode-dev-local down --remove-orphans
```

That command preserves named data volumes. Use a fresh `astracode-dev-*`
project and distinct published ports for independent rehearsals. The local
overlay gives each project its own PostgreSQL, Kafka, Redis, MinIO, and Worker
cache state. Set the `ASTRA_DEV_*_PORT` overrides in the local Compose file's
interpolation inputs when running parallel projects. Reset is a separate
maintainer-approved operation scoped to an exact context, project, and
disposable volume or database. The launcher rejects unknown volumes and
requires a fresh project when enrollment does not match.
[Schema policy](../architecture/adr/0006-schema-migration-policy.md)

## Run the services directly with Go

```bash
bash scripts/local-stack.sh default astracode-dev-local go
```

This starts the local database and shared dependencies, verifies all three
migrations, and then builds and runs Auth, Problem, and Submission with
Go 1.25.8. The HTTP and gRPC listeners bind to loopback. Stop the foreground
command to stop those processes. Use the full Compose stack for gateway and
official judging integration. For simultaneous local setups, use the
`ASTRA_DEV_AUTH_HTTP_PORT`, `ASTRA_DEV_PROBLEM_HTTP_PORT`,
`ASTRA_DEV_SUBMISSION_HTTP_PORT`, `ASTRA_DEV_AUTH_GRPC_PORT`, and
`ASTRA_DEV_PROBLEM_GRPC_PORT` overrides.

Seed curated Problem tags explicitly when needed. Running the same command
again keeps existing rows.

```bash
bash scripts/local-stack.sh default astracode-dev-local seed-tags
```

## Migration review and recovery

Preview the digest for local SQL or catalog changes with the `plan` command.
Review the changes, then pass the exact digest to the launcher as
`ASTRACODE_APPROVE_DIRTY_BUNDLE`. Changes to migration inputs invalidate that
approval and previous receipts even if the Git commit stays the same.
Fixtures require committed migrations and catalogs.

When one database fails, the launcher reports verified, refused, uncertain,
and unattempted targets. It preserves earlier commits and does not activate
services for that run. For an uncertain write, keep the exact source,
migrator pin, journal, and enrollment. After checking the failure, retry
the same approved bundle with `ASTRACODE_RECONCILE_MIGRATIONS=true`. The runner
reacquires the lock and reconciles the ledger and catalog against the
recorded intent before proceeding. An unexpected state requires a reviewed
forward repair or a tested restore. Keep the production release workflow
under the protected promotion hold. [Release and recovery controls](../DEPLOYMENT.md#m1-02-protected-promotion-hold)

## Build, test and quality checks

Run `QUICK=1 scripts/verify.sh` at session start and `scripts/verify.sh` before
finishing a change. Both modes run Go tests and vet for shared packages and
services, website typechecking, local Compose configuration validation, and
strict OpenSpec validation when specs or active changes exist. Both modes reuse
healthy website dependencies and run `npm ci` from the lockfile when the
installed dependencies are missing or inconsistent.

Full verification adds Go race tests, the judge benchmark module's tests, vet
and race tests, syntax checks for both benchmark collectors, and the website
unit tests and production build. The full script does not run CI's separate
website lint warning-budget and tooling-format checks, gateway client contract
test, Envoy suite, production Compose assertions, deployment-script checks,
PostgreSQL integration suites, or container image builds.

Run the PostgreSQL suites from a checkout with committed migration and
catalog inputs.

```bash
bash scripts/test-postgres-integration.sh
```

The script creates a fresh PostgreSQL 15.6 container for each suite on a
disposable loopback port, verifies the empty target at enrollment, and applies
the pinned migrations. The suites verify the fixture identity, schema and
empty application data before writing with fixed runtime roles. The job
requires a pass without any skipped suite for
`TestProblemMutationPostgresConcurrency`,
`TestTestcaseMutationPostgresConcurrency`, and
`TestGetCurrentDetailPostgresSnapshots`.

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main`, called by release automation | Go test/vet/race, PostgreSQL integration suites (`postgres-integration` job), judge benchmark and collector checks, website typecheck/lint/tooling format/unit tests/gateway client contract/build, Envoy checks, development and production Compose validation, deployment-script checks, image builds |
| `openspec.yml` | pull requests targeting `develop` or `main`, and pushes to them | `openspec validate --all --strict` (skipped while no specs or active changes exist) |
| `release-images.yml` | pushes to `develop`, `v*.*.*` version tags, manual dispatch (full commit SHA) | Publishes container images to GHCR on each trigger; images are published, not deployed (staging deployment is planned: M0-13) |
| `deploy-production.yml` | manual | Deploy a published release tag to production (see [DEPLOYMENT.md](../DEPLOYMENT.md)) |

Tests are colocated with source (`*_test.go`) across shared packages, services, and worker adapters/use cases. A safe non-writing discovery/build sequence is:

```bash
go test ./pkg/...
(cd services/auth && go test ./...)
(cd services/problem && go test ./...)
(cd services/submission && go test ./...)
(cd workers/judge && go test ./...)
docker compose config --quiet
```

Format modified Go files with `gofmt -w <files>`. Wire injectors are in each `cmd/server/wire.go` and generated output is checked in as `wire_gen.go`; no Wire generation command or `buf`/`protoc` configuration was found, so do not guess a generation command. Proto sources are `proto/problem/v1/problem.proto` and `proto/judge/v1/run.proto`; generated Go is checked in under `pkg/pb/`.

For website development, use `npm run dev` (`next dev -p 3000`), `npm run build` (`next build`), `npm run start` (`next start -p 3000`), `npm run typecheck` (`tsc --noEmit`), and `npm test` (`vitest run`) from `website/`. `node_modules` and `.next` are generated local artifacts and should not be used as architecture evidence.

## Migrations and operational checks

There is no migration runner. Startup repository constructors call GORM `AutoMigrate`, and `infra/postgres/init.sql` only creates the three databases. Before introducing a migration tool or altering schemas, consult [DATA.md](DATA.md) and preserve service database ownership. Validate gateway configuration with the pinned Envoy image using `python3 envoy/tests/integration.py`; do not assume all service-local routes are gateway-exposed.
