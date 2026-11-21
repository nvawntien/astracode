## MODIFIED Requirements

### Requirement: Own-catalog visibility

Own-catalog reads SHALL require an authenticated User, Moderator, or Admin and restrict results to that caller's authored, nondeleted problems, including Published and Hidden problems. Returned items SHALL include author identity and indicate Hidden state when true. Own-catalog tag filtering SHALL also accept inactive nondeleted tags.

#### Scenario: Contributor reads their own catalog
- **WHEN** a former Contributor signs in as a User and requests their catalog
- **THEN** it contains only their own nondeleted problems, whether Published or Hidden, with no other author's problems

#### Scenario: Own catalog filters by an inactive tag
- **WHEN** an eligible caller filters their catalog by an attached inactive nondeleted tag
- **THEN** their matching problems remain eligible

#### Scenario: Guest requests an own catalog
- **WHEN** a caller requests an own-catalog read without an authenticated identity
- **THEN** access is denied

#### Scenario: Base User requests an own catalog
- **WHEN** an authenticated User requests their catalog
- **THEN** the system returns the User's own problems or an empty catalog if they have authored none

### Requirement: Staff-catalog visibility

The staff catalog SHALL require an authenticated Moderator or Admin and include nondeleted problems across authors, including Published and Hidden problems. Returned items SHALL include author identity and indicate Hidden state when true. Staff tag filtering SHALL accept inactive nondeleted tags.

#### Scenario: Staff reads across authors and visibility states
- **WHEN** a Moderator or Admin requests the staff catalog, optionally filtering by an inactive tag
- **THEN** matching Published and Hidden nondeleted problems from any author are eligible

#### Scenario: Lower role requests staff listing
- **WHEN** a User requests the staff catalog
- **THEN** access is forbidden

### Requirement: Privileged individual problem visibility

Privileged individual reads SHALL require an authenticated User, Moderator, or Admin. Users SHALL be restricted to their own problems; Moderator and Admin SHALL be allowed to read across authors. Both Published and Hidden nondeleted problems SHALL be eligible, with author, visibility, creation, and update information returned.

#### Scenario: Owner or staff reads a Hidden problem
- **WHEN** a User reads their own Hidden problem, or a Moderator or Admin reads any author's Hidden problem
- **THEN** the read succeeds and includes the problem's author and visibility information

#### Scenario: Contributor reads another author's problem
- **WHEN** a former Contributor signs in as a User and requests another author's problem through privileged individual reads
- **THEN** access is forbidden even if the problem is Published

#### Scenario: Deleted problem is read by staff
- **WHEN** an Admin requests a deleted or nonexistent problem
- **THEN** the read reports problem not found

### Requirement: Internal problem metadata visibility

Internal problem metadata reads SHALL require a positive problem identity and a nonblank actor identity with a recognized role. Given the problem state read, any recognized role SHALL access Published problems; Hidden problems SHALL be accessible only to their authenticated author, Moderator, or Admin. Unavailable or disallowed problems SHALL be reported as not found.

#### Scenario: Hidden metadata respects actor visibility
- **WHEN** a Hidden problem's metadata is requested by its authenticated author or by staff
- **THEN** its identity, title, slug, and configured limits are returned without statement or Testcase package content

#### Scenario: Base User cannot access Hidden metadata
- **WHEN** a User requests metadata for another author's Hidden problem
- **THEN** the result is problem not found

#### Scenario: Internal caller omits or supplies invalid identity information
- **WHEN** the problem identity is not positive, actor identity or role is missing, or the role is unrecognized
- **THEN** the request is rejected as invalid input, unauthenticated, or forbidden respectively

### Requirement: Taxonomy administration access

Tag creation, updates, deactivation, and the complete staff tag directory SHALL require an authenticated Moderator or Admin. The staff directory SHALL include active and inactive nondeleted tags in name order, with activation state and creation and update information.

#### Scenario: Staff reviews the complete taxonomy
- **WHEN** a Moderator or Admin reads the staff tag directory
- **THEN** active and inactive nondeleted tags are returned together with their activation and audit information

#### Scenario: Lower role attempts taxonomy administration
- **WHEN** a User attempts to read the staff directory or change the taxonomy
- **THEN** access is forbidden
