# progress.md — azure-walking-skeleton

<!-- Template: docs/process/templates/progress.md. Overwrite this file at the end of every session; keep it under 40 lines. -->

## Verified state

- Branch — `feature/azure-walking-skeleton`. Reviewed base for remediation was `c89c132`, the head of draft PR #73. CI and OpenSpec succeeded on that hosted head. Its rehearsal-head check was skipped.
- Repository checks — `make test-quick` and `make test` passed on Go 1.25.8 with writable temporary directories and loopback. Full verification covered test/vet/race, benchmark checks, 620 website tests, website build, Compose config and 11 strict OpenSpec items. `make test-db` passed all targeted PostgreSQL suites.
- Task 1.1 — `terraform fmt -check -recursive infra/azure`, both backend-disabled initializations and validations, and bootstrap/environment mocks passed (3 and 8). The retained-disk and compute regression checked existing-state reconciliation, expired approval, protected state/disk and VM/attachment removal. Reviewed-plan tests passed 7/7.
- Task 1.6 — Controller tests passed 14/14, including two-release rollback, source/digest allowlist, recovery after hard stop, stale boot and Job rejection, expired or unauthorized restart, sealed partial histories and S2 plan approval. Activation, record, host, migration, rollout and loopback smoke fixtures passed 17/17. The managed PostgreSQL fixture passed writer fencing, partial histories and compatible rollback.
- Task 1.7 — Both Kustomize overlays passed strict Kubernetes/Traefik schemas with 118 resources and 13 image pins each. Native admission and RBAC passed on a disposable API server. Release policy and packaging passed 8/8 and cloud-init host fixtures passed 9/9. Actionlint, ShellCheck, Bash syntax, Python checks, strict OpenSpec and Git whitespace checks passed.
- Progress — 7 of 15 tasks. PA-01, PA-02 and PA-03 have offline regression evidence; S3 exercises retain their live acceptance requirements. [Evidence](../../../docs/evidence/m0-13-phase-a.md)

## Last session

- Corrected the S3 experiment release set and hard-stop recovery, added reviewed-plan protection for VM creation and replacement, selected the Korea Central sizes, and documented first-time S4 bootstrap and state migration.
- Consolidated preflight facts and estimates into the existing evidence file, executable procedures into infrastructure READMEs, durable topology and trust boundaries into deployment and security, and the pending identity decision into this change's design.

## Broken or unverified

- Task 2.1 remains open for tenant A administrator support, protected immutable OIDC and receipt reachability, verified balances and expiry, effective provisioning and data access, and outstanding Flex Consumption and approval feasibility. [Pending decision](design.md#pending-entra-and-github-federation-decision)
- Azure allocation, deployment, actual two-release rollback, hard-stop recovery, budget notifications and cleanup remain pending. The privileged local K3s hard-stop VM was not rerun in this session. Hosted CI and independent review must assess the remediation revision.

## Next action

- Review the offline remediation and the tenant A proposal. Run the authorized read-only scope checks and record evidence before considering S4 bootstrap. [Operator commands](../../../infra/azure/README.md#task-21-review-boundary)
- Retain the pre-provisioning boundary and the accepted two-stage Gate 2 sequencing. Main workflow registration, publication and delivery activation, S2 acceptance and archive remain separate gates.
