## ADDED Requirements

### Requirement: Existing Contributor account conversion
The system SHALL convert existing Contributor accounts to User while retaining their account IDs, verification and suspension status, and ownership of drafts, Published problems, and prior Submissions. It SHALL invalidate access and refresh sessions issued to those accounts at or before the conversion cutoff.

#### Scenario: Migrated author signs in again
- **WHEN** a previously verified, unsuspended Contributor signs in after conversion
- **THEN** the account receives User credentials and retains access to its own existing drafts, Published problems, and prior Submissions

#### Scenario: Affected account presents a pre-cutover credential
- **WHEN** a migrated account presents an access or refresh credential issued at or before the conversion cutoff
- **THEN** the system rejects the credential

#### Scenario: Conversion includes an unverified or suspended account
- **WHEN** an unverified or suspended Contributor account is converted
- **THEN** its role becomes User and its existing verification and suspension state continue to govern sign-in

#### Scenario: Conversion is retried
- **WHEN** the migration is run again after completion
- **THEN** it leaves converted account roles and ownership intact and preserves sessions issued after the completed conversion

## MODIFIED Requirements

### Requirement: Refresh eligibility

The system SHALL require a valid refresh token in the refresh cookie, a supported role in the token, an eligible account, and an issue time newer than any recorded invalidation cutoff. The system SHALL rate limit refresh attempts by the presented refresh token.

#### Scenario: Refresh without an eligible credential
- **WHEN** the refresh cookie is missing or its token is invalid, expired or invalidated
- **THEN** the system rejects refresh without issuing replacement credentials

#### Scenario: Refresh after account status changes
- **WHEN** a refresh token resolves to an account that is missing, unverified or suspended
- **THEN** the system rejects refresh without issuing replacement credentials

#### Scenario: Refresh quota is exceeded
- **WHEN** attempts with the same presented refresh token exceed the configured limit
- **THEN** further attempts in that rate window are rejected as rate limited

#### Scenario: Refresh carries the retired role
- **WHEN** a refresh token carries the retired Contributor role
- **THEN** the system rejects it without issuing replacement credentials

### Requirement: Authentication for protected actions

The system SHALL authenticate protected requests at the gateway from one access credential supplied as an access cookie or a Bearer token. It SHALL discard caller-supplied identity fields and pass identity verified from the token. The verified identity SHALL contain an account ID, username, supported role and usable issue time.

#### Scenario: Use one valid credential
- **WHEN** a protected request carries one valid access credential and caller-supplied identity fields
- **THEN** the gateway derives identity from the credential and discards the caller-supplied identity values

#### Scenario: Authentication is missing or ambiguous
- **WHEN** a protected request has no valid access credential or supplies duplicate credentials or both credential forms
- **THEN** the gateway denies the request

#### Scenario: A required claim is missing or malformed
- **WHEN** a signed access token lacks required identity information or carries an unsupported role
- **THEN** the gateway denies the protected request

#### Scenario: Access credential carries the retired role
- **WHEN** a protected request carries a signed access token with the retired Contributor role
- **THEN** the gateway denies access

### Requirement: Role checks

For actions with a minimum Role, the system SHALL compare the authenticated role against the action's minimum. The supported roles from lowest to highest SHALL be User, Moderator, and Admin.

#### Scenario: Minimum role is enforced
- **WHEN** a signed-in User tries an action with a Moderator minimum
- **THEN** the action is forbidden while Moderator and Admin satisfy that role check

### Requirement: Role assignment

The system SHALL allow only an Admin to assign a different supported role to an existing account. Assigning the role SHALL leave current session credentials and their invalidation cutoff unchanged.

#### Scenario: Assign a different role
- **WHEN** an Admin assigns an existing account a supported role different from its assigned role
- **THEN** the account receives the new role, which a fresh sign-in uses

#### Scenario: Reject an unauthorized or unchanged assignment
- **WHEN** a caller below Admin attempts assignment or an Admin submits the account's already assigned role
- **THEN** the system rejects the assignment

#### Scenario: Admin attempts to assign the retired role
- **WHEN** an Admin attempts to assign the retired Contributor role
- **THEN** the system rejects the assignment and keeps the account's current role
