# Spec Delta

## Purpose

Describe the current coding problem catalog: discovery, public statements and limits, read visibility, and the tag taxonomy available to learners and staff.

## ADDED Requirements

### Requirement: Public problem visibility

The catalog SHALL allow Guests and signed-in users to list and read Published coding problems without an entitlement check. Hidden and deleted problems SHALL be excluded from public reads, including public reads made by their author or staff.

#### Scenario: Guest reads a Published problem
- **WHEN** a Guest requests the public catalog or the statement of an existing Published problem
- **THEN** the problem is available without signing in or presenting Premium entitlement

#### Scenario: Hidden or deleted problem is requested publicly
- **WHEN** any caller requests a Hidden, deleted, or nonexistent problem through public discovery
- **THEN** it is absent from listing results and an individual read reports problem not found

### Requirement: Public lookup by slug

The catalog SHALL identify a public problem by its slug after trimming surrounding whitespace, preserving letter case for exact matching. A whitespace-only slug SHALL be invalid.

#### Scenario: Surrounding whitespace is removed
- **WHEN** the supplied slug is a stored Published problem's slug with surrounding whitespace
- **THEN** the catalog returns that problem

#### Scenario: Slug does not exactly match
- **WHEN** the supplied nonblank slug has no exact match, including a differently cased spelling
- **THEN** the catalog reports problem not found

#### Scenario: Slug contains only whitespace
- **WHEN** an individual public read supplies a whitespace-only slug
- **THEN** the catalog rejects the slug as invalid

### Requirement: Catalog pagination inputs

Public, own, and staff catalog requests SHALL default to page 1 and 20 items per page when those values are omitted or empty. Supplied nonempty page and page-size values SHALL be integers, with page at least 1 and page size from 1 through 100; other supplied values SHALL be rejected.

#### Scenario: Default and bounded pages
- **WHEN** a caller omits pagination or requests page 2 with a page size of 100
- **THEN** the catalog uses page 1 with size 20 for the omitted case, or skips the first 100 matching problems and returns at most the next 100 for the supplied case

#### Scenario: Invalid pagination
- **WHEN** a caller supplies zero, a negative value, a noninteger, or a page size above 100
- **THEN** the catalog rejects the pagination input

### Requirement: Catalog ordering and totals

Catalog results SHALL be ordered by creation time from newest to oldest and include the requested page, page size, and total number matching the same visibility and filters before pagination. A page with no matching items SHALL contain an empty collection.

#### Scenario: Results span pages
- **WHEN** 25 problems match a catalog request with default pagination
- **THEN** the first page contains the newest 20 matching problems and reports a total of 25

#### Scenario: Page exceeds the matching results
- **WHEN** a caller requests a page beyond all matching problems
- **THEN** the item collection is empty and the matching total is still reported

### Requirement: Difficulty filtering

Catalog requests SHALL accept an omitted or empty difficulty filter, or exactly one of `easy`, `medium`, and `hard`. A supplied nonempty value outside those exact spellings SHALL be rejected. An accepted difficulty filter SHALL match problems of that difficulty only.

#### Scenario: Filter by difficulty
- **WHEN** a caller requests difficulty `medium`
- **THEN** only visible problems whose stored difficulty is `medium` match

#### Scenario: Public spelling is validated before normalization
- **WHEN** a caller supplies `Easy`, ` easy `, or an unknown difficulty
- **THEN** the catalog rejects that request

### Requirement: Literal title and slug search

Catalog search SHALL trim surrounding whitespace and match a case-insensitive substring of a problem's title or slug. Percent signs, underscores, and backslashes SHALL be treated as literal search characters. Empty search after trimming SHALL impose no search restriction.

#### Scenario: Case-insensitive substring
- **WHEN** a caller searches for ` SUM `
- **THEN** visible problems with `sum` in their title or slug match regardless of letter case

