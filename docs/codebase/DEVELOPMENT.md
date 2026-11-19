# Development workflow

## Prerequisites and configuration

Use Go 1.25.8 (the workspace and Docker builders declare it), Docker Engine/Compose, and Node/npm for `website/`. Runtime configs live in `services/*/config/config.yaml` and `workers/judge/config/config.yaml`; Compose reads `environment/postgres.env`, `environment/redis.env`, and `environment/service.env`. Do not commit real secrets. Viper maps dotted config paths to uppercase underscore environment names, such as `DATABASE_PASSWORD` and `JWT_ACCESS_SECRET`.

## Run the full stack

From repository root, provision the ignored `envoy/symmetric.json` using `envoy/gen_jwk.go` and the same `JWT_ACCESS_SECRET` as Auth (see [gateway setup](../../envoy/README.md)). Then:

```bash
docker compose --profile dev --profile worker up -d --build
docker compose ps
docker compose down
```

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

There is no root Makefile; `scripts/verify.sh` runs the standard checks (`QUICK=1` skips race tests and the website build). Otherwise use module-scoped commands. GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main`, called by release automation | Go test/vet/race per module, website typecheck and build, Compose validation, deployment-script checks, judge benchmark harness checks |
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

For website development, the scripts in `website/package.json` are `npm run dev` (`next dev -p 3000`), `npm run build` (`next build`), `npm run start` (`next start -p 3000`), and `npm run typecheck` (`tsc --noEmit`). `node_modules` and `.next` are generated local artifacts and should not be used as architecture evidence.

## Migrations and operational checks

There is no migration runner. Startup repository constructors call GORM `AutoMigrate`, and `infra/postgres/init.sql` only creates the three databases. Before introducing a migration tool or altering schemas, consult [DATA.md](DATA.md) and preserve service database ownership. Validate gateway configuration with the pinned Envoy image using `python3 envoy/tests/integration.py`; do not assume all service-local routes are gateway-exposed.
