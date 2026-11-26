# Development workflow

## Prerequisites

Use Go 1.25.8, Make, Docker Engine with Compose 2.24.4+, and Node.js 22.12+ in the
Node 22 series for the frontend. The migration image includes the official
Goose v3.30.0 CLI pinned by OCI digest. Docker builds the migration image
without a host Go toolchain.

## Run the full stack

Prepare the three ignored files under `environment/` and the local Envoy JWK
using the root quick start. [Quick start](../../README.md#start-the-local-judge-stack)

```bash
make up
make ps
```

`make up` runs `docker compose --profile dev --profile worker up -d --build`.
`make start` uses the same startup path. `make stop` keeps the containers
and volumes for the next start.
PostgreSQL must be healthy before the Goose job starts. The job migrates Auth,
Problem and Submission sequentially, then Compose starts them. Use `--build`
after migration changes so Compose uses an image containing the current SQL.
If a migration fails, inspect `make logs SERVICE=migrate`, fix the cause,
and rerun. Goose skips applied versions and retains earlier committed work.
Run one migration invocation at a time.

The local database owners are `auth_app`, `problem_app` and
`submission_app`. Each local role runs its own migrations and application
queries. Managed deployments need separate migration and runtime privileges.
You can override the local development passwords through
`ASTRA_AUTH_DB_PASSWORD`, `ASTRA_PROBLEM_DB_PASSWORD`, and
`ASTRA_SUBMISSION_DB_PASSWORD` before the first start. The init script runs
when the PostgreSQL volume is empty. Changed environment values require
updating the corresponding existing database password. Set
`ASTRA_DEV_POSTGRES_PORT=55432` on the `make up` command if host port 5432 is
occupied. The stack still connects to `postgres:5432` internally.

### Start with fresh local data

For a volume from a previous setup, keep its data and start a fresh Compose
project. Stop the old project's containers first with `docker compose down`
using the old project name and its Compose files. This keeps its named volumes
and frees the fixed container names and ports. For example, start a new
project with:

```bash
COMPOSE_PROJECT_NAME=astracode-fresh make up
```

A reset is optional. Obtain separate approval for the exact disposable
PostgreSQL volume, confirm the Docker context and the volume's Compose
project label, and stop that project. Remove only that specific volume
with `docker volume rm <approved-postgres-volume>`, then start the project.
Redis, Kafka, MinIO, and other volumes should stay in place. Prefer a fresh
project when using a different local dataset.

## Run Go services and seeds directly

Apply all migrations explicitly before starting a Go service or seed.

```bash
make migrate
```

`make migrate` runs `docker compose run --build --rm migrate`.
For direct execution, set `ASTRACODE_LOCAL_CONFIG` to the service config
directory, set `DATABASE_HOST=127.0.0.1` and `DATABASE_PORT` to the published
port, and supply that service's local `DATABASE_USER` and `DATABASE_PASSWORD`.
Use the existing local service environment with loopback endpoints for the
other dependencies. From the service directory run `go run ./cmd/server`.
The server binds to loopback with this configuration. Use Compose for
gateway and official judging integration.

Run `make seed` with the local PostgreSQL service running and migrated. It
uses the published port and local Problem credentials to run the existing
`go run ./cmd/seed-tags` command. Repeating the seed preserves existing rows.

## Build, test and quality checks

Run `make test-quick` at session start and `make test` before finishing a
change. Both invoke `scripts/verify.sh` and run Go tests and vet for shared packages and
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

Run the PostgreSQL suites against the current checkout.

```bash
make test-db
```

The script creates a fresh PostgreSQL 15.6 container for each suite on a
disposable loopback port and applies the pinned migrations to a fresh test database. The suites
verify the fixture role, database, schema version and
empty application data before writing with fixed runtime roles. The job
requires a pass without any skipped suite for
`TestProblemMutationPostgresConcurrency`,
`TestTestcaseMutationPostgresConcurrency`, and
`TestGetCurrentDetailPostgresSnapshots`.

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main`, called by release automation | Go test/vet/race, PostgreSQL integration suites (`postgres-integration` job), judge benchmark and collector checks, website typecheck/lint/tooling format/unit tests/gateway client contract/build, Envoy checks, development and production Compose validation, deployment-script checks, image builds |
| `openspec.yml` | pull requests targeting `develop` or `main`, pushes to them, and exact-SHA release calls | `openspec validate --all --strict` (skipped while no specs or active changes exist) |
| `release-images.yml` | protected `develop` pushes | Exact-SHA CI and canonical OCI publication through the protected reusable workflow after registration. |
| `reconcile-releases.yml` | schedule or manual dispatch on protected `main` | Reconciles protected merge history without accepting a SHA input. |
| `rehearsal-checks.yml` | labeled candidate PRs to `develop` | Read-only CI for the reviewed S3 head SHA. |
| `staging-request.yml` | protected `main` dispatch | Reviews the immutable originating request under the appropriate GitHub environment. |
| `promotion-eligibility.yml` | protected `main` dispatch | Checks canonical S2 evidence and the reviewed tag mapping. |
| `deploy-production.yml` | retired | Historical dispatch and credentials are retired through the separate owner-reviewed transition. |

These rows describe the checked-in workflows. M0-13 implements the approval-gated
Azure/k3s delivery model proposed in [ADR-0004](../architecture/adr/0004-azure-topology-and-subscription-layout.md).

Documentation-only PRs skip the Docker build steps and still report all six
required image checks. CI checks both paths of renames. Code, migration SQL,
configuration and tooling changes run the image builds, as do indeterminate
comparisons, pushes to `main`, and release verification calls.

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

## Verify Azure delivery offline

From the repository root, keep the usual `make test` and `make test-db` gates. For M0-13 also validate the pinned Terraform roots with the backend disabled and provider mocks, render both Kustomize overlays and run the strict schema and native API fixture, and validate the synthetic App and Judge cloud-init renders. The managed database fixture uses a disposable PostgreSQL container. The release and controller fixtures use synthetic receipts, identities, time and VM outcomes. Use `actionlint`, `shellcheck`, and shell syntax checks for changed workflow and shell files.

The [Phase A evidence map](../evidence/m0-13-phase-a.md) links exact commands and the S3 and S2 acceptance still required. See the [staging runbook](../architecture/deployment.md) for the protected operator path and [release verification](../../scripts/release/README.md) for CI and default-branch registration.

## Migrations and operational checks

See [DATA.md](DATA.md) for database ownership. Validate gateway
configuration with `python3 envoy/tests/integration.py`.
