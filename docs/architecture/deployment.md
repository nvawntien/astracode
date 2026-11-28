# AstraCode staging delivery

## Azure topology

ADR-0004 defines separate App and Judge VMs for S2 Staging and temporary S3 Testing. Terraform state, release receipts and environment data have separate scopes. The S2/S3 candidate uses Korea Central and Ubuntu 24.04 x64. App runs the k3s control plane, ingress, application services and backing stores on `Standard_B4s_v2` with 4 vCPUs and 16 GiB RAM. Judge runs the k3s agent and judging workloads on `Standard_B2ls_v2` with 2 vCPUs and 4 GiB RAM. Each node has a 64 GiB Standard SSD LRS OS disk. App has a separate retained 64 GiB data disk. Korea Central is also the S4 storage candidate. [ADR-0004](adr/0004-azure-topology-and-subscription-layout.md) · [Preflight observations](../evidence/m0-13-phase-a.md#azure-preflight-observations)

Normal shutdown deallocates compute and retains managed infrastructure and App data. The candidate's reviewed replacement procedure preserves network identities and recreates one VM at a time. Workflow registration, Terraform operations and S3 drills have their own runbooks. [Terraform operations](../../infra/azure/README.md) · [S3 rollout and recovery](../../infra/azure/lifecycle/README.md#s3-pre-merge-rehearsal-and-cleanup)

## Release and operational lifecycle

Protected `develop` merges produce a canonical, write-once release receipt after exact-SHA CI. App pulls the approved immutable bundle through the protected deployment path. The separate `main` maintenance transition, legacy retirement and live workflow activation remain gated. S3 uses experiment-scoped artifacts with explicit cleanup deadlines. A production promotion may reference only the exact release accepted in S2. M0-13 exercises eligibility without deploying production. [Release publication and main transition](../../scripts/release/README.md)

The Orchestrator approved the simplified M0-13 direction for offline implementation. Pending independent review of ADR-0013, an infrastructure operator starts the pair manually in an owner-approved window. Azure-native daily auto-shutdown handles deallocation independently of GitHub. The operator checks actual power states and uses the emergency role if needed. Separate native GitHub Environment approval authorizes automatic deployment of the exact release. [Proposed ADR-0013](adr/0013-staging-lifecycle-control-plane-and-identity.md) · [Operator procedure](../../infra/azure/README.md#s2s3-vm-maintenance)

The App host records the approved deployment on its verified retained disk and uses both node observations, all three database histories and prior Submission termination to authorize workloads. Stale, expired and interrupted work remains fenced on restart. The cutoff closes tester and workload admission before scheduled deallocation. Compatible rollback retains schema versions. [Managed activation and rollback](../../infra/azure/lifecycle/README.md)
