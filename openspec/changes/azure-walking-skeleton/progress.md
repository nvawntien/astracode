# progress.md — azure-walking-skeleton

<!-- Template: docs/process/templates/progress.md. Overwrite this file at the end of every session; keep it under 40 lines. -->

## Verified state
- Branch / worktree — `feature/azure-walking-skeleton` in the current repository worktree.
- Baseline — `make test-quick` passed on Go 1.25.8 with writable temporary directories and loopback access. Go tests and vet, website typecheck, Compose configuration and strict OpenSpec validation passed. `openspec validate azure-walking-skeleton --strict` passed, and all 11 OpenSpec items passed.
- Last verify run — `make test` passed, including Go test/vet/race, 620 website tests, the website build and Compose configuration. `terraform fmt -check -recursive infra/azure`, backend-disabled read-only-lock init and `terraform validate` passed.
- Tasks done (with evidence) — 1 of 15. Task 1.1 passed `terraform test -var-file=offline.tfvars.example` in bootstrap (3 cases) and environment (7 cases). `bash infra/azure/environment/tests/check-retained-disk.sh` confirmed bound state retargeting and App disk replacement are rejected using mock state.

## Last session
- Goal — Implement task 1.1 only in Phase A offline.
- Changed — Added the [Terraform roots and offline checks](../../../infra/azure/README.md) with pinned Terraform 1.13.5 and AzureRM 4.59.0. Registry locks were verified against HashiCorp signatures. The [Round 2 decision](review-gate1-round2.md) records approval of the M0-13 sequencing exception and Phase A offline only. The [Round 1 review](review-gate1.md) records the original verdict.

## Broken or unverified
- The owner confirmed Gate 1 acceptance and that the PR is draft. The PR link was supplied as a placeholder, so hosted PR state and checks were not independently verified.
- Owner authorization for the separate default-branch PR and cloud operations, plus confirmation of the proposed daily off window, are outstanding.
- GitHub protection settings, Azure tenant/access/offer/quota, hosting and egress eligibility, recurring costs and live acceptance remain unverified.
- Phase B must verify the Flex subnet NAT cost and reachability, the pair-only Azure Policy and power-role propagation, storage and receipt access, the armed controller and independent alert delivery. No Azure resource operations were performed.
- The installed CLI skipped string-valued artifact rules. Reviewed the proposal header/scope, behavioral delta, design references and contracts, documentation impact, and unchecked tasks with scenario coverage against those rules directly.

## Next action
- Next task — Task 1.2 is pending for a subsequent authorized session.
- Do not touch — Cloud resources, production, canonical specs or application contracts during Phase A.

## Notes for the reviewer
- Proposed pre-merge evidence covers tasks 1.1–1.7 and 2.1–2.4. The exact reviewed S3 rehearsal is ineligible for promotion.
- Tasks 3.1–3.4 require post-merge canonical S2 acceptance. Archive and M0-13 completion require every task and evidence. Failed S2 acceptance leaves the change open.
