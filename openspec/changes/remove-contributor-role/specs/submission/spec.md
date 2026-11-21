## MODIFIED Requirements

### Requirement: Authenticated creation ownership

The system SHALL require authenticated identity and the User, Moderator, or Admin role to create a Submission. It SHALL derive the owner identity and username from the authenticated identity and reject unsupported roles.

#### Scenario: Guest attempts creation
- **WHEN** a Guest requests a new Submission
- **THEN** the request is rejected as unauthenticated and no Submission is created

#### Scenario: Owner is assigned on creation
- **WHEN** an authenticated User, Moderator, or Admin successfully creates a Submission
- **THEN** the Submission belongs to that caller and records their authenticated username

#### Scenario: Caller with an unsupported role attempts creation
- **WHEN** a caller with an unsupported role requests a new Submission
- **THEN** the request is forbidden before any Submission is created

### Requirement: Personal history owner scope

The system SHALL allow an authenticated User, Moderator, or Admin to read personal Submission history, always restricted to that caller's own Submissions. Missing identity or Role SHALL be rejected as unauthenticated and other Roles SHALL be forbidden.

#### Scenario: User reads personal history
- **WHEN** an authenticated User requests personal history
- **THEN** only that User's Submissions are returned

#### Scenario: Staff reads personal history
- **WHEN** a Moderator or Admin requests personal history
- **THEN** only that caller's Submissions are returned

#### Scenario: Guest or unknown Role reads personal history
- **WHEN** the caller lacks identity or Role, or has an unsupported Role
- **THEN** the request is rejected as unauthenticated or forbidden respectively

### Requirement: Source-bearing detail access

The system SHALL require a positive Submission identifier and authenticated identity and Role for source-bearing detail. Users SHALL be restricted to their own Submissions; Moderators and Admins SHALL be able to read any owner's Submission. A missing or other owner's Submission requested without staff privileges SHALL return the same not-found outcome, and unsupported Roles SHALL be forbidden.

#### Scenario: Owner reads detail
- **WHEN** a User requests their own existing Submission
- **THEN** the detail, including stored source code, is returned

#### Scenario: Other owner and absent Submission are indistinguishable
- **WHEN** a User requests another owner's Submission or a nonexistent Submission
- **THEN** both requests return not found

#### Scenario: Staff reads another owner's detail
- **WHEN** a Moderator or Admin requests another owner's existing Submission
- **THEN** its source-bearing detail is returned

### Requirement: Staff detail and current Attempt provenance

The system SHALL restrict staff Submission detail to authenticated Moderators and Admins using a positive Submission identifier. It SHALL include source-bearing Submission data and available current-Attempt trigger, initiator, creation time, testcase version, reported total, and dataset checksum. It SHALL return current-Attempt testcase indexes, Verdicts, runtime, and memory in ascending index order, count Accepted results as passed and returned results as executed, and omit testcase inputs and all expected/actual outputs. Unavailable Attempt provenance SHALL remain null rather than being inferred from results.

#### Scenario: Staff inspects current Attempt
- **WHEN** a Moderator or Admin reads staff detail with current-Attempt provenance and unordered testcase results
- **THEN** the provenance and source are returned with testcase summaries sorted by index and with separate passed, executed, and reported-total counts

#### Scenario: Legacy Attempt has no provenance
- **WHEN** staff detail has no matching Attempt metadata but has stored testcase results
- **THEN** testcase summaries are returned while trigger, initiator, Attempt time, version, reported total, and checksum remain null

#### Scenario: Lower Role requests staff detail
- **WHEN** a User requests staff detail
- **THEN** access is forbidden