#### Scenario: Search does not interpret wildcards or statement text
- **WHEN** a caller searches for a percent sign, underscore, or backslash, or text occurring only in a statement
- **THEN** only literal title or slug matches qualify and a statement-only occurrence does not qualify

### Requirement: Single-tag filtering

The public catalog SHALL filter by one tag slug after trimming whitespace and lowercasing it. A match SHALL require an attached, active, nondeleted tag with that exact slug. An unknown or inactive slug SHALL yield no matches; a blank slug SHALL impose no tag restriction.

#### Scenario: Normalized tag slug matches
- **WHEN** a caller filters by ` GRAPH ` and an eligible problem is attached to the active tag with slug `graph`
- **THEN** that problem matches the tag restriction

#### Scenario: Tag is unavailable or multiple slugs are supplied as one value
- **WHEN** a caller supplies an unknown, inactive, deleted, or comma-separated tag slug with no exact active match
- **THEN** no problems match that tag restriction

### Requirement: Combined catalog filters

The catalog SHALL apply all supplied difficulty, search, and tag restrictions together within the caller's eligible problem set. Its matching total SHALL use those same restrictions.

#### Scenario: All restrictions must match
- **WHEN** a caller requests `hard` difficulty, searches for `path`, and filters by an active `graph` tag
- **THEN** each result satisfies all three restrictions and the total counts only that intersection

### Requirement: Public problem identity and metadata

Each public catalog item and individual public problem read SHALL provide the problem's numeric identity, slug, title, difficulty, and creation time. Listing SHALL return the same problem content representation as an individual public read.

#### Scenario: Listing includes problem content
- **WHEN** an existing Published problem appears in a catalog page and is then read individually
- **THEN** both results include its identity and metadata together with its statement, tags, and configured limits

### Requirement: Statement structure and public examples

Public problem reads SHALL return stored description, input-format prose, output-format prose, public examples, constraints, and hints without splitting or redacting the statement during the read. Examples SHALL retain their order and provide input, expected output, and any explanation; constraints and hints SHALL retain their stored order.

#### Scenario: Structured statement is returned unchanged
- **WHEN** a Published problem has separate prose sections, multiple public examples, constraints, and hints
- **THEN** listing and individual reads return those sections and sequences as stored, including the hints

#### Scenario: Legacy public example output is read
- **WHEN** a stored public example has an empty current expected output and a legacy output value
- **THEN** that legacy value is presented as its expected output

### Requirement: Configured resource limits

Public problem reads SHALL return the problem's configured numeric time and memory limits unchanged. Reading a problem SHALL neither replace its limits with defaults nor convert their numeric values.

#### Scenario: Stored limits are preserved
- **WHEN** a Published problem stores a time limit of 2.5 and a memory limit of 128
- **THEN** its listing and individual read report 2.5 and 128 respectively

### Requirement: Public and private problem data separation

Public catalog and statement results SHALL omit author identity, Hidden-state information, private Testcase package data, and package access information. Public examples SHALL remain visible as part of the statement.

#### Scenario: Public read does not expose private package data
- **WHEN** a Guest reads a Published problem that has an author, public examples, and a private Testcase package
- **THEN** the public examples are returned while author identity, Hidden-state information, private inputs and expected outputs, and package locations or download access are absent

### Requirement: Attached tag representation

Problem reads SHALL return attached nondeleted tags ordered by name, with each tag's identity, name, slug, and description when present. Attached tags SHALL remain represented even when inactive; the public problem representation SHALL not reveal their activation state.

#### Scenario: An attached inactive tag remains visible
- **WHEN** a Published problem has stored associations to active and inactive nondeleted tags
- **THEN** both kinds appear in its returned tag collection in name order, without activation-state information

### Requirement: Public active-tag directory

The catalog SHALL allow Guests to read the complete active, nondeleted tag directory, ordered by name and without pagination. Each entry SHALL contain identity, name, slug, and description when present; activation and audit information SHALL be omitted.

