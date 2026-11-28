# progress.md — azure-walking-skeleton

<!-- Template: docs/process/templates/progress.md. Overwrite this file at the end of every session; keep it under 40 lines. -->

## Verified state

- Branch / worktree — `feature/azure-walking-skeleton`, [PR #73](https://github.com/nvawntien/astracode/pull/73).
- Tasks done — 7/15, Phase A. Task 2.1 is in progress.
- Local verification — `make test-quick`, `make test`, strict OpenSpec (11), Terraform validate and mocked tests (6 S4, 10 environment), release policy tests and `actionlint` passed.

## Last session

- Recorded owner evidence for provider metadata, S4 names and empty inventory, credit, budgets and operator readiness. Prepared a staged S4 bootstrap. Internet reachability applies only to Entra-authenticated receipts. [Preflight evidence](../../../docs/evidence/m0-13-phase-a.md#simplified-architecture-preflight)
- [Draft PR #74](https://github.com/nvawntien/astracode/pull/74) registers S3 and canonical workflows and retires the legacy definitions. Existing main CI is intact. Both enable flags were unset.

## Broken or unverified

- Task 2.1 still needs the protected GitHub transition and approval/federation readiness, private S4 inputs and exact-plan review. The proposed acc5 backup grant awaits explicit approval.
- Live S4 storage and receipt checks belong to 2.2. Actual S3 schedule creation, VM Run Command, isolation, recovery and deallocation belong to 2.3–2.4.

## Next action

- Review the [maintenance draft](https://github.com/nvawntien/astracode/pull/74) and prepare the [private S4 variables and bootstrap plan](../../../infra/azure/README.md#task-22-first-time-s4-bootstrap). Apply only after separate authorization.
