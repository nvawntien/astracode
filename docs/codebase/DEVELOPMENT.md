# Development workflow

## Prerequisites

Use Go 1.25.8, Docker Engine with Compose 2.24.4+, and Node.js 22.12+ in the
Node 22 series for the frontend. The migration image includes the official
Goose v3.30.0 CLI pinned by OCI digest. Docker builds the migration image
without a host Go toolchain.

## Run the full stack

Prepare the three ignored files under `environment/` and the local Envoy JWK
using the root quick start. [Quick start](../../README.md#start-the-local-judge-stack)

```bash
docker compose --profile dev --profile worker up -d --build
```

PostgreSQL must be healthy before the Goose job starts. The job migrates Auth,
Problem and Submission sequentially, then Compose starts them. Use `--build`
after migration changes so Compose uses an image containing the current SQL.
If a migration fails, inspect `docker compose logs migrate`, fix the cause,
and rerun. Goose skips applied versions and retains earlier committed work.
Run one migration invocation at a time.

The local database owners are `auth_app`, `problem_app` and
`submission_app`. You can override their development passwords through
`ASTRA_AUTH_DB_PASSWORD`, `ASTRA_PROBLEM_DB_PASSWORD`, and
`ASTRA_SUBMISSION_DB_PASSWORD` before the first start. The init script runs
when the PostgreSQL volume is empty. Changed environment values require
updating the corresponding existing database password. Set
`ASTRA_DEV_POSTGRES_PORT=55432` on the Compose command if host port 5432 is
occupied. The stack still connects to `postgres:5432` internally.

### Start with fresh local data

For a volume from a previous setup, keep its data and start a fresh Compose
project. Stop the old project's containers first with `docker compose down`
using the old project name and its Compose files. This keeps its named volumes
and frees the fixed container names and ports. For example, start a new
project with:

```bash
docker compose -p astracode-fresh --profile dev --profile worker up -d --build
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
docker compose run --build --rm migrate
```

For direct execution, set `ASTRACODE_LOCAL_CONFIG` to the service config
directory, set `DATABASE_HOST=127.0.0.1` and `DATABASE_PORT` to the published
port, and supply that service's local `DATABASE_USER` and `DATABASE_PASSWORD`.
Use the existing local service environment with loopback endpoints for the
other dependencies. From the service directory run `go run ./cmd/server`.
The server binds to loopback with this configuration. Use Compose for
gateway and official judging integration.

To seed curated Problem tags, use the Problem database connection settings and
run `go run ./cmd/seed-tags` from `services/problem`. Repeating the seed
preserves existing rows.

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

Run the PostgreSQL suites against the current checkout.

```bash
bash scripts/test-postgres-integration.sh
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

See [DATA.md](DATA.md) for database ownership. Validate gateway
configuration with `python3 envoy/tests/integration.py`.
