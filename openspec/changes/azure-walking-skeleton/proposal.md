Addresses: NFR-D01, NFR-D02, NFR-D04, NFR-D06 | Follows: ADR-0004, ADR-0006, ADR-0011

## Why

M0-13 needs a reproducible staging environment that runs the existing AstraCode stack and can demonstrate that an approved, immutable release works end to end. The current Compose and SSH workflows provide a runtime reference. The Azure topology and its delivery and staging controls need implementation and evidence.

## What Changes

- Provision isolated two-VM environments from one Terraform definition, with a separately managed App data disk, shared state in S4, scoped identities and budget alerts. Use k3s and Kustomize to deploy the existing application and its dependencies. Keep Compose for local development.
- Publish one immutable release per passing `develop` merge. Register the staging request workflow on protected `main` through a separate owner-authorized maintenance PR and retire the legacy tag-based delivery entry points. After separate startup and deployment approvals, deploy the exact published release to S2, run the reviewed migrations, verify readiness and smoke-test the stack. Define how a protected semantic tag will reference the staged release for future production promotion.
- Provide owner-approved, one-hour staging sessions measured from readiness. Enforce the daily off-time floor, make expiry independent of any individual workflow and verify that both VMs deallocate while retaining persistent data. After an interrupted rollout or migration, gate application and judging processes on verified recovery before reopening staging.
- Split implementation into **Phase A**, which produces and verifies the infrastructure and delivery assets offline, and **Phase B**, which requires explicit project-owner authorization and real Azure preflight, S3 experiments, S2 deployment and acceptance evidence. The Orchestrator established five logical subscription contexts and reported their Enabled states. Credit, expiry and remaining authorization and service feasibility are tracked in the preflight evidence. [Preflight](../../../docs/evidence/m0-13-phase-a.md#azure-preflight-observations)
- **Orchestrator decision required before Apply.** Propose Gate 2 review with Phase A complete and authorized S3 evidence from the exact reviewed candidate SHA and isolated rehearsal artifacts. Post-merge S2 tasks stay open until the protected `develop` release passes approved deployment and acceptance. S3 rehearsal evidence is ineligible for production promotion. Failed S2 acceptance keeps the change open for a reviewed fix. Archive and M0-13 completion require both stages and all evidence. [Task boundaries](tasks.md)

## Capabilities

### New Capabilities

- `environment-delivery` — Recreate the staging environment, publish and verify immutable releases, enforce deployment and session approvals, and retain runtime and shutdown evidence.

### Modified Capabilities

## Impact

- Infrastructure, bootstrap, workload configuration, release publication, staging workflows and operator runbooks. Existing API, Kafka and database ownership contracts remain in force. The managed deployment gate uses the existing `database-schema-migrations` requirements.
- Scope excludes S1 activation or deployment, full observability (M0-14), the architecture document set (M0-15), Judge Worker scaling (M2-06), contest capacity tests (M2-07), full backup and disaster recovery (M2-08), continuous production operations (M3), new application features and unrelated refactors.
- M0-13 is a Gate 1 enabler dependent on M0-09. Supporting acceptance criteria cover compatible rollback (NFR-D03), reviewed migrations (NFR-D05), existing CI coverage (NFR-D07), scenario evidence (NFR-D09), sandboxing, secrets and private services (NFR-S05/S08/S09), and credits, budgets and staging off-time (NFR-F01–F03).
