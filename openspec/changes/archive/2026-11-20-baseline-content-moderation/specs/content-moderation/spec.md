# Content Moderation Baseline

## Purpose

Describe the current behavior of coding-problem authoring, Contributor ownership, testcase package management, and Moderator/Admin content actions. Catalog read behavior belongs to `problem-catalog`.

## ADDED Requirements

### Requirement: CM-01 Authoring and moderation roles
The system SHALL permit authenticated Contributors, Moderators, and Admins to create coding problems and submit authoring mutations subject to ownership and visibility checks. It SHALL reserve publication and hiding for Moderators and Admins.

#### Scenario: Base-role user attempts authoring
- **WHEN** a User without Contributor, Moderator, or Admin role attempts to create a coding problem
- **THEN** the system denies the operation

#### Scenario: Contributor attempts a moderation action
- **WHEN** a Contributor attempts to publish or hide a coding problem
- **THEN** the system denies the operation

#### Scenario: Missing authenticated identity
- **WHEN** an authoring mutation, publication, or hiding is requested without an authenticated identity
- **THEN** the system rejects it before performing the operation

### Requirement: CM-02 Contributor Workspace access and states
The website SHALL provide the Contributor Workspace to the Contributor role, send unauthenticated visitors to sign-in, direct Moderators/Admins to the Admin Console, and deny workspace access to a base-role User. A Published contribution SHALL be read-only in the Contributor Workspace.

#### Scenario: Staff opens the Contributor Workspace
- **WHEN** a Moderator or Admin opens the Contributor Workspace
- **THEN** the website directs them to administrative problem management

#### Scenario: Guest opens the workspace
- **WHEN** a Guest opens the Contributor Workspace
- **THEN** the website directs them to sign-in with a return destination

#### Scenario: Base-role User opens the workspace
- **WHEN** a signed-in base-role User opens the Contributor Workspace
- **THEN** the website shows a Contributor-access-required state

#### Scenario: Author opens a Published contribution
- **WHEN** a Contributor opens their Published contribution
- **THEN** the website shows a read-only Published state with navigation back to their contributions or to the problem
- **AND** it does not offer the draft editor or testcase mutation controls

### Requirement: CM-03 Hidden draft creation and ownership
The system SHALL create each new coding problem as a hidden Draft owned by the authenticated creator, including when the creator is a Moderator or Admin. Creation SHALL NOT allow the caller to choose another author or publish the problem.

#### Scenario: Contributor creates a problem
- **WHEN** a Contributor successfully creates a coding problem
- **THEN** the new problem is hidden and owned by that Contributor

#### Scenario: Staff creates a problem
- **WHEN** a Moderator or Admin successfully creates a coding problem
- **THEN** the new problem is also hidden and owned by the authenticated creator

### Requirement: CM-04 Contributor Workspace navigation
The Contributor Workspace SHALL label returned hidden contributions as Draft and link to the draft editor. It SHALL label returned Published contributions as Published and link to their contribution detail and public problem.

#### Scenario: Workspace displays both contribution states
- **WHEN** the workspace receives a hidden and a Published contribution
- **THEN** the hidden item has an Edit draft action and the Published item has Open and View problem actions

### Requirement: CM-05 Ownership and draft mutation
The system SHALL permit a Contributor to edit or delete only their own hidden problem. Moderators and Admins SHALL be allowed to edit or delete any undeleted problem regardless of author and visibility.

#### Scenario: Contributor mutates another author's draft
- **WHEN** a Contributor attempts to edit or delete another author's hidden problem
- **THEN** the system denies the operation

#### Scenario: Contributor edits a Published problem
- **WHEN** a Contributor attempts to edit or delete their own Published problem
- **THEN** the system denies the operation

#### Scenario: Staff edits another author's Published problem
- **WHEN** a Moderator or Admin supplies a valid edit for another author's Published problem
- **THEN** the system accepts the edit without requiring the problem to be hidden first

### Requirement: CM-06 Structured problem authoring
The system SHALL keep description, input format, output format, examples, constraints, and hints as separate authoring content. Creation SHALL require a title and description of at least three characters before trimming, nonblank trimmed prose fields, a valid difficulty, and at least one example containing input and expected output. A legacy example output SHALL supply the expected output when the current value is empty.

