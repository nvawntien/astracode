## Purpose

Record the existing behavior for official Submission creation, Attempts, history, detail, Rejudge, and application of current-Attempt results.

## ADDED Requirements

### Requirement: Authenticated creation ownership

The system SHALL require an authenticated user to create a Submission and SHALL derive its owner identity and username from the authenticated identity.

#### Scenario: Guest attempts creation
- **WHEN** a Guest requests a new Submission
- **THEN** the request is rejected as unauthenticated and no Submission is created

#### Scenario: Owner is assigned on creation
- **WHEN** an authenticated user successfully creates a Submission
- **THEN** the Submission belongs to that user and records that user's authenticated username

### Requirement: Creation input validation

The system SHALL require a positive coding problem identifier, an exact language value of `CPP`, `GO`, `PYTHON`, or `JAVA`, and source code containing non-whitespace content with a size of at most 262144 bytes. It SHALL preserve accepted source code without trimming it.

#### Scenario: Unsupported or differently formatted language
- **WHEN** creation specifies `C`, `JAVASCRIPT`, `go`, or ` GO ` as the language
- **THEN** the request is rejected as an invalid language

#### Scenario: Invalid problem or source
- **WHEN** creation specifies a non-positive problem identifier, whitespace-only source, or source larger than 262144 bytes
- **THEN** the request is rejected before problem access is checked or durable creation starts

#### Scenario: Source exactly at the limit
- **WHEN** otherwise valid creation provides nonblank source of exactly 262144 bytes, including surrounding whitespace
- **THEN** source validation succeeds and the original source is retained

### Requirement: Authoritative problem access before creation

The system SHALL request canonical coding problem metadata using the authenticated user's identity and Role before creating a Submission. It SHALL use the returned problem identity and title, and SHALL reject creation when the problem is inaccessible, absent, unavailable, or returns incomplete metadata.

#### Scenario: Canonical problem is returned
- **WHEN** a valid creation request receives accessible canonical problem metadata
- **THEN** the new Submission records the returned problem identifier and title

#### Scenario: Problem access is denied
- **WHEN** the problem access decision is unauthenticated, forbidden, or not found
- **THEN** that failure is returned without acquiring cooldown or creating a Submission

#### Scenario: Problem lookup cannot be trusted
- **WHEN** lookup is unavailable or times out, or returns a non-positive identifier or blank title or slug
- **THEN** creation fails as temporarily unavailable without creating a Submission

### Requirement: Creation cooldown per user and problem

After successful input and problem-access validation, the system SHALL acquire a configured cooldown for the user and canonical coding problem pair. A second creation during that cooldown SHALL be rejected with a retry delay; another user or problem SHALL have an independent cooldown. Protection failure SHALL reject creation as temporarily unavailable. An acquired cooldown SHALL remain in effect if a later creation step fails.

#### Scenario: Repeated creation during cooldown
- **WHEN** a user submits again to the same canonical problem before their acquired cooldown expires
- **THEN** the request is rate limited with a retry delay and no new Attempt or Submission is created

#### Scenario: Independent pair
- **WHEN** a creation request uses a different user or canonical problem with no active cooldown
- **THEN** the existing pair's cooldown does not prevent acquisition

#### Scenario: Cooldown protection fails
- **WHEN** cooldown protection is unavailable or returns an error
- **THEN** creation fails as temporarily unavailable before an Attempt identity is allocated or any durable write occurs

#### Scenario: Failure after acquisition
- **WHEN** cooldown is acquired but subsequent durable creation fails
- **THEN** no successful Submission is returned and the cooldown is not released early

### Requirement: Atomic durable Submission creation

The system SHALL save a new Pending Submission, its initial Pending Attempt, and the durable judging request for that same Attempt as one atomic operation. Success SHALL return the Submission identifier, canonical problem identifier and title, language, Pending status, and creation time. A failure to save any part SHALL fail creation without committing the other parts.

