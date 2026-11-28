## Purpose

Define how operators reproduce an isolated staging environment, deliver an immutable AstraCode release through separate approvals, and verify its operation and scheduled deallocation.

## ADDED Requirements

### Requirement: ED-01 Reproducible and isolated environments
Operators SHALL be able to recreate a complete environment from versioned definitions within two hours in another preflighted subscription, starting with no AstraCode environment resources there. The definition SHALL keep App and Judge on separate hosts, with independent state, workloads and data per environment. Persistent workloads SHALL start only with verified persistent storage.

#### Scenario: Recreate the stack in a separate subscription
- **WHEN** operators build an environment from reviewed inputs in a preflighted subscription without an existing stack
- **THEN** networking, storage, App and Judge roles, backing services and application reach readiness within two hours of the first environment provisioning action
- **AND** the release uses only the target environment's configuration, state and data

#### Scenario: App data disk is unavailable
- **WHEN** the designated App data disk is absent, wrong or unmounted
- **THEN** persistent workloads remain inactive and no fallback data is written to the OS disk

#### Scenario: VM existence or power changes
- **WHEN** an operator shuts down, reconciles or proposes creation or replacement of a VM
- **THEN** shutdown deallocates the VM and retains its managed resources and the App disk
- **AND** routine reconciliation needs no startup grant, while creation or replacement requires its exact approved plan and a current owner-approved infrastructure window at apply
- **AND** replacement fits existing capacity, preserves the network identities and reattaches the retained App disk as-is

#### Scenario: First provisioning with no VM history
- **WHEN** an operator applies an exact approved initial compute plan within an authorized infrastructure window with no existing VMs
- **THEN** provisioning can proceed without a staging off-time history, while authorized cleanup is prepared and tester access remains closed

#### Scenario: Replacement stops after the old VM is deleted
- **WHEN** an approved replacement leaves one VM absent and the operator reconciles the actual state and obtains approval of a fresh recovery plan
- **THEN** only the approved missing VM is recreated within existing capacity and with the retained disk, NICs and public IPs
- **AND** tester access remains closed until recovery and verification finish

### Requirement: ED-02 Restricted ingress and execution
Staging SHALL serve authorized members over HTTPS during an approved session. Cluster management, private services and backing services SHALL reject external access. The application gateway SHALL remain the source of verified identity for protected services. Official submissions and interactive user code SHALL run only inside the sandbox with CPU, memory, process, wall-time and output limits and SHALL be unable to reach any network destination, cloud metadata or node credentials. Runtime credentials SHALL be scoped to their respective purposes and kept out of published artifacts. Workload activation SHALL enforce platform-approved placement, execution privileges and credential access. The platform SHALL refuse privileged execution except for the explicitly approved executor workload with matching artifact, template and placement. The executor SHALL accept private Worker traffic only.

#### Scenario: Unauthorized staging or backend access
- **WHEN** an unauthorized client attempts staging access, or a client attempts to reach a protected service directly or supply forged identity
- **THEN** it gains neither staging access nor an authenticated identity through those attempts
- **AND** management interfaces and private service ports are inaccessible from outside the authorized network paths

#### Scenario: Judge workload reaches its required dependencies
- **WHEN** the Worker processes an official submission or an interactive Run Code request
- **THEN** the Worker can use its allowed private dependencies and the executor enforces the configured resource limits
- **AND** submitted code cannot reach network destinations or access host and cloud credentials

#### Scenario: Workload attempts to cross its authority boundary
- **WHEN** an ordinary App workload or Judge Worker attempts to use a host cloud identity, another workload's credentials or an unauthorized management interface
- **THEN** it obtains neither credentials nor management access through those attempts

#### Scenario: Privileged executor restarts
- **WHEN** the trusted daemon restarts with a stale or missing permit
- **THEN** judging stays closed until authorized recovery issues a valid permit

#### Scenario: Release requests additional workload privileges
- **WHEN** a release requests unauthorized host or secret access, workload identity, placement or elevated execution privileges
- **THEN** the request is refused before that workload can activate

### Requirement: ED-03 Immutable publication and environment configuration
Every merge to `develop` SHALL run the required checks for its source revision. Each passing merge SHALL produce an immutable canonical release with source revision, workload image digests, configuration revision, migration artifact and owning schema versions. Publication SHALL reconcile missing results for eligible commits without replacing a previously published release. Publishing SHALL have no authority to start or deploy an environment. Environments SHALL run identical images for a release and supply their own configuration and secrets at runtime.

#### Scenario: Passing merges publish under concurrent CI
- **WHEN** multiple merged commits pass their checks in close succession
- **THEN** each commit has its own complete digest-bound release record
- **AND** publication leaves staging power and workload state untouched

