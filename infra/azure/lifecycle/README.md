# App activation, rollback and shutdown

On boot, the platform leaves application, judging, migration and tester access closed. App verifies the retained disk before starting k3s. The rollout runs as `astra-poller` with named workload roles. The `astra-activation` service uses its permit key, restricted kubeconfig and database fence login. It reads the canonical S4 receipt with the scoped App identity. The separate secret loader retrieves its exact Key Vault secrets. Ordinary Pods cannot use host IMDS. No Judge workload or host has an Azure identity. Host Unix sockets check the peer UID.

Load reviewed packages and configuration during infrastructure bootstrap. Use protected operator access for platform installation and owner window commands. App root and the protected delivery workflow's App-only Action Run Command authority are part of the trust boundary. Deploy code uses an explicit Action Run Command invocation of the installed `host_services.py delivery submit`, with only the frozen input. Tester admission requires the same approved run's explicit handoff after observed rollout and smoke. Missing or expired handoff closes access and expires workload permits. The workflow holds no Kubernetes or SSH credential. [Release approval and dispatch](../../../scripts/release/README.md) · [Azure scope](../README.md#provisioning-privileges)

## Host configuration and authority

- Install the checked `launch-guard`, the App host package from `package-app.sh` and the protected probe with `install-platform.sh`. On Judge install the guard and observer, and deliver the scoped observer credential, agent-only token and permit public key. Apply the reviewed Kustomize overlay and role bindings from App over the local Kubernetes API. Verify the approved executor digest and pod admission before enabling the issuer.
- In protected `/etc/astracode/poller.json`, configure `kafka_ip`, `problem_ip`, `problem_probe` with the reviewed synthetic problem ID, CPU-time and memory settings, HTTPS `origin`, `smoke_tls` and `smoke_fixture`. Provision the distinct application smoke mTLS certificate and bootstrap fixture through the existing credential path. In `activation.json` configure `executor_digest`, `migration` with the verified PostgreSQL `system_id` and reviewed `recovery_point`, and `contest_windows` with explicit UTC start/end entries. Apply config and issuer key permissions to the dedicated service users. Config files and protected fixture material stay outside the package.
- S2 config contains `receipt_account` and `receipt_client_id` for the scoped S4 receipt reader. S3 config contains `rehearsal_sources`, a digest-to-source map approved for the experiment. Place the exact verified receipts in `/etc/astracode/rehearsal/<digest-hex>.json`. Keep them root-owned. The issuer independently checks origin, full source, digest, payload, configuration, executor pin and migration inventory.
- The operator installs root-owned `daily-window.json` with `earliest_start` and `shutdown` as UTC HHMM values matching the approved native schedule. Configure `secret-loader.json` with `loader_client_id` and `vault_host`. The approved window approval command records the date and reference after both actual VM states, mount and k3s readiness are verified. Start with a single explicit `initialize` on the freshly verified retained mount before live activation. Recovery or replacement reuses its journal.

## Managed rollout and recovery

The host journal on the App data disk binds each run to one operation before mutation. The deployment closes ingress, verifies prior Submission termination, and serializes migrations using per-owner locks and short-lived per-attempt credentials. Old Pod/Job objects cannot authorize work. Each process permit binds the owner window generation, operation, both node epochs, Pod and PID namespace, release and configuration digests and expiry. Losing a validated node observation or reaching cutoff closes access and execution. The operator verifies deallocation through Azure separately. [Accepted ADR-0012](../../../docs/architecture/adr/0012-judge-executor-trust-boundary.md)

For an interrupted mutation, preserve the recorded operation. Confirm the previous writer cannot still run, confirm App/App-disk identity and a fresh App boot, then reconcile physical Job and application processes, queued durable work and the three Goose histories. Approve `recover` for the exact retained release and operation using those observed versions. A partial schema stays fenced for a distinct approved deploy of the same candidate. A compatible rollback names a previously verified release with matching owning versions. It verifies histories and never applies a down migration.

Run the offline unit and rollout fixture suite from the repository root.

```sh
PYTHONPATH=infra/azure/lifecycle:infra/postgres/managed:scripts/release \
  python3 -B -m unittest discover -s infra/azure/lifecycle -p 'test_*.py'
```

## S3 pre-merge rehearsal and cleanup

Follow the [S3 provision and delivery procedure](../README.md#s3-provision-and-deploy) with the exact reviewed candidate. Start the two-hour clock from the first environment provisioning action. Record S4 and workflow registration prerequisites separately.

1. Install two distinct source-verified rehearsal receipts. In the protected workflow, deploy A with a compatible artifact, deploy B with A as verified fallback, and roll back to A with B as compatible fallback. Compare actual OCI digests, exact configuration, all three histories, readiness and smoke. Record rollback time and verify failure closes access.
2. Under separate S3 authorization interrupt one rollout or migration. Verify scheduled or emergency deallocation and retained inventory. Restart manually under a fresh owner-approved window, verify the two new node boot identities and same App mount, and confirm stale Jobs, app processes, outbox, result consumption and judging remain fenced before separate recovery approval.
3. Verify live mount failure/reattachment, private endpoints and mandated isolation under ADR-0012, including CPU, memory, process, wall/output limits and denial of networking, metadata and credentials to submitted code. Exercise attempted authority outside the App deployment profile. Confirm both VM states after expiry or an early stop. Use the standalone deallocate-only operator path for a missed or partial stop. Preserve the disk and state as authorized and review any S3 resource deletion separately.
