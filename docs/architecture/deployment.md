# AstraCode staging delivery

## Azure topology

ADR-0004 defines separate App and Judge VMs for S2 Staging and temporary S3 Testing. Terraform state, release receipts and environment data have separate scopes. The S2/S3 candidate uses Korea Central and Ubuntu 24.04 x64. App runs the k3s control plane, ingress, application services and backing stores on `Standard_B4s_v2` with 4 vCPUs and 16 GiB RAM. Judge runs the k3s agent and judging workloads on `Standard_B2ls_v2` with 2 vCPUs and 4 GiB RAM. Each node has a 64 GiB Standard SSD LRS OS disk. App has a separate retained 64 GiB data disk. Korea Central is also the S4 storage candidate. [ADR-0004](adr/0004-azure-topology-and-subscription-layout.md) · [Preflight observations](../evidence/m0-13-phase-a.md#azure-preflight-observations)

Normal shutdown deallocates compute and retains managed infrastructure and App data. The candidate's reviewed replacement procedure preserves network identities and recreates one VM at a time. Workflow registration, Terraform operations and S3 drills have their own runbooks. [Terraform operations](../../infra/azure/README.md) · [S3 rollout and recovery](../../infra/azure/lifecycle/README.md#s3-pre-merge-rehearsal-and-cleanup)

## Release and operational lifecycle

Protected `develop` merges produce a canonical, write-once release receipt after exact-SHA CI. App pulls the approved immutable bundle through the protected deployment path. The separate `main` maintenance transition, legacy retirement and live workflow activation remain gated. S3 uses experiment-scoped artifacts with explicit cleanup deadlines. A production promotion may reference only the exact release accepted in S2. M0-13 exercises eligibility without deploying production. [Release publication and main transition](../../scripts/release/README.md)

Owner approval for startup is separate from maintainer approval for deployment. The offline candidate gives its independent controller routine S2 VM start and deallocation authority, and keeps workflow jobs outside direct power operations. This differs from ADR-0004's direct-start assignment and depends on Proposed ADR-0013. Deployment also depends on resolution of its identity prerequisites. [Proposed ADR-0013](adr/0013-staging-lifecycle-control-plane-and-identity.md)

Workload activation verifies the release, the three managed schema histories and previous Submission termination before opening App and Judge. Testing begins at verified readiness. Expiry or cancellation closes admission and triggers a bounded drain and VM deallocation. An uncertain operation keeps activation closed until verified recovery. Compatible rollback restores reviewed application artifacts while retaining schema versions. [Managed activation and rollback](../../infra/azure/lifecycle/README.md) · [Controller operations](../../infra/azure/lifecycle/controller/README.md)