#### Scenario: Creation succeeds
- **WHEN** all parts of durable creation succeed
- **THEN** one Pending Submission and its initial Attempt are committed with a matching durable request and the creation summary is returned

#### Scenario: Creation persistence fails
- **WHEN** saving the Submission, initial Attempt, or durable request fails
- **THEN** creation reports an internal failure and none of those writes are committed

### Requirement: Attempt identity and provenance retention

The system SHALL assign a nonblank identity to each newly created Attempt, make it the Submission's current Attempt, and record whether it was triggered by initial submission or Rejudge, who triggered it, and its creation time. Previous Attempts and their results SHALL remain retained when a Rejudge creates a new Attempt.

#### Scenario: Initial Attempt records its trigger
- **WHEN** a user creates a Submission
- **THEN** its initial Attempt is Pending and records initial submission as its trigger and the user as its initiator

#### Scenario: Rejudge preserves prior Attempt data
- **WHEN** a Moderator or Admin successfully Rejudges a completed Submission
- **THEN** a new current Attempt records Rejudge and that staff user's identity while the previous Attempt and its testcase results remain retained

### Requirement: Personal history owner scope

The system SHALL allow an authenticated User, legacy Contributor, Moderator, or Admin to read personal Submission history, always restricted to that caller's own Submissions. Missing identity or Role SHALL be rejected as unauthenticated and other Roles SHALL be forbidden.

#### Scenario: Staff reads personal history
- **WHEN** a Moderator or Admin requests personal history
- **THEN** only that caller's Submissions are returned

#### Scenario: Guest or unknown Role reads personal history
- **WHEN** the caller lacks identity or Role, or has an unsupported Role
- **THEN** the request is rejected as unauthenticated or forbidden respectively

### Requirement: Personal history filters

The system SHALL support combined personal-history filters for status, executable language, and positive coding problem identifier. Status and language filters SHALL be whitespace-trimmed and case sensitive; blank filters SHALL be treated as absent. Recognized statuses SHALL include Pending, Judging, and all terminal Verdicts, while language filters SHALL permit only `CPP`, `GO`, `PYTHON`, and `JAVA`.

#### Scenario: Combined personal filters
- **WHEN** a user requests their history with ` ACCEPTED `, ` GO `, and a positive problem identifier
- **THEN** all three filters apply together within that user's history

#### Scenario: Invalid personal filters
- **WHEN** personal history specifies an unknown status, `C`, `JAVASCRIPT`, a differently cased language, or a non-positive problem identifier
- **THEN** the request is rejected as invalid

#### Scenario: Blank personal filters
- **WHEN** personal history supplies only whitespace for status or language
- **THEN** those filters are omitted

### Requirement: History pagination and ordering

Personal and staff history SHALL default to page 1 and 20 items per page, accept positive page numbers and page sizes from 1 through 100, and reject invalid pagination. Results SHALL be ordered by creation time descending, then identifier descending for ties. Responses SHALL include the requested page and size, filtered total, and rounded-up total page count; an empty result set SHALL have zero total pages.

#### Scenario: Defaults and tied creation times
- **WHEN** a caller requests accessible history without pagination and some Submissions have equal creation times
- **THEN** page 1 contains at most 20 matching Submissions, with newer entries first and larger identifiers first for ties

#### Scenario: Invalid pagination
- **WHEN** a caller requests page zero, a negative page, or a page size outside 1 through 100
- **THEN** history rejects the request

#### Scenario: Empty or out-of-range page
- **WHEN** the requested page contains no matching entries
- **THEN** the response contains an empty collection while retaining the filtered total and its computed total page count

### Requirement: Staff history access and filters

The system SHALL restrict system-wide Submission history to authenticated Moderators and Admins. It SHALL support combined optional status, language, positive problem identifier, and user-identity filters. Provided text filters SHALL be whitespace-trimmed and nonblank; status and language SHALL be recognized exact values. Staff language filters SHALL also recognize `C` and `JAVASCRIPT`.

#### Scenario: Staff searches across owners
- **WHEN** a Moderator or Admin requests staff history without a user filter
- **THEN** matching Submissions from any owner can be returned