#### Scenario: Incomplete creation content
- **WHEN** creation omits an input format, output format, or example, or provides an example with empty input or with neither current nor legacy expected output
- **THEN** the system rejects creation

#### Scenario: Legacy example output supplies the expected output
- **WHEN** an otherwise valid creation request supplies an example with empty current expected output and a nonempty legacy output
- **THEN** the system accepts and stores the legacy value as the expected output

#### Scenario: Creation normalizes prose and difficulty
- **WHEN** otherwise valid creation supplies surrounding whitespace in prose or a differently cased difficulty
- **THEN** the system trims title, description, input format, and output format and normalizes difficulty to easy, medium, or hard
- **AND** retains example input and expected-output text without trimming

#### Scenario: Structured website editing
- **WHEN** an author uses the structured editor
- **THEN** they can add or remove examples, constraints, and hints as separate entries
- **AND** saving is blocked for whitespace-only example input/output or incomplete constraint/hint entries
- **AND** submitted prose and constraint/hint entries are trimmed while example input/output text is preserved

### Requirement: CM-07 Creation and edit execution limits
The system SHALL default missing or nonpositive creation limits to a numeric time limit of 1000 and memory limit of 256, without imposing the edit bounds on positive creation values. Supplied edit limits SHALL require time greater than zero and at most 30, and memory from 16 through 1024. The website SHALL initialize new forms with time 1 and memory 256 and edit forms with stored limits. Both forms SHALL use controls bounded from 1 through 30 for time and 16 through 1024 for memory.

#### Scenario: Creation uses defaults
- **WHEN** valid creation omits limits or supplies nonpositive values
- **THEN** the saved time limit is 1000 and memory limit is 256

#### Scenario: Positive creation limit exceeds edit bounds
- **WHEN** otherwise valid creation directly supplies a positive time limit above 30 or memory above 1024
- **THEN** creation does not reject the values for exceeding those bounds

#### Scenario: Edit violates bounds
- **WHEN** an edit supplies nonpositive time, time above 30, memory below 16, or memory above 1024
- **THEN** the system rejects the edit

### Requirement: CM-08 Problem slug assignment and changes
The system SHALL derive a new problem's slug by lowercasing its title, replacing runs outside lowercase ASCII letters and digits with hyphens, and trimming boundary hyphens, using a generic problem slug if empty. It SHALL try increasing numeric suffixes starting at two for occupied undeleted candidates. An explicitly edited slug SHALL use the same normalization and report a conflict with another problem's slug.

#### Scenario: Title-derived slug is occupied
- **WHEN** creation finds the base slug occupied by an undeleted problem
- **THEN** it tries the base slug with suffix two and subsequent increasing suffixes until an undeleted candidate is unoccupied

#### Scenario: Conflicting edited slug
- **WHEN** an author supplies an edited slug whose normalized value belongs to another undeleted problem
- **THEN** the system reports a conflict instead of choosing a suffix

### Requirement: CM-09 Partial updates preserve omitted content
For a sequential edit, the system SHALL apply only supplied authoring changes and preserve omitted values, including the existing slug when only the title changes. Content edits SHALL preserve the author and existing visibility.

#### Scenario: Title-only edit
- **WHEN** an authorized author supplies only a valid replacement title
- **THEN** the system updates the title and retains the slug, other content, author, and visibility

#### Scenario: Clear optional lists
- **WHEN** an authorized edit explicitly supplies an empty constraints or hints list
- **THEN** the supplied list is cleared rather than treated as omitted

#### Scenario: Invalid replacement content
- **WHEN** an edit supplies an empty examples list, an example with empty input or with neither current nor legacy expected output, blank required prose, or an invalid difficulty
- **THEN** the system rejects the edit

### Requirement: CM-10 Active tag assignment
The system SHALL accept at most twenty supplied positive tag identifiers for a coding problem, collapse duplicates, and reject missing or inactive tags. Omitted tags on an edit SHALL remain unchanged; an explicitly empty selection SHALL remove all attached tags.