#### Scenario: Checks fail or publication is incomplete
- **WHEN** the required checks fail or any required artifact is missing or mismatched
- **THEN** the commit is ineligible for deployment as a complete release

#### Scenario: Publication is interrupted for an eligible revision
- **WHEN** publication of a checked merge is interrupted and then retried through the protected publication path
- **THEN** the same source revision has one complete canonical release record and a retry cannot replace its recorded digest

#### Scenario: Artifact originates outside protected publication
- **WHEN** an artifact is published from an unapproved revision, an obsolete entry point or a temporary-test rehearsal
- **THEN** the artifact cannot be selected as a canonical release for staging

#### Scenario: Release renders for separate environments
- **WHEN** the same release is selected for two environment configurations
- **THEN** all workload image digests match and each environment receives its own runtime configuration and credentials

### Requirement: ED-04 Staging request and approval boundaries
Authorized team members SHALL be able to request a staging window, deployment or rollback through an existing protected channel. Only the project owner SHALL approve the startup window or changes to it. An authorized infrastructure operator SHALL start the VMs manually during that approved window. Either designated deployment maintainer SHALL be able to approve deployment or rollback. Deployment approval SHALL bind the exact release, target, action and execution attempt and confer no VM power authority.

#### Scenario: First activation
- **WHEN** an authorized operator starts an empty environment within its owner-approved window
- **THEN** the operator verifies both VM states, App storage, k3s readiness and workload safety
- **AND** application activation waits for separate deployment approval and testers enter only after readiness checks pass

#### Scenario: Wrong role, action or release
- **WHEN** the actor or execution context is unauthorized, the approved release or action is changed or reused for a different attempt, or only deployment approval exists for a stopped environment
- **THEN** the unapproved operation has no effect on the environment

### Requirement: ED-05 Operating windows and operation admission
Staging SHALL operate only during an owner-approved window. Both VMs SHALL have automatic daily deallocation independent of GitHub at the configured cutoff. Staging SHALL be deallocated at least 12 hours per day, measured from actual power-state observations for both VMs. A window change SHALL require fresh owner approval and preserve the daily off-time floor. The operator SHALL be able to see the approved window, scheduled cutoff and actual VM status. The delivery path SHALL admit at most one deployment or migration at a time and require enough time to complete or stop safely before cutoff.

#### Scenario: Start within the approved window
- **WHEN** the operator confirms the recorded approval, both automatic shutdown schedules and the required off-time before manual startup
- **THEN** staging may start inside the window with the approved cutoff unchanged by the time readiness is reached

#### Scenario: Window change or operation exceeds its bounds
- **WHEN** a window change lacks fresh approval, violates the off-time floor, or a deployment is concurrent or too close to the cutoff
- **THEN** the existing window remains in force and the unsafe operation does not start

### Requirement: ED-06 Managed migration and activation gate
An approved deployment SHALL automatically verify the exact release and target, run only the release's reviewed forward migrations, verify all owning database histories, roll out the workloads, check readiness and run smoke tests before recording success. The system SHALL block planned changes during a contest window, serialize migration writers and withhold activation after migration failure, unknown state or failed verification. On restart, application processes and background writers SHALL require verified release authorization. Migration work SHALL require fresh authorization for its specific attempt. Submission replacement SHALL wait for verified termination of the previous instance and its outbox relay.

#### Scenario: Deploy the approved release
- **WHEN** a designated maintainer approves a release during an eligible staging window
- **THEN** the rollout records the release and migration evidence, verifies prior Submission termination before replacement, and records readiness and smoke results against the deployed digests

#### Scenario: Migration contends, fails or has an unknown outcome
- **WHEN** migration ownership is unclear, an owning database fails or becomes unverifiable, or the previous Submission instance cannot be confirmed terminated
- **THEN** the candidate remains inactive and operators can see the affected step and any known database progress
- **AND** a competing attempt cannot proceed while the previous migration writer may still be active

#### Scenario: Approved change falls within a contest window
- **WHEN** an approved staging deployment or migration would overlap a contest window
- **THEN** the system denies admission before changing workloads or schemas

#### Scenario: Restart after an interrupted migration or rollout
- **WHEN** a node or cluster restarts after abrupt shutdown or loss of authorization during a partial migration or candidate rollout
- **THEN** backing services can become ready for reconciliation while application and judging processes remain inactive and no stale migration performs schema changes
- **AND** the outbox relay, result consumer and judge work remain blocked until authorized recovery verifies the release and every owning database history

### Requirement: ED-07 Compatible rollback
An authorized rollback SHALL restore a previously verified compatible application release and configuration while retaining applied schema versions. The previous Submission and its outbox relay SHALL terminate before replacement. The compatible rollback drill SHALL restore readiness within 15 minutes. If compatibility or prior process termination cannot be verified, rollout SHALL stop and expose the recovery condition.