#### Scenario: Active directory includes unused tags
- **WHEN** the taxonomy contains active and inactive tags, including an active tag attached to no problems
- **THEN** the public directory includes all active nondeleted tags, including the unused tag, and excludes inactive or deleted tags

### Requirement: Own-catalog visibility

Own-catalog reads SHALL require an authenticated Contributor, Moderator, or Admin and restrict results to that caller's authored, nondeleted problems, including Published and Hidden problems. Returned items SHALL include author identity and indicate Hidden state when true. Own-catalog tag filtering SHALL also accept inactive nondeleted tags.

#### Scenario: Contributor reads their own catalog
- **WHEN** a Contributor requests their catalog
- **THEN** it contains only their own eligible problems, whether Published or Hidden, with no other author's problems

#### Scenario: Own catalog filters by an inactive tag
- **WHEN** an eligible caller filters their catalog by an attached inactive nondeleted tag
- **THEN** their matching problems remain eligible

#### Scenario: Base User requests an own catalog
- **WHEN** a signed-in User without a higher role requests an own-catalog read
- **THEN** access is forbidden

### Requirement: Staff-catalog visibility

The staff catalog SHALL require an authenticated Moderator or Admin and include nondeleted problems across authors, including Published and Hidden problems. Returned items SHALL include author identity and indicate Hidden state when true. Staff tag filtering SHALL accept inactive nondeleted tags.

#### Scenario: Staff reads across authors and visibility states
- **WHEN** a Moderator or Admin requests the staff catalog, optionally filtering by an inactive tag
- **THEN** matching Published and Hidden nondeleted problems from any author are eligible

#### Scenario: Lower role requests staff listing
- **WHEN** a User or Contributor requests the staff catalog
- **THEN** access is forbidden

### Requirement: Privileged individual problem visibility

Privileged individual reads SHALL require an authenticated Contributor, Moderator, or Admin. Contributors SHALL be restricted to their own problems; Moderator and Admin SHALL be allowed to read across authors. Both Published and Hidden nondeleted problems SHALL be eligible, with author, visibility, creation, and update information returned.

#### Scenario: Owner or staff reads a Hidden problem
- **WHEN** a Contributor reads their own Hidden problem, or a Moderator or Admin reads any author's Hidden problem
- **THEN** the read succeeds and includes the problem's author and visibility information

#### Scenario: Contributor reads another author's problem
- **WHEN** a Contributor requests another author's problem through privileged individual reads
- **THEN** access is forbidden even if the problem is Published

#### Scenario: Deleted problem is read by staff
- **WHEN** an Admin requests a deleted or nonexistent problem
- **THEN** the read reports problem not found

### Requirement: Internal problem metadata visibility

Internal problem metadata reads SHALL require a positive problem identity and a nonblank actor identity with a recognized role. Given the problem state read, any recognized role SHALL access Published problems; Hidden problems SHALL be accessible only to their Contributor author, Moderator, or Admin. Unavailable or disallowed problems SHALL be reported as not found.

#### Scenario: Hidden metadata respects actor visibility
- **WHEN** a Hidden problem's metadata is requested by its Contributor author or by staff
- **THEN** its identity, title, slug, and configured limits are returned without statement or Testcase package content

#### Scenario: Base User cannot access Hidden metadata
- **WHEN** a User or another Contributor requests metadata for a problem whose read state is Hidden
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
- **WHEN** a User or Contributor attempts to read the staff directory or change the taxonomy
- **THEN** access is forbidden

### Requirement: Default tag creation and slug uniqueness

Creating a tag without an explicit activation choice SHALL create an active tag. Its normalized slug SHALL be unique among existing tag slugs; a collision SHALL be reported as a conflict rather than automatically renaming or replacing the existing tag.

#### Scenario: New tag defaults to active
- **WHEN** staff creates a valid tag with an unused normalized slug and no activation choice
- **THEN** the tag is active and its assigned identity and normalized values are returned