#### Scenario: Invalid tag selection
- **WHEN** an author assigns a missing tag, an inactive tag, a nonpositive identifier, or more than twenty supplied identifiers
- **THEN** the system rejects the assignment

#### Scenario: Duplicate or empty selection
- **WHEN** an authorized author repeats a valid tag within an accepted selection
- **THEN** that tag is attached only once
- **AND** a subsequent explicit empty selection removes all attached tags

### Requirement: CM-11 Problem deletion
An authorized problem deletion SHALL mark the problem deleted. The operation SHALL leave its testcase package storage and metadata untouched.

#### Scenario: Delete an owned Draft
- **WHEN** a Contributor successfully deletes their hidden problem
- **THEN** a subsequent edit of that problem reports it missing

#### Scenario: Staff deletes a Published problem with a package
- **WHEN** a Moderator or Admin successfully deletes another author's Published problem with a testcase package
- **THEN** the problem is marked deleted without removing the stored package or its metadata

### Requirement: CM-12 Admin Console row actions
The Admin Console SHALL restrict access to problem management to Moderators and Admins. It SHALL give staff access to editing and deletion from each returned problem row, offer publication for a hidden problem, and offer hiding for a Published problem.

#### Scenario: Lower role opens administrative problem management
- **WHEN** a signed-in User or Contributor opens administrative problem management
- **THEN** the console denies access to the management page

#### Scenario: Console displays both visibility states
- **WHEN** the console receives a hidden and a Published problem
- **THEN** both rows provide Open and Delete actions, the hidden row provides Publish, and the Published row provides Hide

### Requirement: CM-13 Publication
The system SHALL let a Moderator or Admin publish an undeleted problem if none of its attached tags is inactive. Publication SHALL NOT require a testcase package, Reference solution, Automatic pre-check, or prior review decision.

#### Scenario: Publish without a testcase package
- **WHEN** a Moderator publishes a problem without inactive tags and without a testcase package
- **THEN** the system marks it Published

#### Scenario: Inactive attached tag
- **WHEN** publication is requested for a problem with an inactive attached tag
- **THEN** the system rejects publication and does not change visibility

#### Scenario: Publish an already Published problem
- **WHEN** an Admin publishes an already Published problem with no inactive attached tags
- **THEN** the operation succeeds and the problem remains Published

### Requirement: CM-14 Hiding and author editing
The system SHALL let a Moderator or Admin hide an undeleted problem regardless of author or current visibility. Hiding a Published contribution SHALL make it eligible for its Contributor author's hidden-draft editing and testcase mutation permissions again.

#### Scenario: Hide a Published contribution
- **WHEN** a Moderator hides a Published problem owned by a Contributor
- **THEN** it becomes Hidden and that Contributor can edit it and manage its testcase package again

#### Scenario: Hide an already hidden problem
- **WHEN** an Admin hides a problem that is already hidden
- **THEN** the operation succeeds and the problem remains hidden

### Requirement: CM-15 Testcase package permissions
The system SHALL allow a Contributor to read testcase metadata for their own hidden or Published problem and to upload, replace, or delete a package only while their own problem is hidden. Moderators and Admins SHALL have those package-management permissions for any undeleted problem, including Published problems.

#### Scenario: Contributor mutates a Published package
- **WHEN** a Contributor uploads, replaces, or deletes a testcase package for their Published problem
- **THEN** the system denies the mutation even though the author can read its metadata

#### Scenario: Other author's package
- **WHEN** a Contributor requests testcase metadata or a package mutation for another author's problem
- **THEN** the system denies access

#### Scenario: Staff replaces a Published package
- **WHEN** a Moderator or Admin supplies a valid replacement package for another author's Published problem
- **THEN** the system permits the replacement

### Requirement: CM-16 Testcase archive structure
The system SHALL require a nonempty ZIP with readable archive structure and root-level numbered input and output entries using lowercase input/output suffixes. Testcase numbers SHALL be positive and consecutive from one, with exactly one input and one expected output per number. Directories, nested paths, unrelated entries, duplicate numeric inputs/outputs, and unmatched pairs SHALL be rejected.

