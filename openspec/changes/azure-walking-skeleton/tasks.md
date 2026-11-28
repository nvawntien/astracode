The [recorded Phase A authorization](https://github.com/nvawntien/astracode/commit/aa4b7b9b09da9383085e0b9d774a2c647dd98e55) records the M0-13-specific two-stage Gate 2 sequence. Tasks 1.1–1.7 and 2.1–2.4 require evidence before Gate 2. Tasks 3.1–3.4 stay unchecked until post-merge acceptance. Archive and M0-13 completion require all tasks and successful real S2 evidence.

## 1. Phase A — Pre-merge offline implementation and validation

- [x] 1.1 Keep the S4 backend and scoped state, receipts and backups. Remove controller-only Azure resources. Configure per-VM scheduled shutdown, standalone emergency deallocation and budget alerts. Verify Terraform plan/schema and role separation (ED-01, ED-05, ED-08, ED-10).
- [x] 1.2 Keep the cloud-init and k3s bootstrap, retained disk/verified mount, node isolation and explicit network. Verify approved initial creation without prior off-time accounting and authorized recovery of one absent VM with the same NIC, IP and App disk within quota (ED-01, ED-02, ED-08).
- [x] 1.3 Define the Kustomize base and S3/S2 overlays for Next.js, Envoy, Auth, Problem, Submission, PostgreSQL, Redis, Kafka, MinIO, Worker, go-judge and the testcase cache. Include resource bounds, retained PVs, probes, trusted launch templates and admission allowlists. Verify `kustomize build`, strict schemas including Traefik, identical digests with distinct overlays, and local negative checks for unexpected privileges, wrong secret mounts, host paths/networking, service accounts, image digests, placement and policy writes (ED-01–ED-03, ED-06).
  - Live sandbox acceptance under ADR-0012 remains Task 2.3.
- [x] 1.4 Replace the external grant dependency with boot-bound, expiring App-local activation while preserving fresh migration-Job authorization, verified histories and prior Submission termination, durable interrupted-operation recovery, compatible rollback and fail-closed workload execution. Reuse the guarded rollout, migration and smoke checks (ED-02, ED-06, ED-07).
- [x] 1.5 Keep exact-SHA CI, canonical publication and isolated rehearsal verification. Implement protected native delivery approval and automatic migration, rollout, readiness and smoke. Preserve read-only exact-release promotion eligibility and verify no direct Azure power, unrelated guest execution or state access (ED-03, ED-04, ED-06, ED-07, ED-09).
- [x] 1.6 Remove obsolete lifecycle API, auth clients, timer, session state and exclusive tests. Verify owner-approved windows, expiry, recovery and independent native shutdown assumptions. Document operator startup, emergency deallocation and observed power states (ED-04, ED-05, ED-08).
- [x] 1.7 Run the applicable offline Terraform, rendered bootstrap, Kubernetes, release, recovery, migration, repository and strict OpenSpec checks. Document S4/S3 procedures and retain actual evidence only (ED-01–ED-10).

## 2. Phase B — Pre-merge Azure preflight and S3 rehearsal

Phase B requires separate authorization. S3 uses exact reviewed, isolated rehearsal artifacts.

- [ ] 2.1 Complete ADR and NFR review and verify S1–S5 mapping, subscription permissions, credit and expiry, native shutdown, approved region/quotas, private paths, federated workflow access, budget alerts and indicative costs. Require current owner authorization before provisioning and separate protected workflow registration for automated S3 delivery (ED-01, ED-04, ED-05, ED-08, ED-10).
- [ ] 2.2 Bootstrap S4 and migrate its bootstrap state to Azure Blob. Verify separate scopes and negative access, state locking, immutable first-write receipts and backup paths (ED-01, ED-03).
- [ ] 2.3 Time recreation from an empty S3 through verified application readiness. Test two independently reviewed release digests, automated delivery, compatible rollback, actual sandbox and IMDS denial under ADR-0012, no elevated or stale activation, and recovery after interrupted migration, lost authorization and replacement with retained data (ED-01, ED-02, ED-04, ED-06–ED-08).
- [ ] 2.4 Record recreation, resource sizing, cost/credits, alert delivery and actual S3 deallocation. Exercise interrupted and early shutdown, scoped emergency access, independent cleanup, and no unintended infrastructure deletion (ED-01, ED-05, ED-08, ED-10).

## 3. Phase B — Post-merge canonical S2 acceptance

- [ ] 3.1 Land the separately approved minimal main maintenance PR for workflow registration and legacy-path retirement. Verify protected approvals, federated scopes and S3 sizing conclusions; confirm the owner's window, native schedules, budget and power authority before S2 use (ED-01–ED-05, ED-08, ED-10).
- [ ] 3.2 Use the protected develop release. Verify actual power, mount and k3s readiness after manual approved startup, exact automated deployment and smoke (sign-in, catalogue, Submission, Rejudge, SSE and Run Code) plus exact release promotion eligibility without production deployment (ED-02–ED-06, ED-09).
- [ ] 3.3 Verify rollback within 15 minutes, scheduled and early deallocation, stale work recovery, actual daily off-time and verified persistence on restart. Exercise workflow interruption and emergency deallocate-only (ED-05–ED-08).
- [ ] 3.4 Record scenario results, S2 acceptance, sizing, approved cutoff, observed cost and budget alert evidence. Close only with successful canonical S2 and all required evidence (ED-01–ED-10).
