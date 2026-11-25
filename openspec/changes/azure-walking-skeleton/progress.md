# progress.md — azure-walking-skeleton

<!-- Template: docs/process/templates/progress.md. Overwrite this file at the end of every session; keep it under 40 lines. -->

## Verified state
- Branch / worktree — `feature/azure-walking-skeleton` in the current repository worktree.
- Baseline — `make test-quick` passed on Go 1.25.8 with writable temporary directories and loopback access. Go tests and vet, website typecheck, Compose configuration and strict OpenSpec validation passed. `openspec validate azure-walking-skeleton --strict` passed, and all 11 OpenSpec items passed.
- Last verify run — `make test` passed, including Go test/vet/race, 620 website tests, the website build and Compose configuration. `terraform fmt -check -recursive infra/azure`, backend-disabled read-only-lock init, `terraform validate` and `bash -n` on both new bootstrap scripts passed.
- Tasks done (with evidence) — 2 of 15. Task 1.1 passed `terraform test -var-file=offline.tfvars.example` in bootstrap (3 cases) and environment (7 cases). `bash infra/azure/environment/tests/check-retained-disk.sh` confirmed bound state retargeting and App disk replacement are rejected using mock state and passed again in this session.
- Task 1.2 — Environment mock plans passed 8/8, including rejection of VNet overlap. Both synthetic VM renders passed `cloud-init schema`, `systemd-analyze verify` and `nft --check` in a Docker container with networking disabled. Fixtures checked K3s ordering, role placement, absence of embedded join credentials and role-specific IMDS rules. `python3 -B infra/azure/cloud-init/tests/host_fixtures.py` passed 9/9, covering absent and wrong disks, mount identity, simulated reboot and reattachment, separate agent credentials and refusal of server or unpinned tokens.

## Last session
- Goal — Resume Phase A sequentially. Baseline `make test-quick`, OpenSpec strict, all 9 host fixtures and 8 environment Terraform mock tests passed again at `ed49311`.
- Task 1.3 (partial) — Added the App and Judge namespaces, ingress/egress default-deny policies, App-only retained Local Path storage class and four PVCs. Kustomize v5.7.1 (verified release checksum) passed `kustomize build infra/kubernetes/overlays/staging` and `kustomize build infra/kubernetes/overlays/testing` with distinct environment labels. All nine resources per overlay passed the upstream Kubernetes v1.35.10 OpenAPI schemas with unknown object properties rejected. Fixture assertions checked PVC names, placement, retention and both policies. This checkpoint contains no workload controllers or ingress.
- Executor check — Local sandbox image `sha256:8f33899eb5d162e0b17d37a6b1e1fd1c658b5fcf3077d945b883f5f3a4bb19b1`, with all capabilities dropped, networking disabled and no host mounts, exited 1. It reported read-only cgroup v2, fallback to `rlimit/rusage`, then prefork failure with `operation not permitted`. This checks one restrictive Docker profile. The fixture used the packaged executor entrypoint with an eight-second timeout, 1 CPU, 512 MiB memory, 64 PIDs and bounded executable tmpfs for /tmp and /w. Kubernetes execution and sandbox access to host credentials have not been tested.
- Authorization — The [Round 2 decision](review-gate1-round2.md) records the approved M0-13 sequencing exception and Phase A offline scope. The [Round 1 review](review-gate1.md) preserves the original verdict.

## Broken or unverified
- ED-02 applies credential isolation to a Judge workload as well as to submitted code. The existing Compose executor runs privileged. The pinned K3s runc template uses the containerd default for host devices. Digest and Pod admission checks can select the approved executor but cannot enforce a host-credential boundary against that privileged daemon. The launch-guard design also places its supervisor inside that container. Maintainers must resolve whether the daemon belongs to the Judge host trust boundary or requires an isolated runtime profile with verified cgroup delegation before the privileged allowlist is authored. [K3s runtime template](https://github.com/k3s-io/k3s/blob/v1.35.10%2Bk3s1/pkg/agent/templates/templates.go) · [containerd privileged device defaults](https://github.com/containerd/containerd/blob/release/2.2/docs/cri/config.md)
- The owner confirmed Gate 1 acceptance and that the PR is draft. The PR link was supplied as a placeholder, so hosted PR state and checks were not independently verified.
- Owner authorization for the separate default-branch PR and cloud operations, plus confirmation of the proposed daily off window, are outstanding.
- GitHub protection settings, Azure tenant/access/offer/quota, hosting and egress eligibility, recurring costs and live acceptance remain unverified.
- The S3 rehearsal must exercise actual VM boot and reboot, disk reattachment, K3s placement, protected Judge join and token rotation, and packet-level metadata and management denials.
- Phase B must verify the Flex subnet NAT cost and reachability, the pair-only Azure Policy and power-role propagation, storage and receipt access, the armed controller and independent alert delivery. No Azure resource operations were performed.
- The installed CLI skipped string-valued artifact rules. Reviewed the proposal header/scope, behavioral delta, design references and contracts, documentation impact, and unchecked tasks with scenario coverage against those rules directly.

## Next action
- Next task — Resolve the executor trust boundary, then finish task 1.3 workload templates, policies and negative checks before starting 1.4.
- Do not touch — Cloud resources, production, canonical specs or application contracts during Phase A.

## Notes for the reviewer
- Proposed pre-merge evidence covers tasks 1.1–1.7 and 2.1–2.4. The exact reviewed S3 rehearsal is ineligible for promotion.
- Tasks 3.1–3.4 require post-merge canonical S2 acceptance. Archive and M0-13 completion require every task and evidence. Failed S2 acceptance leaves the change open.
