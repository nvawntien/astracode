# progress.md — azure-walking-skeleton

<!-- Template: docs/process/templates/progress.md. Overwrite this file at the end of every session; keep it under 40 lines. -->

## Verified state

- Branch / worktree — `feature/azure-walking-skeleton`, [PR #73](https://github.com/nvawntien/astracode/pull/73).
- Last verify run — `make test`, `make test-db`, strict OpenSpec (11), `actionlint` and shell checks passed.
- Tasks done — 7/15, Phase A. Provider mocks (10 environment, 3 S4), reviewed apply (6), cloud-init schema/systemd/nft, strict overlays and native admission passed. App activation and smoke (22), PostgreSQL writer-fence and release policy/delivery (10) and package tests passed. [Reproduction and results](../../../docs/evidence/m0-13-phase-a.md#simplified-candidate-offline-verification)

## Last session

- Replaced controller-owned startup and custom authentication with manual owner-approved startup, native shutdown and separately approved automated delivery. The App journal preserves release, migration, permit and recovery fencing. [Proposed ADR-0013](../../../docs/architecture/adr/0013-staging-lifecycle-control-plane-and-identity.md)
- Initial VM creation without off-time history and single missing-VM recovery passed offline, including wrong-plan, wrong-disk and wrong-NIC refusal. S3 must confirm the real ARM and native schedule behavior.

## Broken or unverified

- Independent ADR and product review, Task 2.1, actual Azure native schedule eligibility, App-only Run Command and GitHub federation denials, GHCR and S4 access, and actual cloud costs are pending.
- S3 still needs separately authorized workflow registration, isolated deployment and the actual ADR-0012 sandbox and lifecycle drills. No S3/S2 acceptance has been claimed.

## Next action

- Next task — Task 2.1 following separate authorization. Use the [S4 bootstrap](../../../infra/azure/README.md#task-22-first-time-s4-bootstrap) and [S3 provision and deploy](../../../infra/azure/README.md#s3-provision-and-deploy) procedures when approved.
- Azure operations, IAM changes, workflow activation and merging require separate authorization.