#### Scenario: Restore a compatible release
- **WHEN** a designated maintainer approves rollback to an eligible release
- **THEN** the prior images and configuration return to readiness within 15 minutes, applied schema versions are retained and Submission instances do not overlap

#### Scenario: Rollback would fail the startup version check
- **WHEN** the selected rollback release cannot start on the schema now present
- **THEN** rollback is refused before application activation and no schema downgrade is attempted

#### Scenario: S3 rehearses a two-release rollback
- **WHEN** the protected operator deploys and rolls back between two compatible S3 bundles approved for the experiment
- **THEN** both bundles are independently bound to reviewed sources and verified receipts, and rollback requires a previously verified target for that environment
- **AND** delivery refuses any selected or fallback bundle outside the immutable experiment set

### Requirement: ED-08 Scheduled deallocation and recovery
Staging SHALL close admission and finish or safely interrupt work by the approved cutoff. Automatic scheduled deallocation of both VMs SHALL be independent of GitHub and preserve persistent data. The operator SHALL verify both actual deallocated states and respond to missed or partial shutdown independently of the workflow. Staging SHALL withhold access and new startup while power or workload state is uncertain. A separate emergency path SHALL permit only observation and deallocation of the affected VMs. Temporary test compute SHALL have an approved cutoff and independently verified cleanup.

#### Scenario: Cutoff with active work
- **WHEN** the approved cutoff approaches while Run Code or official judging is in flight
- **THEN** new testing work is rejected, in-flight work is resolved or retained for safe reconciliation, and both VMs deallocate on schedule
- **AND** durable submissions and persistent data are available on a subsequent verified start

#### Scenario: Workflow interruption or partial shutdown
- **WHEN** deployment is cancelled, only one VM deallocates, or observed power is unknown
- **THEN** the schedule remains in effect independently of the workflow, tester access stays closed, and the operator verifies and retries cleanup through the separate emergency path as needed
- **AND** completion is recorded only after both actual VM states are deallocated

#### Scenario: Temporary experiment is interrupted
- **WHEN** provisioning or rehearsal ends before its approved cutoff
- **THEN** the operator verifies deallocation of the experiment VMs and records any surviving inventory, with automatic shutdown still configured

#### Scenario: Authorized S3 hard-stop recovery
- **WHEN** both S3 VMs are confirmed deallocated after a hard stop with interrupted work
- **THEN** the operator may restart only under fresh authorization within the approved experiment bounds
- **AND** fresh node identity, exact deployment approval and workload/data reconciliation are required before clearing stale work or reopening access

### Requirement: ED-09 Future promotion eligibility
When production promotion is enabled, a protected semantic tag SHALL identify the exact release that passed staging. Promotion SHALL require a designated maintainer's approval and preserve that release's source, image digests, configuration revision and migration artifact. The promotion flow SHALL block operations during a contest window. M0-13 SHALL exercise promotion eligibility without deploying production.

#### Scenario: Eligible production release
- **WHEN** a protected semantic tag references a release with matching successful staging evidence
- **THEN** eligibility verification resolves the same immutable release and its digests without rebuilding artifacts

#### Scenario: Unapproved or invalid promotion
- **WHEN** the selected digest lacks matching canonical staging evidence, the only evidence is a temporary-test rehearsal, the approval is missing or a contest window is active
- **THEN** the release cannot be promoted

### Requirement: ED-10 Cloud acceptance evidence
Acceptance SHALL require recorded real-cloud evidence for a fresh environment recreation, canonical staging release delivery, workload isolation, migration and rollback, and staging lifecycle. Operators SHALL verify subscription budget thresholds of 50%, 80% and 100%, estimate recurring costs before staging provisioning, measure initial costs and use measured workload and platform resource usage to confirm sizing assumptions. Final acceptance SHALL require successful staging evidence for the release published after the implementation merge. Rehearsal evidence SHALL cover only the approved test target and exact reviewed candidate.

#### Scenario: Azure checkpoint
- **WHEN** operators seek acceptance after the authorized cloud exercises
- **THEN** the record identifies the tested release, sanitized target, timings, workload and cluster footprint, costs, budget alerts and outcomes for required drills
- **AND** any missing real-cloud evidence leaves the corresponding acceptance criterion open

#### Scenario: Staging capability or budget is unverified
- **WHEN** a required staging capability is unsupported or the projected recurring cost cannot be shown to fit the approved budget
- **THEN** operators pause staging provisioning and record the unresolved decision for owner review

#### Scenario: Canonical staging acceptance fails
- **WHEN** the post-merge release fails staging acceptance
- **THEN** acceptance remains open and the failed release is ineligible for promotion regardless of test rehearsal results