#### Scenario: Staff filters a specific owner
- **WHEN** a Moderator or Admin combines user, problem, status, and language filters
- **THEN** only Submissions matching every provided filter are returned

#### Scenario: Staff filter compatibility
- **WHEN** staff history specifies `C` or `JAVASCRIPT`
- **THEN** the language filter is accepted even though that language cannot be used for a new Submission

#### Scenario: Unauthorized access or invalid staff filters
- **WHEN** a User requests staff history, or an authorized staff caller provides a blank text filter or an unknown language or status
- **THEN** access is forbidden for the User and invalid filters are rejected for the staff caller

### Requirement: History summary privacy

Personal history SHALL return Submission identity, problem identity and recorded title, language, current status, optional runtime and memory, testcase summary counts, and creation time. Staff history SHALL return Submission, problem, and owner identity, recorded title and username, language, current status, and creation time. Both SHALL omit source code, compiler/error messages, and testcase inputs, expected outputs, and actual outputs.

#### Scenario: Personal history summary
- **WHEN** a user reads their history after a Submission has results
- **THEN** summary information is returned without source code or testcase contents

#### Scenario: Staff history summary
- **WHEN** a Moderator or Admin reads system-wide history
- **THEN** owner identity is included, without source code, diagnostics, or testcase contents

### Requirement: Source-bearing detail access

The system SHALL require a positive Submission identifier and authenticated identity and Role for source-bearing detail. Users and legacy Contributors SHALL be restricted to their own Submissions; Moderators and Admins SHALL be able to read any owner's Submission. A missing or other owner's Submission requested without staff privileges SHALL return the same not-found outcome, and unsupported Roles SHALL be forbidden.

#### Scenario: Owner reads detail
- **WHEN** a User or legacy Contributor requests their own existing Submission
- **THEN** the detail, including stored source code, is returned

#### Scenario: Other owner and absent Submission are indistinguishable
- **WHEN** a User requests another owner's Submission or a nonexistent Submission
- **THEN** both requests return not found

#### Scenario: Staff reads another owner's detail
- **WHEN** a Moderator or Admin requests another owner's existing Submission
- **THEN** its source-bearing detail is returned

### Requirement: Current detail and personal testcase summaries

Source-bearing detail SHALL return recorded Submission/problem/owner identity, language, source code, current Attempt identity, status, optional runtime/memory and diagnostics, and creation/update times, without testcase contents. Its Submission state and testcase counts SHALL describe the same selected current Attempt. Personal history and this detail SHALL count Accepted results as passed and all stored results for the selected Attempt as total, excluding older Attempts. Without results, these counts SHALL be null for nonterminal status and zero for terminal status; blank legacy Attempt identity SHALL be returned as null in detail.

#### Scenario: Old results do not contribute
- **WHEN** a Rejudge has selected a new current Attempt and previous-Attempt results remain
- **THEN** current detail and newly read testcase summaries exclude those previous results

#### Scenario: Recorded results differ from reported dataset total
- **WHEN** the current Attempt has three stored testcase results, two Accepted, and a reported dataset total of ten
- **THEN** personal history/detail counts report two passed and three total

#### Scenario: No results or legacy identity
- **WHEN** the selected Attempt has no testcase results
- **THEN** Pending or Judging has null counts, a terminal Verdict has zero counts, and a blank legacy Attempt identity appears as null in detail

### Requirement: Staff detail and current Attempt provenance

The system SHALL restrict staff Submission detail to authenticated Moderators and Admins using a positive Submission identifier. It SHALL include source-bearing Submission data and available current-Attempt trigger, initiator, creation time, testcase version, reported total, and dataset checksum. It SHALL return current-Attempt testcase indexes, Verdicts, runtime, and memory in ascending index order, count Accepted results as passed and returned results as executed, and omit testcase inputs and all expected/actual outputs. Unavailable Attempt provenance SHALL remain null rather than being inferred from results.

