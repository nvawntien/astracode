# Development workflow

## Prerequisites and configuration

Use Go 1.25.8 for Go checks and local JWK generation, Docker Engine/Compose, and Node.js 22.12+ in the Node 22 series with npm for `website/`. Runtime configs live in `services/*/config/config.yaml` and `workers/judge/config/config.yaml`; Compose reads `environment/postgres.env`, `environment/redis.env`, and `environment/service.env`. Do not commit real secrets. Viper maps dotted config paths to uppercase underscore environment names, such as `DATABASE_PASSWORD` and `JWT_ACCESS_SECRET`.

## Run the full stack

The quick start copies missing local env files from their templates and uses
`JWT_ACCESS_SECRET` from `environment/service.env` to create or verify the
ignored `envoy/symmetric.json`. A mismatch stops startup and leaves the key
file intact. [Local stack quick start](../../README.md#start-the-local-judge-stack)

On startup, the `envoy-jwk` service copies that host file into a named volume
for Envoy and must finish successfully before Envoy starts. If you change the
local Auth access secret, regenerate the key and activate it explicitly.
[Envoy key setup and activation](../../envoy/README.md#configuration-and-secrets)

Check containers with `docker compose ps` and stop the stack with
`docker compose down`.

The worker is profile-gated; omit `--profile worker` to start the API/infrastructure without it. Envoy exposes the gateway at `http://localhost:8080`; MailHog and Kafka UI are dev-profile services. Compose creates databases and Kafka topics automatically through the mounted bootstrap assets.

The checked-in worker profile sets `WORKER_POOL_SIZE=1` and a 512 MiB container memory limit. `WORKER_POOL_SIZE` is the consumer-wide cap for official jobs, not a per-Kafka-claim capacity; keep those settings together until a new workload measurement supports a change.

## Run a Go component locally

Each runtime is a separate Go module but `go.work` links them. From its module directory:

```bash
go run ./cmd/server
go test ./...
go vet ./...
```

The worker accepts `-config` (default `/app/config`), so local usage needs a config directory reachable by that flag. The other Go mains currently load `/app/config` unconditionally; use Docker/Compose or supply that expected path in a local environment. This limitation is derived from their `main.go` files.

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

Three PostgreSQL integration suites skip unless a port variable points at a
disposable PostgreSQL on `127.0.0.1` with the fixture role and a database that
has none of the suite's tables: `TestProblemMutationPostgresConcurrency` and
`TestTestcaseMutationPostgresConcurrency` (`services/problem`,
`ASTRACODE_PROBLEM_MUTATION_TEST_PGPORT`, role and database `problem_fixture` /
`problem_mutation_test`) and `TestGetCurrentDetailPostgresSnapshots`
(`services/submission`, `ASTRACODE_DETAIL_TEST_PGPORT`, `detail_fixture` /
`submission_detail_test`). `scripts/verify.sh` does not start a database, so
run them by hand and recreate the database before each suite:

```bash
docker run -d --name astracode-pg-fixture -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=fixture-admin postgres:15.6-alpine
docker exec astracode-pg-fixture psql -U postgres \
  -c "CREATE ROLE problem_fixture LOGIN PASSWORD 'problem_fixture'" \
  -c "CREATE ROLE detail_fixture LOGIN PASSWORD 'detail_fixture'"
# Before each suite (use submission_detail_test / detail_fixture for the third):
docker exec astracode-pg-fixture psql -U postgres \
  -c "DROP DATABASE IF EXISTS problem_mutation_test WITH (FORCE)" \
  -c "CREATE DATABASE problem_mutation_test OWNER problem_fixture"
(cd services/problem && ASTRACODE_PROBLEM_MUTATION_TEST_PGPORT=55432 \
  go test ./internal/adapter/outbound/persistence/postgres \
  -run '^TestProblemMutationPostgresConcurrency$' -count=1 -v)
docker rm -f astracode-pg-fixture
```

CI's `postgres-integration` job does the same with a PostgreSQL 15.6 service
container and fails when a suite is skipped or does not pass.

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