#### Scenario: Consecutive complete pairs
- **WHEN** an authorized upload contains complete root-level input/output pairs numbered consecutively from one
- **THEN** the archive passes structural validation and the test count equals the number of pairs

#### Scenario: Invalid structure
- **WHEN** the ZIP is empty, its archive structure cannot be read, it contains a directory or nested path, it uses an invalid entry name or nonpositive number, it duplicates a numeric input/output, it has an unmatched pair, or it skips a number
- **THEN** the system rejects the upload as an invalid testcase package

### Requirement: CM-17 Testcase archive bounds
The system SHALL reject an uploaded testcase ZIP larger than 50 MiB or containing more than 2000 entries. It SHALL check a running sum of the declared uncompressed sizes against a 100 MiB limit and reject the archive if the running sum exceeds that limit.

#### Scenario: Oversized uploaded archive
- **WHEN** the uploaded ZIP is larger than 50 MiB
- **THEN** the system rejects it before accepting a replacement package

#### Scenario: Excessive entry count or declared size
- **WHEN** an archive contains more than 2000 entries or contains otherwise valid entries whose declared sizes add up to 101 MiB
- **THEN** the system rejects the upload

### Requirement: CM-18 Sequential testcase replacement and versions
The system SHALL maintain one current testcase package per problem. A first successful upload SHALL have version one, and each successful sequential replacement SHALL increase the current version by one and replace its test count. Package storage or metadata-save failures SHALL be reported as errors.

#### Scenario: First upload and later replacement
- **WHEN** an authorized author uploads a valid first package and later successfully replaces it
- **THEN** the current metadata changes from version one to version two and describes the replacement package's test count

#### Scenario: Upload after package deletion
- **WHEN** a new valid package is uploaded after the previous package and metadata were successfully deleted
- **THEN** the new package starts again at version one

### Requirement: CM-19 Testcase metadata confidentiality and absence
Authoring testcase metadata SHALL contain package identifiers, test count, version, and timestamps, without private inputs, expected outputs, storage locations, or download access. Authoring problem detail SHALL indicate whether a package exists, and a separate metadata lookup for an absent package SHALL report it missing.

#### Scenario: Metadata for an existing package
- **WHEN** an authorized actor requests testcase metadata or authoring problem detail
- **THEN** any package information is metadata only and grants no access to testcase contents

#### Scenario: No package exists
- **WHEN** an authorized actor opens authoring detail for a problem without a testcase package
- **THEN** the problem detail succeeds and indicates no package
- **AND** a separate package-metadata lookup reports the package missing

### Requirement: CM-20 Testcase package deletion
The system SHALL request removal of the stored package before deleting its metadata. It SHALL report a missing package when its metadata is absent and report an error if storage removal or metadata deletion fails.

#### Scenario: Successful package deletion
- **WHEN** an authorized actor successfully deletes an existing testcase package
- **THEN** subsequent authoring detail indicates no package and package-metadata lookup reports it missing

#### Scenario: Storage removal fails
- **WHEN** removal of the stored package fails
- **THEN** the operation reports an error and does not proceed to delete its metadata

### Requirement: CM-24 Management controls and mutation feedback
The website SHALL ask for confirmation before staff deletes a problem or an authorized user deletes a testcase package through the package manager. It SHALL show mutation failures and prevent duplicate in-flight requests within each problem form, administrative list, and package manager. On success, it SHALL report the mutation and refresh the affected listing or detail, or open the new problem's detail after creation.

#### Scenario: Delete confirmation
- **WHEN** a staff user chooses problem deletion or an authorized user chooses package deletion
- **THEN** the website asks for confirmation before performing that deletion

#### Scenario: Package or visibility mutation succeeds
- **WHEN** a package or administrative visibility action and its required follow-up reads succeed
- **THEN** the website reports success and reloads the affected problem detail or administrative list

#### Scenario: A problem is created
- **WHEN** the Contributor Workspace or Admin Console successfully creates a problem
- **THEN** the website reports success and opens the new problem's detail in the same workspace or console

#### Scenario: Management mutation fails
- **WHEN** a management request fails
- **THEN** the website shows an error and permits retry after the request finishes