#### Scenario: Staff inspects current Attempt
- **WHEN** a Moderator or Admin reads staff detail with current-Attempt provenance and unordered testcase results
- **THEN** the provenance and source are returned with testcase summaries sorted by index and with separate passed, executed, and reported-total counts

#### Scenario: Legacy Attempt has no provenance
- **WHEN** staff detail has no matching Attempt metadata but has stored testcase results
- **THEN** testcase summaries are returned while trigger, initiator, Attempt time, version, reported total, and checksum remain null

#### Scenario: Lower Role requests staff detail
- **WHEN** a User or legacy Contributor requests staff detail
- **THEN** access is forbidden

### Requirement: Rejudge eligibility

The system SHALL restrict Rejudge to authenticated Moderators and Admins and positive Submission identifiers. Rejudge SHALL require an existing Submission with a terminal Verdict and available testcase metadata with a positive testcase count and version. Pending and Judging Submissions SHALL be rejected as conflicts. Eligibility SHALL be checked again against concurrent state changes before committing a new Attempt.

#### Scenario: Active Submission is rejected
- **WHEN** staff requests Rejudge for a Pending or Judging Submission
- **THEN** a conflict is returned without creating a new Attempt or durable request

#### Scenario: Dataset is missing or invalid
- **WHEN** staff requests Rejudge for a terminal Submission but testcase metadata is missing or has a non-positive count or version
- **THEN** Rejudge reports that an active Testcase package is required without creating an Attempt

#### Scenario: Concurrent Rejudge
- **WHEN** two staff requests both initially observe the same terminal Submission and one creates a new Attempt that is still Pending when the other checks eligibility again
- **THEN** after one creates a Pending Attempt the other is rejected as a conflict

### Requirement: Atomic Rejudge state reset

A successful Rejudge SHALL select a new current Pending Attempt, clear current runtime, memory, compiler output, and error message, and save the Attempt and matching durable judging request atomically. It SHALL preserve the Submission's owner, coding problem, language, source code, and original creation time, and SHALL return the Submission identity, new Attempt identity, Pending status, Rejudge trigger, initiator, and enqueue time. Failure SHALL leave the previously committed state intact.

#### Scenario: Successful reset
- **WHEN** an eligible Rejudge succeeds
- **THEN** a new Pending Attempt becomes current with cleared current result fields and unchanged submitted source and ownership

#### Scenario: Rejudge persistence fails
- **WHEN** saving the reset, new Attempt, or durable request fails
- **THEN** none of those changes commit and the previous current Attempt and result fields remain intact

### Requirement: Terminal result validation

The system SHALL reject result application unless it identifies a positive Submission identifier, a nonblank Attempt identity, and an exact terminal Verdict of `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `OUTPUT_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `COMPILATION_ERROR`, or `SYSTEM_ERROR`. Validation SHALL occur before evaluating whether a result is stale or duplicate.

#### Scenario: Nonterminal or malformed result
- **WHEN** a result has an invalid identity, unknown status, Pending, or Judging
- **THEN** it is rejected without changing a Submission

#### Scenario: Invalid stale result is still rejected
- **WHEN** an old-Attempt result has an unknown status
- **THEN** it fails validation rather than being treated as a successful ignored result

### Requirement: Testcase result and checksum validation

Every supplied testcase result SHALL have a positive index and an exact Verdict of Accepted, Wrong Answer, Time Limit Exceeded, Memory Limit Exceeded, Output Limit Exceeded, Runtime Error, or System Error. An optional dataset checksum SHALL contain exactly 64 lowercase hexadecimal characters. Missing checksum and an empty testcase-result collection SHALL be accepted.

#### Scenario: Invalid testcase or checksum
- **WHEN** a result contains a non-positive testcase index, a testcase Compilation Error or unknown Verdict, or a checksum that is not 64 lowercase hexadecimal characters
- **THEN** result application is rejected before any durable change

#### Scenario: Result without testcase records or provenance
- **WHEN** an otherwise valid terminal result has no testcase results and no dataset checksum
- **THEN** those omissions do not prevent result application