#### Scenario: Normalized slug already exists
- **WHEN** staff creates a tag whose normalized slug is already in use
- **THEN** creation reports a conflict and does not replace the existing tag

### Requirement: Selective tag updates

Tag updates SHALL change only supplied name, slug, description, or activation choices and return the reread tag. Renaming alone SHALL preserve the slug. Staff SHALL be allowed to reactivate an inactive tag; changing a slug to one already in use SHALL report conflict. Updating a nonexistent tag SHALL report tag not found.

#### Scenario: Rename and clear description
- **WHEN** staff supplies a new name and an empty description for an existing tag, omitting slug and activation choices
- **THEN** the name changes, the description is cleared, and the slug and activation state are preserved

#### Scenario: Reactivate an inactive tag
- **WHEN** staff sets an inactive existing tag to active
- **THEN** the tag becomes active and can appear in the public tag directory

#### Scenario: Update an unavailable or conflicting tag
- **WHEN** staff updates a nonexistent tag or requests a slug already used by another tag
- **THEN** the result is tag not found or a conflict respectively

### Requirement: Tag text validation and normalization

Tag changes SHALL reject supplied names or nonempty slugs longer than 64 characters, descriptions longer than 255 characters, and names blank after trimming. Names and descriptions SHALL be trimmed. Slugs SHALL be lowercased, replace runs outside ASCII letters and digits with a hyphen, and trim edge hyphens, falling back to `tag` if empty. Creation SHALL derive an omitted slug from the name.

#### Scenario: Slug derives from a trimmed name
- **WHEN** staff creates a tag named ` Graph Theory ` without a slug
- **THEN** its name is `Graph Theory` and its slug is `graph-theory`

#### Scenario: Slug normalization has no usable characters
- **WHEN** a supplied slug consists only of punctuation
- **THEN** its normalized slug is `tag`, subject to the usual uniqueness check

#### Scenario: Raw text exceeds bounds or name is blank
- **WHEN** staff supplies a 65-character name or slug, a 256-character description, or a whitespace-only name
- **THEN** the change is rejected

### Requirement: Protected tag deactivation

Removing a tag SHALL deactivate it rather than remove its identity or problem associations. Deactivating an active tag, whether by removal or update, SHALL be rejected if it is attached to any Published nondeleted problem. Repeating removal for an inactive tag SHALL succeed; removing a nonexistent tag SHALL report tag not found.

#### Scenario: Published problem protects an active tag
- **WHEN** staff attempts to deactivate an active tag used by a Published nondeleted problem
- **THEN** the operation reports a conflict and leaves the tag active

#### Scenario: Deactivation retains Hidden-problem associations
- **WHEN** staff removes an active tag attached only to Hidden or deleted problems
- **THEN** the tag becomes inactive and its identity and associations are retained

#### Scenario: Removal is repeated or tag does not exist
- **WHEN** staff removes an already inactive tag or a nonexistent tag
- **THEN** the inactive-tag operation succeeds and the nonexistent-tag operation reports tag not found

### Requirement: Curated taxonomy seeding preserves existing tags

When explicitly run, curated taxonomy seeding SHALL create missing definitions as active tags and preserve existing tags matched by slug, including existing names, descriptions, and activation choices. It SHALL report created, existing, and failed counts; individual failures SHALL not prevent later definitions from being attempted or roll back earlier successes.

#### Scenario: Existing definition has different text or activation
- **WHEN** seeding encounters an existing slug with a different name, description, or activation state
- **THEN** that existing tag is preserved and counted as already existing

#### Scenario: Seeding is repeated
- **WHEN** seeding is run again with definitions whose slugs all exist
- **THEN** no duplicate tags are created and those definitions are counted as already existing

#### Scenario: One definition fails
- **WHEN** a definition cannot be inspected or created during seeding
- **THEN** it is counted as failed, later definitions are attempted, earlier successful creations remain, and the operation reports failure overall
