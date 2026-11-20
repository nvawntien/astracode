# user-profile Specification

## Purpose
Define public user visibility and discovery, and how signed-in accounts read and maintain their own profile fields and avatar.

## Requirements

### Requirement: Public profile visibility

The system SHALL allow Guests and signed-in viewers to look up a public profile by username. Only an active, non-suspended account SHALL have a public profile available through this lookup.

#### Scenario: View a visible public profile
- **WHEN** a viewer requests the username of an active, non-suspended account
- **THEN** the system returns its public profile

#### Scenario: A public profile is unavailable
- **WHEN** the username is unknown or belongs to an unverified or suspended account
- **THEN** the system reports the profile as not found without returning profile data

### Requirement: Public profile fields

For a visible public profile, the system SHALL expose the username, full name, recorded rating, join date, and any available avatar URL, bio, country, school, company, GitHub link, website link and LinkedIn link. It SHALL omit private account fields such as email, account ID, role and credential information.

#### Scenario: Read public information
- **WHEN** a visible profile with an email and an avatar is requested
- **THEN** the response includes its public identity and avatar URL and omits the email and other private account fields

### Requirement: Public user search matching and visibility

The system SHALL allow Guests and signed-in viewers to search active, non-suspended accounts by case-insensitive substring of username or full name. It SHALL trim surrounding whitespace and treat pattern characters in the query as literal text. Search results SHALL expose only username, full name, recorded rating and the avatar URL when available.

#### Scenario: Search by name
- **WHEN** a viewer searches for part of a username or full name using a different letter case
- **THEN** matching visible accounts are eligible to appear with their public preview fields

#### Scenario: Search for literal wildcard characters
- **WHEN** a query includes a percent sign or underscore
- **THEN** those characters match themselves rather than expanding the search pattern

#### Scenario: Exclude hidden accounts and private fields
- **WHEN** a query matches visible accounts and also matches unverified or suspended accounts
- **THEN** only active, non-suspended matches are included in the results and pagination totals, and no email address or account ID is returned

### Requirement: Public user search bounds and pagination

Search SHALL default to page 1 with 10 items per page and SHALL accept positive page numbers and page sizes from 1 through 20. The system SHALL order matches by username with account ID as a tie breaker and return page, page size, total matches and total pages. After trimming, an empty query SHALL return an empty page with zero totals, and a query longer than 100 characters SHALL be rejected.

#### Scenario: Search without pagination options
- **WHEN** a viewer supplies a valid nonempty query without page options
- **THEN** the first page contains up to 10 ordered results and the totals describe the full set of visible matches

#### Scenario: Query is blank
- **WHEN** the pagination options are valid and the query is missing or contains only whitespace
- **THEN** the result contains no items and both totals are zero

#### Scenario: Query or pagination exceeds the limits
- **WHEN** the query exceeds 100 characters after trimming, the page is less than 1, or the page size is outside 1 through 20
- **THEN** the system rejects the search without returning matches

### Requirement: Own profile access and edits

The system SHALL use the signed-in account's identity to read and edit its own profile. Profile edits SHALL apply only to supplied editable fields and return the updated own profile. The editable fields SHALL be full name, bio, country, school, company, GitHub link, website link and LinkedIn link.

#### Scenario: Read the signed-in account's profile
- **WHEN** a signed-in account requests its own profile
- **THEN** it receives its profile and own account information, including its email

#### Scenario: Update only the supplied fields
- **WHEN** a signed-in account submits a valid update to its bio
- **THEN** the returned own profile includes the updated bio, and the edit does not write the omitted fields or change the account's username or email

#### Scenario: No signed-in account
- **WHEN** a Guest tries to read or edit an own profile
- **THEN** the system denies the request

### Requirement: Profile edit validation

The system SHALL trim surrounding whitespace from supplied fields. It SHALL cap full name and country at 100 characters each, school and company at 255 each, and bio and each link at 500. A nonempty link SHALL be an HTTP or HTTPS URL with a host. An empty supplied value SHALL be accepted for an editable field.

#### Scenario: Store a trimmed value
- **WHEN** a signed-in account provides a valid value with leading or trailing whitespace
- **THEN** the profile stores the value with that whitespace removed

#### Scenario: Clear an optional link
- **WHEN** a signed-in account explicitly supplies an empty website link
- **THEN** the field is updated to an empty value

#### Scenario: Reject an invalid edit
- **WHEN** any supplied field exceeds its limit or a nonempty link lacks a host or uses an unsupported scheme
- **THEN** the system rejects the edit without applying submitted field changes

### Requirement: Avatar upload eligibility and validation

The system SHALL accept avatar uploads only for the signed-in account. It SHALL require a nonempty file up to 2 MiB whose content is detected as JPEG, PNG or WebP.

#### Scenario: Upload an eligible avatar
- **WHEN** a signed-in account uploads a nonempty file within the size limit whose content is detected as a supported image type
- **THEN** it is eligible to be stored as that account's avatar

#### Scenario: Reject a missing or unsupported avatar
- **WHEN** the upload is missing a file, is empty, exceeds 2 MiB, or its content is detected as another type
- **THEN** the system rejects the upload without changing the avatar

#### Scenario: Reject an unauthenticated upload
- **WHEN** a Guest attempts to upload an avatar
- **THEN** the system denies the request

### Requirement: Avatar replacement and cleanup

The system SHALL return a new avatar URL after storing the image and updating the signed-in account's avatar reference. It SHALL attempt to remove the previous stored avatar after a successful replacement. If saving the new reference reports an error, it SHALL attempt to remove the new upload and report failure.

#### Scenario: Replace an existing avatar
- **WHEN** the new upload and profile reference update succeed
- **THEN** the new URL is returned, subsequent profile reads use the new reference, and the system attempts to delete the previous stored avatar when a prior stored reference exists

#### Scenario: The new reference cannot be saved
- **WHEN** storage accepts the new avatar but the profile reference update reports an error
- **THEN** the system reports failure and attempts to delete the newly uploaded image

#### Scenario: Cleanup of the old avatar fails
- **WHEN** the reference update succeeds but deletion of the previous stored avatar fails
- **THEN** the new avatar URL is still returned as a successful replacement
