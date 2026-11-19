# AGENTS.md

AstraCode is a Go 1.25.8 multi-module online-judge backend: Auth, Problem, Submission, and Judge Worker share `pkg/`; `website/` is a separate Next.js client. Read `docs/codebase/`—especially `ARCHITECTURE.md`, `FLOWS.md`, and `DATA.md`—before changing architecture.

Key boundaries:

* Keep business rules in `internal/domain`/`internal/application`; adapters implement HTTP, gRPC, Kafka, persistence and storage behind application ports.
* Each service owns its PostgreSQL database (`auth_db`, `problem_db`, `submission_db`); use APIs/events, never another service's tables.
* Preserve the submission transaction + outbox path, Kafka contracts in `pkg/judge/`, and `AttemptID` result correlation. Do not expose official testcase inputs/expected outputs.
* Gateway JWT validation propagates `X-User-*` headers; direct service endpoints must not become an alternate untrusted auth path. Treat the privileged executor sandbox as a security boundary.
* `gateway/settings/` must stay aligned with service routers. Proto source is in `proto/`; generated Go is `pkg/pb/`.

Useful checks are module-scoped: `go test ./...`, `go vet ./...`, and `gofmt -w <changed-go-files>` from the relevant module; `docker compose config --quiet` validates local Compose. Start the complete local stack with `docker compose --profile dev --profile worker up -d --build`. No root Makefile, migration runner, or checked-in protobuf/Wire generation command exists—do not invent one without first establishing the toolchain. CI lives in `.github/workflows/` (`ci.yml`, `openspec.yml`, `release-images.yml`, `deploy-production.yml`); see `docs/codebase/DEVELOPMENT.md`.

## Hard constraints (read first)

1. Never edit `openspec/specs/*` directly. Behaviour changes only through a change folder and archive.
2. Work only inside the current change's `tasks.md` scope. Anything else: stop and report.
3. Never weaken sandbox limits, authentication/JWT handling, the transactional outbox or attempt-aware result handling without an approved change that says so.
4. Never change `proto/`, event schemas or gateway routes without a contract update marked BREAKING / NON-BREAKING in the change.
5. Never commit secrets, real credentials, the development JWK or `.env` files. Never put personal data in logs or LLM prompts.
6. Premium content must be checked server-side on every read path; never rely on the UI.
7. Do not mark a task done without evidence (test name or command output) in `progress.md`.
8. Do not deploy, tag releases or touch production configuration.


## Commands

```bash
# Local stack: copy env templates once (files are git-ignored), then start
for f in postgres redis service; do
  [ -f environment/$f.env ] || cp environment/$f.env.example environment/$f.env
done
docker compose --profile dev --profile worker up -d --build
(cd website && { [ -f .env.local ] || cp .env.example .env.local; } && npm ci && npm run dev)

# Verify — Go modules, website, Compose config, OpenSpec (skipped while nothing exists)
QUICK=1 scripts/verify.sh   # session start: no race tests, no website build
scripts/verify.sh           # before claiming done
```

## Session protocol

Start:
1. Read this file, then the `AGENTS.md` of the module you will touch, if one exists.
2. Read `openspec/changes/<change-id>/progress.md`, then `tasks.md`; read `proposal.md`, `design.md` and delta specs as needed.
3. Run the verify commands. If the baseline is red, stop and report; do not build on red.

Work:
4. One task at a time. If behaviour is unclear, read the relevant spec; if still unclear, stop and ask.
5. Keep changes minimal and inside the task.

End:
6. Run verify. Tick tasks only with evidence.
7. Overwrite `progress.md` (template: `docs/process/templates/progress.md`).
8. Commit with a message referencing the change ID. Leave no uncommitted work.

## Where to look (only when relevant)

Some paths below are created by upcoming changes. If a path does not exist, say so instead of searching.

| Need | Read |
|---|---|
| Behaviour of capability X | `openspec/specs/X/spec.md` |
| Current code structure, flows, data ownership | `docs/codebase/ARCHITECTURE.md`, `FLOWS.md`, `DATA.md`, `SERVICES.md` |
| Target structure and decisions | `docs/architecture/README.md` → the relevant document; `docs/architecture/adr/` |
| API / event contracts | `docs/architecture/contracts/README.md`, `proto/` |
| Quality targets referenced by a change | `docs/product/nfr.md` (only the cited NFR IDs) |
| Terms | `docs/process/glossary.md` |
| Workflow, gates, definition of done | `docs/process/workflow.md` |

Do not read product documents during implementation. At propose time, use only the F-xx section given in the prompt.

## Hard constraints (repeat)

- No direct edits to `openspec/specs/*`.
- Stay inside `tasks.md`.
- No secrets; no premium checks in the UI only; no done without evidence.