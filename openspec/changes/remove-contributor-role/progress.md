# progress.md — remove-contributor-role

## Verified state

- Branch / worktree — `feat/remove-contributor-role`
- Baseline — `QUICK=1 scripts/verify.sh` passed with Go 1.25.8 in a disposable checkout.
- Task 1.1 — `(cd pkg && go test ./rbac ./middleware)` passed, including supported-role ordering, rejection of unsupported roles and missing claims, and the session cutoff regression.
- Task 1.2 — `(cd services/auth && go test ./...)` passed, including supported credential issuance, refresh role retention and reuse, and rejection of unsupported Admin assignments.
- Task 1.3 — `python3 envoy/generate.py --check`, `python3 envoy/tests/route_parity.py`, `python3 envoy/tests/integration.py`, and `docker compose config --quiet` passed. The Envoy integration suite covered both generated bootstraps and skipped the optional old-gateway comparison.
- Task 2.4 — Both prescribed Problem and Submission test commands passed. The role matrices cover hidden ownership, denied dispatch and durable writes, and canonical metadata forwarding.
- Task 3.1 — `(cd services/submission && go test ./internal/application/usecase/user ./internal/application/usecase/admin ./internal/adapter/inbound/http/...)` passed, covering owner history, profile statistics, source detail and staff views.
- Task 3.2 — The prescribed Submission use-case, HTTP, and stream suites passed, with owner issuance and non-owner denial for all three roles and rejection of the retired role.
- Task 4.1 — `(cd website && npm test && npm run typecheck)` passed with 620 tests in 24 files. Contributions tests cover navigation, redirects, draft creation and deletion, Published read-only state, and mutation feedback.
- Addendum — `openspec validate remove-contributor-role --strict --no-interactive` and `git diff --check` passed. A read-only merge preview preserved both existing CM-20 scenario names and found one resulting CM-20 requirement. The scope check identified only the four addendum artifacts.
- Resume baseline — `QUICK=1 scripts/verify.sh` passed again with Go 1.25.8 in the disposable baseline checkout.
- Task 2.1 — The prescribed Problem use-case and HTTP suites passed. `TestProblemMutationPostgresConcurrency` passed all six cases against fresh PostgreSQL 15.6 with observed lock waits, including rollback of content and tags and preservation of the package on soft delete.
- Task 2.2 — The prescribed admin Problem, taxonomy, own-catalog, and Problem HTTP Go suites passed.
- Task 2.3 — The prescribed Problem suites passed, including ZIP bounds. `TestTestcaseMutationPostgresConcurrency` passed all eleven cases on fresh PostgreSQL 15.6 with a controlled object-storage fixture, including retention and cleanup retry. `(cd workers/judge && go test -race ./internal/adapter/outbound/testcase)` passed.
- Task 4.2 — Full `scripts/verify.sh` passed in a disposable checkout with Go 1.25.8, including all Go suites and race runs, 620 website tests, the Next.js build, Compose validation and strict OpenSpec validation. The focused strict validation and `git diff --check` also passed.

## Last session

- 2026-11-21 — The project owner approved the concurrency design extension for tasks 2.1 and 2.3, including short PostgreSQL row locks, immutable staged objects, metadata-first deletion, safe reconciliation, and object-aware worker cache generations.
- The project owner confirmed the focused Gate 1 addendum for CM-20 at commit `1cfbda7`.
- Completed the locked Problem and testcase writes, local object reconciliation, worker cache generations, supported-role SSE checks, and User Contributions workspace.

## Broken or unverified

- The website build reports six existing lint warnings. Testcase storage failures and retries were exercised with a controlled fixture alongside disposable PostgreSQL.

## Next action

- Implementation review.

## Notes for the reviewer

- The project owner approved regenerating the tracked `envoy/envoy.prod.yaml` as part of task 1.3. Verification used an isolated local Docker network.
- Documentation impact — `rg -ni 'contributor|contributions' docs/codebase envoy/README.md services/auth/README.md services/problem/README.md services/submission/README.md website/README.md openspec/specs/content-moderation/spec.md` audited the role references. Architecture, Domain, Flows, Services and Data need the User ownership, locked mutation and testcase retention descriptions. Envoy and Submission READMEs need the three-role list, and the website README needs the User workspace description. Auth and Problem READMEs were included in the scan and have no matching retired-role references.
- Archive disposition — OpenSpec 1.13.0 retains the existing content-moderation Purpose and the scenario headings required by name. Record any wording that remains at archive for the subsequent documentation-only change described in the approved design.
