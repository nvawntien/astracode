---
change: azure-walking-skeleton
gate: 1
round: 1
reviewed_commit: 3387d30f2700c58a8389bdeaa3510dff114e5a98
base_commit: 1804dc27eeaf30286da1a1d301023c876d4e7b16
risk: high
verify: not_run_independently
status: changes_requested
---

# Gate 1 — M0-13 Azure walking skeleton

## 1. Review scope and verdict

**CHANGES REQUESTED — revise the proposal artifacts before OpenSpec apply.**

- Repository: `nvawntien/astracode`, branch [`feature/azure-walking-skeleton`](https://github.com/nvawntien/astracode/tree/feature/azure-walking-skeleton).
- Reviewed head: [`3387d30`](https://github.com/nvawntien/astracode/commit/3387d30f2700c58a8389bdeaa3510dff114e5a98). Base: `develop` at [`1804dc2`](https://github.com/nvawntien/astracode/commit/1804dc27eeaf30286da1a1d301023c876d4e7b16). The branch is one commit ahead and zero behind at review time.
- Scope: six new files under `openspec/changes/azure-walking-skeleton/`: `.openspec.yaml`, proposal, design, delta spec, tasks and progress. No implementation files changed.
- Reviewed against Accepted ADR-0004, the retained managed provisions of ADR-0006, ADR-0011, the newly archived `database-schema-migrations` canonical spec, NFR-D01–D07/D09, relevant security/cost/contest/reliability NFRs, the delivery plan and team workflow. Reviewed the current release and production workflow entry points and the exact-version schema startup check.
- PR #72's M1-02 archive is already in the base. No migration archive blocker remains. The proposal correctly references the canonical migration requirements instead of redefining them.
- This is an independent design review, not a submitted GitHub approval or an implementation test. No open PR for this head and no hosted check runs were returned at review time. `progress.md` reports strict validation, 4/4 planning artifacts and clean diff checks; those commands were not independently rerun here. Azure accounts, permissions, quotas, prices, hosting eligibility and deployment behavior remain unverified.

The direction is sound. Keep the two-node Terraform/k3s design, existing stack, S1–S5 roles and the offline-first approach. The requested changes are limited to making the plan executable and its failure boundaries unambiguous. Do not add a second architecture, a new ADR, or implementation code in this review round.

## 2. Gate 1 findings

Severity: P1 = must resolve before Apply; P2 = material design/acceptance clarification required before Apply. These are design findings, not defects observed in running infrastructure.

### G1-01 — P1: Resolve the pre-merge / post-merge acceptance dependency and rehearsal artifact path

**References:** `design.md:109–118`, `tasks.md:11–22`, `proposal.md:12`, ED-03/ED-10; `docs/process/workflow.md` sections 4 and 7; ADR-0004 delivery and validation sections.

The design explicitly recognizes the circular gate: the normal workflow requires checked implementation tasks before Gate 2, but tasks 2.6–2.8 require the canonical release published after merging this implementation into `develop`. Task 2.3 also expects a working S3 deployment before merge, while the proposed canonical publisher only publishes passing `develop` revisions. The plan does not yet specify how to build/select the exact candidate artifacts for that S3 rehearsal without bypassing the trusted publication path. The review cannot silently waive the project workflow.

**Required revision**

1. Make a two-stage completion proposal explicit across proposal, design, tasks and progress: pre-merge Gate 2 requires implemented Phase A, offline checks and authorized S3 rehearsal evidence; the narrowly identified S2 canonical acceptance tasks remain unchecked until the protected `develop` release is published and deployed. Archive and M0-13 completion require all tasks and real evidence. Identify exactly which tasks are pre-merge versus post-merge (split the mixed evidence task if needed while keeping the 5–15 task limit).
2. Define a reproducible, owner-authorized S3 rehearsal artifact path: use the exact reviewed candidate SHA and digests, isolated test artifact identity/namespace or an equivalently protected operator path, and clearly non-promotable rehearsal evidence. Untrusted PR jobs must not gain registry-publishing or Azure permissions; S3 evidence must never satisfy production promotion eligibility or replace post-merge S2 evidence.
3. Explain how to handle failure of post-merge acceptance: keep the change open, prevent unsafe deployment/promotion, and fix via reviewed changes. Never mark the cloud tasks done based on offline checks, a pre-merge rehearsal, or an assumed future subscription.
4. Record the sequencing exception as an explicit **Orchestrator decision required**. The recommended sequence is not an approval on the owner's behalf. Do not edit `docs/process/workflow.md` or `delivery-plan.md` in this Gate 1 fix.

**Closure evidence:** A reviewer can trace an exact candidate from local/S3 verification through Gate 2, protected `develop` publication, approved S2 acceptance and archive, without a circular prerequisite or fabricated task evidence. The owner explicitly approves the sequencing exception before Apply.

### G1-02 — P1: Make protected workflow registration and the legacy-to-digest transition executable

**References:** `design.md:50–68, 117–118`, `tasks.md:7, 20`, ED-03/04/09. Current `.github/workflows/release-images.yml:3–18, 33–47` and `.github/workflows/deploy-production.yml:3–45`.

The repository default branch is `main`, while the change is developed and initially merged into `develop`. GitHub only delivers `workflow_dispatch` to a workflow that exists on the default branch ([official trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#defining-inputs-for-manually-triggered-workflows)). Adding new staging workflows to `develop` alone therefore does not establish a usable protected request path. The current release workflow also builds on semantic tags and accepts manually supplied full SHAs, and the existing Compose deployment consumes semantic image tags. Design line 68 defers protection/retirement of that consumer. Leaving these paths ambiguous can bypass the intended staged-digest gate or make S2 impossible to operate before the milestone release to `main`.

**Required revision**

- State the actual trigger, trusted workflow ref, approval environment and registration/activation prerequisite for startup, extension, deployment and rollback. Provide a minimal owner-reviewed default-branch registration/transition plan if using new dispatch workflows, or a genuinely supported protected alternative. Do not require an early production release, tag, broad merge of unreviewed `develop` into `main`, or privileged execution from a feature/PR ref. Any required `main` maintenance PR is separate and subject to owner authorization.
- Specify the transition boundary for the existing tag-build, arbitrary-SHA/manual publish, and Compose production-deploy entry points. They must not produce an eligible release or deploy production by bypassing the immutable release and successful S2 evidence gate. Preserve the legacy scripts as a reference if useful; keep real production credentials and deployment disabled. Define which triggers change, which remain safe, and how the transition is verified on the refs where they can actually execute.
- Define one protected mapping from semantic tag to the exact staged release bundle digest, with validation of the source/config/migration metadata and evidence. Do not treat the tag's Git commit or an image tag string as a substitute for a staged bundle. Explain how failed, skipped or interrupted publication of passing `develop` commits is reconciled without accepting untrusted SHAs or overwriting a published release identity.
- Bind the operation approval to the immutable requested payload and a trusted protected workflow run/attempt. An arbitrary caller-supplied `approvalRef`, environment name or OIDC token alone is not proof that a different operation was approved. Specify trusted refs and protected environment configuration, role separation, replay protection and the owner-request/independent-dispatch case. The repository is public, so native Environment Required Reviewers are the first choice; keep a custom fallback conditional on verified unavailability, not a second mandatory implementation. See [GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

**Closure evidence:** Design and tasks cover an available dispatch path before S2 acceptance, a protected exact-SHA publisher, non-deploying future promotion eligibility, and negative checks for wrong ref, unapproved SHA, changed request, replay, unstaged digest and legacy entry-point bypass. Production activation remains out of scope.

### G1-03 — P1: Make application and judging activation fail closed across a hard stop or reboot

**References:** `design.md:35, 74–85`, `tasks.md:4, 6, 8, 17, 21`, ED-01/04/06/08; canonical `database-schema-migrations` requirements; ADR-0004 staging lifecycle and migration gate.

The normal restart path verifies the previous release and drain record, and tester ingress closes on a stale lease. However, a hard cleanup deadline can deallocate a VM during an unfinished deployment/migration, leaving Kubernetes desired state, Jobs or running-workload definitions on disk. k3s can reconcile that persisted state when nodes return, before the controller has verified the previous release, the three database histories or the abandoned operation. Closing HTTPS admission alone does not stop an outbox relay, Kafka consumer, Worker, migration Job or other background writer. The exact-version startup check (`pkg/schema/startup.go:15–26`) only checks the owning database; it is not a three-database release approval gate.

**Required revision**

- Specify the durable last-authorized activation record and a fail-closed boot/recovery sequence. An unresolved or stale operation must not automatically activate a candidate or restart background writers just because k3s/VMs start, a Job object exists, or an individual database is compatible. Backing stores and the minimum recovery/management components may start so reconciliation can occur.
- Explain the simplest enforcement mechanism that also works when normal shutdown never completed. A clean scale-to-zero/drain record may support a normal restart but cannot be the only protection. The gate must control actual application/Worker/migrator activation, not merely external ingress. Keep the single-active Submission and per-database migration-writer fencing invariants.
- Extend ED-06 or ED-08 with a behavioral scenario for interruption after a partial migration or candidate rollout followed by VM/cluster restart. Add verification to the existing task(s): simulate abrupt shutdown, persisted stale desired state/Job, and loss of the controller/App operation lease; verify no unauthorized DDL, candidate activation, outbox or judge work begins until recovery is authorized and verified. Exercise the critical restart path in S3 before opening S2.

**Closure evidence:** The revised design distinguishes dependency readiness, verified release activation and tester admission, and has a concrete test for abnormal restart. No new application feature, automatic destructive downgrade or alternate judge is required.

### G1-04 — P1: Define the actual privilege boundary of the App pull agent and Azure identities

**References:** `design.md:37–38, 48, 54–58, 66, 72–73`, `tasks.md:5, 8, 17, 19–20`, ED-02/04. ADR-0004 runtime secrets, node isolation and private deployment path; NFR-S05/S08/S09.

The proposed controller + App pull agent is a reasonable way to avoid public SSH/API and a broad routine Run Command permission. But the controller, App poller, secret loader, Terraform operator, bootstrap transport and deployment workflow have very different authorities. The design describes separate managed identities and narrow roles without specifying how the App host prevents ordinary Pods from requesting those host identities or how release-bundle admission enforces the promised privileged-workload boundary. Microsoft documents that code on a VM can request tokens for identities attached to that VM ([managed identity security boundary](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-to-use-vm-token)). Multiple identities attached to App do not by themselves isolate local processes. A release that can alter Pod privileges, service accounts, mount/secret references or network policy may also escape the intended fixed rollout role.

**Required revision**

- Add a small actor/identity-to-authority table: infrastructure/bootstrap, lifecycle request, deploy request, controller, App poller, secret loader, migrator, runtime workloads, tester/smoke identities and Judge. Identify who may mutate VM power, submit/read tickets, fetch bundles, access secrets/state, change cluster objects and issue/revoke credentials. Keep routine delivery unable to invoke arbitrary guest commands, manage identities, apply Terraform, read S4 state or control VM power. Treat App host/root as a trusted boundary; do not promise isolation between host-root processes simply from separate MI client IDs.
- State how normal App Pods and Judge workloads are prevented from using host IMDS, host credentials and unrelated workload secrets, and how the explicitly privileged executor exception remains constrained. Keep Judge without an attached Azure managed identity or Key Vault access, and retain the accepted agent-only join credential rule.
- Make the trusted platform/release boundary concrete: fixed trusted deployment procedure plus a narrow resource/field/secret/privilege allowlist or equivalent enforceable admission controls, including host mounts, host networking, service accounts, privileged workload identity, image digest, namespace, node placement and platform-owned RBAC/policies. Do not rely on a bundle describing its own restrictions. Avoid introducing a new policy stack unless a demonstrated requirement makes it necessary.
- Add negative verification for App workload access to IMDS or the loader's/poller's authority, wrong controller action/identity, attempted release privilege escalation, wrong secret mount and forbidden management reachability, as well as the existing Judge sandbox checks. Test control logic offline and actual boundaries on S3 before S2 exposure.

**Closure evidence:** Design identifies enforceable trust boundaries and the corresponding scenarios/tasks. The chosen low-cost implementation does not assume that Azure role separation alone protects identities on a shared VM.

### G1-05 — P2: Bound the lifecycle controller's failure and cost model without overbuilding it

**References:** `design.md:29–31, 72–78, 105–107, 120`, `tasks.md:3, 8, 15, 17–19, 21–22`, ED-05/08/10; NFR-F01–F03.

The external durable timer is appropriate to survive a failed GitHub run. But the plan also says it alerts on missed controller heartbeats: a controller that is not running cannot reliably report its own absence. Timer triggers are not an exact wall-clock guarantee; retry behavior is runtime-dependent and recovery after missed invocations must come from persisted state ([Azure Functions timer documentation](https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer)). S2 has a controller armed before VM creation, while the temporary S3 pair does not have an equally explicit bounded cleanup path if a test or apply is interrupted. The cost of the candidate Flex Consumption app, its storage/networking and alerts is unknown.

**Required revision**

- Define bounded reconciliation/cleanup deadlines and an independent missed-heartbeat signal or monitored health check, plus an owner-authorized emergency **deallocate-only** recovery path. Do not make a redundant controller/HA service mandatory. Document that controller/platform outages can delay confirmed deallocation; never report success from the workflow result alone. Fail closed for new sessions/access during uncertainty, recover from persisted state and verify both actual power states.
- Before starting temporary S3 compute, require an approved experiment deadline and a cleanup/leftover check that survives an interrupted provisioning/test session. Reuse the simplest verified control or a separately protected cleanup mechanism; do not build another full platform for S3.
- Keep Flex Consumption, public IPv4 egress and the candidate daily off window explicitly provisional. Phase B must verify actual offer/region eligibility, private storage and timer/auth support, estimated recurring cost of the controller and monitoring, and budget-alert support before committing S2 spend. If the candidate cannot meet the ADR requirements within budget, stop for owner review instead of silently weakening shutdown or approval policy. Prefer native GitHub approvals and one small controller; do not implement speculative fallbacks now.

**Closure evidence:** Updated design and scenario-to-task mapping cover controller interruption/restart, missing heartbeat, delayed/partial Azure operations, S3 cleanup and measured standing costs. Any unsupported Azure capability remains a clearly labeled Phase B blocker, not an assumed success.

## 3. Gate 1 checklist

| Check | Result |
| --- | --- |
| Proposal traceability to M0-13, NFR and Accepted ADRs | Pass |
| Scope limited to planning; no canonical spec or implementation change | Pass |
| M1-02 migration dependency archived; no duplicated existing requirement | Pass |
| One new capability (`environment-delivery`); 10 requirements, 22 scenarios in current revision | Pass structurally; revise failure scenarios as requested |
| Behavioral specs vs implementation details | Mostly pass; keep mechanisms in design, observable outcomes in specs |
| Task count | 15, within the numeric limit; substantial work, must be staged by dependency and verified rather than called a one-session task |
| Evidence and workflow sequencing | Needs revision / owner decision (G1-01) |
| Protected release and operation entry points | Needs revision (G1-02) |
| Restart and privilege failure boundaries | Needs revision (G1-03/04) |
| Lifecycle and cloud prerequisites | Needs revision (G1-05); actual cloud evidence deferred |
| Strict OpenSpec validation | Author-reported pass, not independently executed |
| Hosted CI | No check runs returned for reviewed head; not verified |

## 4. Keep the existing good decisions

- Use the S4 Blob backend, reusable two-VM definition and separate environment state. Keep S1/S5 compute inactive in M0-13. Do not require subscription activation in Phase A. Azure preflight, S3 measured footprint and actual S2 delivery are required later.
- Keep k3s single-server SQLite, Flannel VXLAN, App/Judge placement, no public API/SSH, existing go-judge and Compose. Preserve the verified data mount and agent-only Judge token.
- Keep Goose v3.30.0, separate runtime and migration roles, per-database history/locking, immutable migration inputs, forward-only managed releases and explicit reconciliation. Retain the existing managed ADR-0006 requirements: ledger read-only for application roles, prevent stale writers on lock loss, reject unexpected history, no automatic destructive down migration. Current exact schema checks mean a same-schema rollback drill is appropriate; future schema-advancing releases still need verified compatibility, not an exception that weakens NFR-D03/D05.
- Keep the existing stop-before-start Submission rule, exact-digest releases, separate owner lifecycle vs maintainer deployment approvals and one hour from readiness. Keep 12 hours/day deallocated, independent cleanup, no contest-window deployment and no hidden production activation.
- Keep the NFR-D04 two-hour recreation clock honest: no existing environment resources in the target subscription; include controller, network, storage, bootstrap and running stack. Report account/S4 prerequisites separately. S3 candidate sizing and initial costs do not prove semester-long production affordability. Retain the M3 affordability checkpoint and later M0-14/M0-15/M2-06/M2-07/M2-08 scope boundaries.

## 5. Decisions and unresolved prerequisites

| Decision | Review recommendation / status |
| --- | --- |
| Pre-/post-merge Gate 2 sequencing | Recommend the explicit exception in G1-01; **Orchestrator approval required** before Apply. |
| Daily off window | 00:00–12:00 Asia/Ho_Chi_Minh is a candidate, not an accepted scheduling preference. Ask the owner to confirm or change it before operational configuration; keep the 12-hour floor and margins regardless. |
| Private delivery transport | App outbound pull via one scoped controller is acceptable as a candidate subject to G1-02/G1-04/G1-05 and actual Azure verification; do not force a more complex alternative. |
| Cross-tenant backend and roles | Cannot verify before subscriptions are activated. Preflight is a hard gate to any provisioning. |
| Azure plan/SKU/quota/actual costs, certificates and protected GitHub settings | Pending real preflight and rehearsal; do not fabricate results or interpret this review as cloud authorization. |

## 6. Instructions for Codex — review round 1 remediation only

1. Stay on `feature/azure-walking-skeleton`. Read this review and current `AGENTS.md`, the OpenSpec artifacts and cited decisions. Check the current diff; do not reset to the reviewed commit or overwrite unrelated user work.
2. Resolve G1-01 through G1-05 with targeted updates to `proposal.md`, `design.md`, `specs/environment-delivery/spec.md`, `tasks.md` and `progress.md` as needed. For each finding report the changed section and verification/evidence planned. Preserve the review record as reviewer feedback; do not rewrite its verdict as if approved.
3. Keep 5–15 tasks; regroup or clarify existing tasks rather than mechanically adding one task per finding. Keep implementation tasks unchecked. Distinguish pre-merge and post-merge evidence. Keep spec requirements behavioral and update the scenario-to-verification mapping for new failure cases.
4. Do not edit Accepted ADRs, canonical specs, workflow policy, product documents or implementation files. No Terraform resources, Kubernetes manifests, GitHub Actions changes, actual cloud calls, secret requests, deployment, archive, automatic commit/push or production activation in this session.
5. Run `openspec validate azure-walking-skeleton --strict`, `openspec status --change azure-walking-skeleton`, `openspec validate --all --strict` and `git diff --check`. Check changed links, scope and artifact-rule compliance manually if the installed OpenSpec version still ignores string-valued rules. Do not claim commands passed unless executed. Update `progress.md` with actual results and outstanding owner decisions.
6. Return a finding disposition table (G1-01–G1-05), changed paths, actual validation results and any unresolved assumptions. Stop at Gate 1 for another independent review. **Do not start OpenSpec apply merely because the documentation has been revised.**

Suggested location for this review record: `openspec/changes/azure-walking-skeleton/review-gate1.md`. This file is delivered separately to the owner; no GitHub review, repository write, owner approval or deployment has been performed by the reviewer.
