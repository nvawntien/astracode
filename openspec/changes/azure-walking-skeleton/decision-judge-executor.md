# M0-13 implementation decision — Judge executor trust boundary

Accepted by the Orchestrator on 2026-11-26 during Phase A. This decision applies to ED-02 and the ED-06 launch guard under [ADR-0004](../../../docs/architecture/adr/0004-azure-topology-and-subscription-layout.md).

The platform-managed go-judge daemon belongs to the dedicated Judge VM's trusted computing base. Compromise of that daemon can compromise Judge and affect the shared cluster. Admission constrains which template starts. NetworkPolicies constrain ordinary workload connectivity. The in-container supervisor enforces startup and recovery while the daemon and node are trusted. None provides independent containment of a compromised privileged daemon.

Only the approved go-judge digest in its fixed platform template, dedicated namespace and Judge placement may run privileged. Keep Worker unprivileged and permit only private Worker-to-executor calls. Exclude public and tester access, host namespaces, host credential mounts, block-device mounts and runtime socket mounts from the template. A host namespace requirement would need separate review. Keep the pinned k3s/containerd runtime and existing executor. Judge receives its agent-only join credential and scoped image pulls. Azure managed identities, Key Vault rights, the server token and administrator kubeconfig stay off Judge.

Ordinary App workloads and Judge Worker retain their individual credential boundaries. All submitted and interactive user code remains untrusted and subject to NFR-S05 CPU, memory, process, wall-time and output limits, network denial and denial of host and cloud credentials.

At every launch or restart, including daemon restart, validate a current permit before starting the child. Expiry or loss of authorization closes execution. After an interrupted operation or uncertain termination, withhold new permits until authorized recovery. Suspected Judge compromise requires trusted infrastructure recovery before reactivation.

Task 1.3 checks rendered declarations and admission refusals. Task 1.4 exercises stale grants, starts and stops. Task 2.3 must exercise actual limits and isolation for official and interactive execution, private connectivity and ordinary workload credential denial on the S3 Azure/k3s pair before S2 exposure.

The local k3s v1.35.10+k3s1 fixture exposed 14 block devices and a shared cgroup namespace with containerd defaults. The Judge bootstrap disables implicit host device injection on the bundled runc and adds a private cgroup namespace to its OCI base. The fixed Judge Pod requests a separate user namespace. A fresh fixture showed zero OCI block devices, distinct PID/network/IPC/mount/UTS/cgroup/user namespaces, delegated CPU/memory/pids controllers and an accepted bounded echo through loopback. The executor keeps its trusted status under this configuration. S3 must verify the effective runtime and both user-code paths.

The launch guard now also checks the observed PID namespace, so a restarted container cannot consume its prior process permit. The local template-created Judge Pod started the pinned executor under a current CRI-bound permit and passed namespace, device and cgroup observations. This evidence retains the trusted-host assumption and the required S3 verification.