### Requirement: Current Attempt result correlation

After validation, the system SHALL apply results only when the supplied Attempt identity exactly matches the Submission's current nonblank Attempt identity. A result for another Attempt or a legacy Submission without a current Attempt identity SHALL succeed as an ignored operation without changing Submission state, Attempt provenance, or testcase results. A nonexistent Submission SHALL return not found.

#### Scenario: Stale result after Rejudge
- **WHEN** a valid result references the previous Attempt after a new Attempt becomes current
- **THEN** the result is ignored successfully and all current data remains unchanged

#### Scenario: Legacy Submission without current identity
- **WHEN** a valid result targets a Submission whose current Attempt identity is blank
- **THEN** the result is ignored successfully without creating or replacing results

#### Scenario: Submission does not exist
- **WHEN** a valid result targets an absent Submission
- **THEN** application returns not found

### Requirement: First terminal result wins

The system SHALL ignore valid subsequent results once a Submission has a terminal Verdict, including when the incoming result matches the current Attempt. Duplicate or conflicting terminal results SHALL succeed without overwriting the first committed Verdict, metrics, diagnostics, testcase results, or Attempt provenance.

#### Scenario: Duplicate terminal result
- **WHEN** an already applied current-Attempt result is received again
- **THEN** it is ignored successfully with no additional result writes

#### Scenario: System Error arrives before Accepted
- **WHEN** System Error commits for the current Attempt and a valid Accepted result for that Attempt arrives later
- **THEN** the Submission remains System Error and the Accepted result does not replace its data

### Requirement: Atomic current result persistence

For a validated matching result on a nonterminal Submission, the system SHALL atomically save the terminal Verdict, supplied runtime and memory, Verdict-specific diagnostics, replacement testcase results for that Attempt, and available Attempt testcase version, reported count, and dataset checksum. Results belonging to other Attempts SHALL be retained. A persistence failure SHALL fail application without committing partial changes.

#### Scenario: Matching current result commits
- **WHEN** a valid matching terminal result is applied to a Pending or Judging Submission
- **THEN** the Submission and current Attempt reflect that result and its optional provenance, with testcase results replaced only for that Attempt

#### Scenario: Partial persistence failure
- **WHEN** saving the Submission, replacing its current testcase results, completing the Attempt, or committing the operation fails
- **THEN** application fails and no partial changes commit

### Requirement: Verdict-specific diagnostic retention

Compilation Error SHALL retain only nonblank compiler output, preserving its content. Runtime Error SHALL retain only a nonblank public error message. Time, Memory, and Output Limit Exceeded SHALL retain a public error message or use a limit-specific default. System Error SHALL use the fixed message "The judge could not complete this submission." Accepted and Wrong Answer SHALL clear both diagnostic fields. Public runtime and limit messages SHALL normalize recognized internal workspace prefixes, discard invalid UTF-8, remove ASCII control characters (`U+0000` through `U+001F` and `U+007F`) except newline, carriage return, and tab, and trim surrounding whitespace. If the resulting message exceeds 4096 bytes, the system SHALL keep a valid UTF-8 prefix within the first 4096 bytes, trim surrounding whitespace again, and append an ellipsis.

#### Scenario: Compiler output is retained
- **WHEN** a Compilation Error result supplies nonblank compiler output and an error message
- **THEN** only the original compiler output is retained

#### Scenario: Runtime or limit diagnostics
- **WHEN** Runtime Error or a resource-limit Verdict supplies a long message containing recognized internal workspace prefixes and ASCII control characters
- **THEN** its public error message is normalized, filtered, and truncated as specified, without retaining compiler output

#### Scenario: Default messages and cleared diagnostics
- **WHEN** a limit Verdict has no nonblank public error message, System Error has an arbitrary message, or the Verdict is Accepted or Wrong Answer
- **THEN** the limit-specific default, fixed System Error message, or cleared diagnostics are stored respectively
