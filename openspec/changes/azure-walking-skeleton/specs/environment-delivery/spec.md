## Purpose

Define how operators reproduce an isolated staging environment, deliver an immutable AstraCode release through separate approvals, and verify its operation and automatic shutdown.

## ADDED Requirements

### Requirement: ED-01 Reproducible and isolated environments
Operators SHALL be able to recreate a complete environment from versioned definitions within two hours in another preflighted subscription, starting with no AstraCode environment resources there. The definition SHALL keep App and Judge on separate hosts, with independent state, workloads and data per environment. Persistent workloads SHALL start only with verified persistent storage.

#### Scenario: Recreate the stack in a separate subscription
- **WHEN** operators build an environment from reviewed inputs in a preflighted subscription without an existing stack
- **THEN** the App and Judge roles, backing services and application reach readiness within two hours
- **AND** the release uses only the target environment's configuration, state and data

#### Scenario: App data disk is unavailable
- **WHEN** the designated App data disk is absent, wrong or unmounted
- **THEN** persistent workloads remain inactive and no fallback data is written to the OS disk

### Requirement: ED-02 Restricted ingress and execution
Staging SHALL serve authorized members over HTTPS during an approved session. Cluster management, private services and backing services SHALL reject external access. The application gateway SHALL remain the source of verified identity for protected services. Submitted code SHALL use the existing sandbox limits and SHALL be unable to reach any network destination, cloud metadata or node credentials. Runtime credentials SHALL be scoped to their respective purposes and kept out of published artifacts.

#### Scenario: Unauthorized staging or backend access
- **WHEN** an unauthorized client attempts staging access, or a client attempts to reach a protected service directly or supply forged identity
- **THEN** it gains neither staging access nor an authenticated identity through those attempts
- **AND** management interfaces and private service ports are inaccessible from outside the authorized network paths

#### Scenario: Judge workload reaches its required dependencies
- **WHEN** the Worker processes an official submission or an interactive Run Code request
- **THEN** the Worker can use its allowed private dependencies and the executor enforces the configured resource limits
- **AND** submitted code cannot reach network destinations or access host and cloud credentials

### Requirement: ED-03 Immutable publication and environment configuration
Every merge to `develop` SHALL run the required checks for its source revision. Each passing merge SHALL produce an immutable release with source revision, workload image digests, configuration revision, migration artifact and owning schema versions. Publishing SHALL have no authority to start or deploy an environment. Environments SHALL run identical images for a release and supply their own configuration and secrets at runtime.

#### Scenario: Passing merges publish under concurrent CI
- **WHEN** multiple merged commits pass their checks in close succession
- **THEN** each commit has its own complete digest-bound release record
- **AND** publication leaves staging power and workload state untouched

#### Scenario: Checks fail or publication is incomplete
- **WHEN** the required checks fail or any required artifact is missing or mismatched
- **THEN** the commit is ineligible for deployment as a complete release

#### Scenario: Release renders for separate environments
- **WHEN** the same release is selected for two environment configurations
- **THEN** all workload image digests match and each environment receives its own runtime configuration and credentials

### Requirement: ED-04 Staging request and approval boundaries
Authorized team members SHALL be able to request staging startup, extensions and deployments. Only the project owner SHALL approve startup or extension. Either designated deployment maintainer SHALL be able to approve deployment. Each approval SHALL be bound to its operation and request, and deployment approval SHALL confer no power or extension authority. An empty environment SHALL require deployment approval during bounded startup before testers are admitted.

#### Scenario: First activation
- **WHEN** the project owner approves startup for an empty environment
- **THEN** the environment may boot within a bounded startup period
- **AND** application activation waits for separate deployment approval and testers enter only after readiness checks pass

#### Scenario: Wrong role, action or release
- **WHEN** the actor lacks the required approval role, an approval is replayed for a different request or release, or only deployment approval exists for a stopped environment
- **THEN** the unapproved operation has no effect on the environment

### Requirement: ED-05 Session clock, extensions and operation admission
Staging SHALL provide one hour of testing from recorded readiness unless an earlier safety shutdown is required. An extension SHALL require fresh owner approval for the current session and remain within the daily off-time policy. Staging SHALL remain deallocated at least 12 hours per day. Operators SHALL be able to observe the session deadline and status. Staging SHALL reject concurrent startup requests and SHALL admit at most one deployment or migration operation at a time within a sufficient remaining safe window.

#### Scenario: Session starts at readiness
- **WHEN** an owner-approved startup completes all required readiness checks
- **THEN** the one-hour deadline begins at readiness and operators can see the recorded expiry

#### Scenario: Owner approves an extension that fits
- **WHEN** the project owner approves a fresh extension for the current ready session and the extended deadline fits the off-time policy
- **THEN** the system records the new expiry against the same session and uses it for admission and cleanup

