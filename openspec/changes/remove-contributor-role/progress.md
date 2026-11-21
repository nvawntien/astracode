# progress.md — remove-contributor-role

## Verified state

- Branch / worktree — `feat/remove-contributor-role`
- Baseline — `QUICK=1 scripts/verify.sh` passed with Go 1.25.8 in a disposable checkout.
- Task 1.1 — `(cd pkg && go test ./rbac ./middleware)` passed, including supported-role ordering, rejection of unsupported roles and missing claims, and the session cutoff regression.
- Task 1.2 — `(cd services/auth && go test ./...)` passed, including supported credential issuance, refresh role retention and reuse, and rejection of unsupported Admin assignments.
- Task 1.3 — `python3 envoy/generate.py --check`, `python3 envoy/tests/route_parity.py`, `python3 envoy/tests/integration.py`, and `docker compose config --quiet` passed. The Envoy integration suite covered both generated bootstraps and skipped the optional old-gateway comparison.
- Task 2.4 — Both prescribed Problem and Submission test commands passed. The role matrices cover hidden ownership, denied dispatch and durable writes, and canonical metadata forwarding.
- Task 3.1 — `(cd services/submission && go test ./internal/application/usecase/user ./internal/application/usecase/admin ./internal/adapter/inbound/http/...)` passed, covering owner history, profile statistics, source detail and staff views.
- Addendum — `openspec validate remove-contributor-role --strict --no-interactive` and `git diff --check` passed. A read-only merge preview preserved both existing CM-20 scenario names and found one resulting CM-20 requirement. The scope check identified only the four addendum artifacts.

## Last session

- Prior implementation — RBAC, Auth, Envoy, Problem read paths, draft Run/Submit admission, and Submission history/detail authorization.
- 2026-11-21 — The project owner approved the concurrency design extension for tasks 2.1 and 2.3, including short PostgreSQL row locks, immutable staged objects, metadata-first deletion, safe reconciliation, and object-aware worker cache generations.
- Addendum artifacts — [CM-20](specs/content-moderation/spec.md#requirement-cm-20-testcase-package-deletion), [design](design.md#concurrent-problem-and-testcase-mutations), and [tasks](tasks.md#2-problem-authoring-and-draft-execution) record the extension and verification criteria.

## Broken or unverified

- Focused Gate 1 addendum for the CM-20 contract change is pending. Tasks 2.1 and 2.3 remain unchecked, and implementation of the concurrency extension is paused.
- Task 2.2 focused read and staff authorization checks passed. Its full prescribed suite includes pending draft mutation changes.
- Deterministic PostgreSQL concurrency, storage cleanup, worker cache regression, and full implementation verification remain pending.

## Next action

- Review and confirm the focused Gate 1 addendum for CM-20. Record the decision before implementing and testing the concurrency extension.

## Notes for the reviewer

- The project owner approved regenerating the tracked `envoy/envoy.prod.yaml` as part of task 1.3. Verification used an isolated local Docker network.
