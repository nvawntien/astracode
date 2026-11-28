# ADR-0012 — Judge Executor Trust Boundary

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-28 |
| Implementation | M0-13 `azure-walking-skeleton` |
| Requirements | NFR-S05, NFR-S08, NFR-S09 |
| Extends if accepted | ADR-0004, Networking and security and Validation and acceptance, as specified below |
| Review | Orchestrator and an independent infrastructure or security reviewer under [Team Workflow §10](../../process/workflow.md#10-adrs) |

## Context

ADR-0004 places Judge Worker and go-judge on a dedicated Judge VM and calls for validation of the executor privilege model on Azure/k3s. The privilege needed by the platform-managed daemon determines which parts of the system must be trusted to enforce the user-code sandbox. This boundary also determines the response to a suspected compromise.

On 2026-11-26 the Orchestrator authorized the executor trust boundary for M0-13 Phase A. The original record is preserved in repository history. This draft records that authorization and proposes the durable architecture decision for independent review. [Phase A approval record](https://github.com/nvawntien/astracode/blob/6ff0959c4b7f79493fdd1d5059b24d9ed0971b55/openspec/changes/azure-walking-skeleton/decision-judge-executor.md)

## Options

| Option | Trade-off |
| --- | --- |
| Trust one narrowly scoped privileged go-judge daemon on the dedicated Judge VM | Preserves the existing executor and App/Judge separation. A daemon compromise can affect the Judge host and propagate through shared cluster trust relationships. |
| Run the daemon without elevated privileges | Reduces the daemon's host authority if a compatible runtime can provide all required sandbox controls. That compatibility and enforcement have yet to be demonstrated. |
| Separate privileged execution from the k3s node trust boundary | Could reduce the shared-cluster impact by using a separately isolated execution host or virtualization boundary. This changes placement and adds provisioning, operating and validation cost. |

## Proposed decision

- Treat the dedicated Judge VM, its kernel and node runtime, and the platform-managed go-judge daemon as part of the sandbox's trusted computing base. The shared cluster control plane and trusted node relationships remain relevant to the impact of a Judge compromise.
- Limit privileged execution to the platform-approved go-judge workload on Judge. Bind approval to its identity, placement and reviewed artifact. Keep Judge Worker unprivileged and restrict routine executor access to its private path. Keep general management, unrelated credentials and cloud identities outside the workload's authority.
- Treat submitted and interactive code as untrusted. Preserve its independent execution limits, network denial and denial of access to host and cloud credentials. Admission, network policy and launch authorization constrain workloads under the trusted-host assumption. A suspected daemon or Judge compromise requires isolation and recovery from trusted infrastructure before execution resumes.

If accepted, this extends the fourth bullet of [ADR-0004, Networking and security](0004-azure-topology-and-subscription-layout.md#networking-and-security), which identifies the shared trust boundaries and calls for privilege validation. It also extends the executor privilege and isolation row of [ADR-0004, Validation and acceptance](0004-azure-topology-and-subscription-layout.md#validation-and-acceptance) with the acceptance conditions below. The two-node topology and [ADR-0003 cache ownership](0003-worker-testcase-cache-generations.md) remain in force.

## Consequences and validation

The platform owns approval of the privileged workload. Separating Judge from the App VM reduces routine co-location of execution and application data. A compromised privileged daemon may control the Judge VM and affect the shared cluster. Admission, network policy and launch supervision cannot independently contain that compromise.

Before S2 exposure, independently review the privileged exception and verify it on the actual S3 Azure/k3s pair. Verify the effective privilege and host-resource boundary, refusal of unauthorized elevated workloads, private Worker connectivity, credential and metadata denial, and CPU, memory, process, wall-time and output limits with network denial for both official submissions and Run Code. Verify that missing or stale approval closes execution on restart and leaves recovery under authorized control. Record the exact release, environment and result in the existing [M0-13 evidence register](../../evidence/m0-13-phase-a.md).