#### Scenario: Startup, extension or deploy request exceeds its window
- **WHEN** a second startup races an active request, an extension lacks fresh owner approval, or the requested operation would breach its safe completion window or the daily off-time floor
- **THEN** the operation is denied and the existing session deadline is preserved

### Requirement: ED-06 Managed migration and activation gate
An approved deployment SHALL automatically verify the exact release and target, run only the release's reviewed forward migrations, verify all owning database histories, roll out the workloads, check readiness and run smoke tests before recording success. The system SHALL block planned changes during a contest window, serialize migration writers and withhold activation after migration failure, unknown state or failed verification. Submission replacement SHALL wait for verified termination of the previous instance and its outbox relay.

#### Scenario: Deploy the approved release
- **WHEN** a designated maintainer approves a release during an eligible staging startup or session
- **THEN** the rollout records the release and migration evidence, verifies prior Submission termination before replacement, and records readiness and smoke results against the deployed digests

#### Scenario: Migration contends, fails or has an unknown outcome
- **WHEN** migration ownership is unclear, an owning database fails or becomes unverifiable, or the previous Submission instance cannot be confirmed terminated
- **THEN** the candidate remains inactive and operators can see the affected step and any known database progress
- **AND** a competing attempt cannot proceed while the previous migration writer may still be active

#### Scenario: Approved change falls within a contest window
- **WHEN** an approved staging deployment or migration would overlap a contest window
- **THEN** the system denies admission before changing workloads or schemas

### Requirement: ED-07 Compatible rollback
An authorized rollback SHALL restore a previously verified compatible application release and configuration while retaining applied schema versions. The previous Submission and its outbox relay SHALL terminate before replacement. The compatible rollback drill SHALL restore readiness within 15 minutes. If compatibility or prior process termination cannot be verified, rollout SHALL stop and expose the recovery condition.

#### Scenario: Restore a compatible release
- **WHEN** a designated maintainer approves rollback to an eligible release
- **THEN** the prior images and configuration return to readiness within 15 minutes, applied schema versions are retained and Submission instances do not overlap

#### Scenario: Rollback would fail the startup version check
- **WHEN** the selected rollback release cannot start on the schema now present
- **THEN** rollback is refused before application activation and no schema downgrade is attempted

### Requirement: ED-08 Durable shutdown and recovery
Staging SHALL close admission for new testing work at expiry, finish or safely interrupt in-flight work within a bounded drain, and automatically deallocate both VMs while preserving persistent data. Expiry and cleanup SHALL survive a failed or cancelled delivery workflow and a partial start or stop. The system SHALL retry unfinished deallocation, alert maintainers when it cannot confirm both VM power states by the cleanup deadline, and keep cases with uncertain data or rollout outcomes closed to testers until reconciled.

#### Scenario: Expiry with active work
- **WHEN** an approved session expires with Run Code or official judging still in flight
- **THEN** new testing work is rejected, in-flight work is resolved or recorded for safe reconciliation, and both VMs are deallocated
- **AND** durable submissions and persistent data are available on a subsequent verified start

#### Scenario: Workflow interruption or partial cleanup
- **WHEN** startup or deployment is interrupted, startup times out, or only one VM deallocates on the first attempt
- **THEN** independent cleanup retries until both VM states are confirmed, reports a missed cleanup deadline and keeps unresolved application state closed to testing

### Requirement: ED-09 Future promotion eligibility
When production promotion is enabled, a protected semantic tag SHALL identify the exact release that passed staging. Promotion SHALL require a designated maintainer's approval and preserve that release's source, image digests, configuration revision and migration artifact. The promotion flow SHALL block operations during a contest window. M0-13 SHALL exercise promotion eligibility without deploying production.

#### Scenario: Eligible production release
- **WHEN** a protected semantic tag references a release with matching successful staging evidence
- **THEN** eligibility verification resolves the same immutable release and its digests without rebuilding artifacts

#### Scenario: Unapproved or invalid promotion
- **WHEN** the release lacks matching staging evidence, the approval is missing or a contest window is active
- **THEN** the release cannot be promoted

### Requirement: ED-10 Cloud acceptance evidence
Acceptance SHALL require recorded real-cloud evidence for a fresh environment recreation, staging release delivery, workload isolation, migration and rollback, and staging lifecycle. Operators SHALL verify subscription budget thresholds of 50%, 80% and 100%, measure initial costs and use measured workload and platform resource usage to confirm sizing assumptions.

#### Scenario: Azure checkpoint
- **WHEN** operators seek acceptance after the authorized cloud exercises
- **THEN** the record identifies the tested release, sanitized target, timings, workload and cluster footprint, costs, budget alerts and outcomes for required drills
- **AND** any missing real-cloud evidence leaves the corresponding acceptance criterion open
