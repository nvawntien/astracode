## ADDED Requirements

### Requirement: CM-02 Contributions workspace access and states
The website SHALL provide the Contributions workspace to authenticated Users, send unauthenticated visitors to sign-in, and direct Moderators and Admins to the Admin Console. A Published contribution SHALL be read-only in the Contributions workspace.

#### Scenario: Staff opens the Contributions workspace
- **WHEN** a Moderator or Admin opens the Contributions workspace
- **THEN** the website directs them to administrative problem management

#### Scenario: Guest opens the workspace
- **WHEN** a Guest opens the Contributions workspace
- **THEN** the website directs them to sign-in with a return destination

#### Scenario: Base-role User opens the workspace
- **WHEN** an authenticated User with a verified email opens the Contributions workspace
- **THEN** the website opens the Contributions workspace and offers draft creation

#### Scenario: Author opens a Published contribution
- **WHEN** a User opens their Published contribution
- **THEN** the website shows a read-only Published state with navigation back to their contributions or to the problem
- **AND** it does not offer the draft editor or testcase mutation controls

### Requirement: CM-04 Contributions workspace navigation
The Contributions workspace SHALL label returned hidden contributions as Draft and link to the draft editor. It SHALL label returned Published contributions as Published and link to their contribution detail and public problem.

#### Scenario: Workspace displays both contribution states
- **WHEN** the workspace receives a hidden and a Published contribution
- **THEN** the hidden item has an Edit draft action and the Published item has Open and View problem actions

## MODIFIED Requirements

### Requirement: CM-01 Authoring and moderation roles
The system SHALL permit authenticated Users, Moderators, and Admins to create coding problems and perform authoring mutations subject to ownership and visibility checks. It SHALL reserve publication and hiding for Moderators and Admins.

#### Scenario: Base-role user attempts authoring
- **WHEN** an authenticated User creates a valid coding problem or edits their own hidden draft
- **THEN** the system accepts the operation

#### Scenario: Contributor attempts a moderation action
- **WHEN** a former Contributor signs in as a User and attempts to publish or hide a coding problem, including their own
- **THEN** the system denies the operation

#### Scenario: Missing authenticated identity
- **WHEN** an authoring mutation, publication, or hiding is requested without an authenticated identity
- **THEN** the system rejects it before performing the operation

### Requirement: CM-03 Hidden draft creation and ownership
The system SHALL create each new coding problem as a hidden Draft owned by the authenticated creator, including when the creator is a Moderator or Admin. Creation SHALL NOT allow the caller to choose another author or publish the problem.

#### Scenario: Contributor creates a problem
- **WHEN** a former Contributor signs in as a User and successfully creates a coding problem
- **THEN** the new problem is hidden and owned by that User

#### Scenario: Staff creates a problem
- **WHEN** a Moderator or Admin successfully creates a coding problem
- **THEN** the new problem is also hidden and owned by the authenticated creator

### Requirement: CM-05 Ownership and draft mutation
The system SHALL permit a User to edit or delete only their own hidden problem. Moderators and Admins SHALL be allowed to edit or delete any undeleted problem regardless of author and visibility.

#### Scenario: Contributor mutates another author's draft
- **WHEN** a former Contributor signs in as a User and attempts to edit or delete another author's hidden problem
- **THEN** the system denies the operation

#### Scenario: Contributor edits a Published problem
- **WHEN** a former Contributor signs in as a User and attempts to edit or delete their own Published problem
- **THEN** the system denies the operation

#### Scenario: Staff edits another author's Published problem
- **WHEN** a Moderator or Admin supplies a valid edit for another author's Published problem
- **THEN** the system accepts the edit without requiring the problem to be hidden first

### Requirement: CM-11 Problem deletion
An authorized problem deletion SHALL mark the problem deleted. The operation SHALL leave its testcase package storage and metadata untouched.

#### Scenario: Delete an owned Draft
- **WHEN** a User successfully deletes their hidden problem
- **THEN** a subsequent edit of that problem reports it missing

#### Scenario: Staff deletes a Published problem with a package
- **WHEN** a Moderator or Admin successfully deletes another author's Published problem with a testcase package
- **THEN** the problem is marked deleted without removing the stored package or its metadata

### Requirement: CM-12 Admin Console row actions
The Admin Console SHALL restrict access to problem management to Moderators and Admins. It SHALL give staff access to editing and deletion from each returned problem row, offer publication for a hidden problem, and offer hiding for a Published problem.

#### Scenario: Lower role opens administrative problem management
- **WHEN** a signed-in User opens administrative problem management
- **THEN** the console denies access to the management page

#### Scenario: Console displays both visibility states
- **WHEN** the console receives a hidden and a Published problem
- **THEN** both rows provide Open and Delete actions, the hidden row provides Publish, and the Published row provides Hide

### Requirement: CM-14 Hiding and author editing
The system SHALL let a Moderator or Admin hide an undeleted problem regardless of author or current visibility. Hiding a Published contribution SHALL make it eligible for its author's hidden-draft editing and testcase mutation permissions again.

#### Scenario: Hide a Published contribution
- **WHEN** a Moderator hides a Published problem owned by a User
- **THEN** it becomes Hidden and that User can edit it and manage its testcase package again

#### Scenario: Hide an already hidden problem
- **WHEN** an Admin hides a problem that is already hidden
- **THEN** the operation succeeds and the problem remains hidden

### Requirement: CM-15 Testcase package permissions
The system SHALL allow a User to read testcase metadata for their own hidden or Published problem and to upload, replace, or delete a package only while their own problem is hidden. Moderators and Admins SHALL have those package-management permissions for any undeleted problem, including Published problems.

#### Scenario: Contributor mutates a Published package
- **WHEN** a former Contributor signs in as a User and attempts to upload, replace, or delete a testcase package for their Published problem
- **THEN** the system denies the mutation even though the author can read its metadata

#### Scenario: Other author's package
- **WHEN** a User requests testcase metadata or a package mutation for another author's problem
- **THEN** the system denies access

#### Scenario: Staff replaces a Published package
- **WHEN** a Moderator or Admin supplies a valid replacement package for another author's Published problem
- **THEN** the system permits the replacement

### Requirement: CM-24 Management controls and mutation feedback
The website SHALL ask for confirmation before staff deletes a problem or an authorized user deletes a testcase package through the package manager. It SHALL show mutation failures and prevent duplicate in-flight requests within each problem form, administrative list, and package manager. On success, it SHALL report the mutation and refresh the affected listing or detail, or open the new problem's detail after creation.

#### Scenario: Delete confirmation
- **WHEN** a staff user chooses problem deletion or an authorized user chooses package deletion
- **THEN** the website asks for confirmation before performing that deletion

#### Scenario: Package or visibility mutation succeeds
- **WHEN** a package or administrative visibility action and its required follow-up reads succeed
- **THEN** the website reports success and reloads the affected problem detail or administrative list

#### Scenario: A problem is created
- **WHEN** the Contributions workspace or Admin Console successfully creates a problem
- **THEN** the website reports success and opens the new problem's detail in the same workspace or console

#### Scenario: Management mutation fails
- **WHEN** a management request fails
- **THEN** the website shows an error and permits retry after the request finishes

## REMOVED Requirements

### Requirement: CM-02 Contributor Workspace access and states
**Reason**: The Contributions workspace is open to authenticated Users.
**Migration**: Existing workspace links continue to open the Contributions workspace.

### Requirement: CM-04 Contributor Workspace navigation
**Reason**: Workspace navigation is specified under the Contributions workspace requirements.
**Migration**: Use the same draft and Published problem actions from the Contributions workspace.
