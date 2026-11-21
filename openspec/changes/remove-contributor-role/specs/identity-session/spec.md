## MODIFIED Requirements

### Requirement: Sign-in credentials and account eligibility

The system SHALL use a trimmed and lowercased username or email identifier to find an account for sign-in. It SHALL require an active, unsuspended account with a supported role and a matching password before issuing session credentials.

#### Scenario: Sign in with valid credentials
- **WHEN** a normalized email or username resolves to an active, unsuspended account with a supported role and the password matches
- **THEN** sign-in issues session credentials using the account's role

#### Scenario: Invalid credentials
- **WHEN** a sign-in identifier is unknown or the password is wrong for an active, unsuspended account, and the request remains within the allowed failure limits
- **THEN** the system reports invalid credentials

#### Scenario: Unverified or suspended account
- **WHEN** an account reached by sign-in is unverified or suspended
- **THEN** the system rejects sign-in with its account-state error before checking the password

#### Scenario: Account has an unsupported role
- **WHEN** a sign-in request with the correct password resolves to an active, unsuspended account whose role is unsupported
- **THEN** the system rejects sign-in without issuing credentials

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

#### Scenario: Refresh carries an unsupported role
- **WHEN** an otherwise valid refresh token carries the retired Contributor role or another unsupported role
- **THEN** the system rejects it without issuing replacement credentials

### Requirement: Authentication for protected actions

The system SHALL authenticate protected requests at the gateway from one access credential supplied as an access cookie or a Bearer token. It SHALL discard caller-supplied identity fields and pass identity verified from the token. The verified identity SHALL contain an account ID, username, supported role and usable issue time.

#### Scenario: Use one valid credential
- **WHEN** a protected request carries one valid access credential for a User, Moderator, or Admin and caller-supplied identity fields
- **THEN** the gateway derives identity from the credential and discards the caller-supplied identity values

#### Scenario: Authentication is missing or ambiguous
- **WHEN** a protected request has no valid access credential or supplies duplicate credentials or both credential forms
- **THEN** the gateway denies the request

#### Scenario: A required claim is missing or malformed
- **WHEN** a signed access token lacks required identity information or carries a malformed claim
- **THEN** the gateway denies the protected request

#### Scenario: Access credential carries an unsupported role
- **WHEN** a protected request carries a signed access token with the retired Contributor role or another unsupported role
- **THEN** the gateway denies access

### Requirement: Role checks

For actions with a minimum Role, the system SHALL compare the authenticated role against the action's minimum. The supported roles from lowest to highest SHALL be User, Moderator, and Admin. Protected services SHALL reject identity with a missing or unsupported role before admitting the action.

#### Scenario: Minimum role is enforced
- **WHEN** a signed-in User tries an action with a Moderator minimum
- **THEN** the action is forbidden while Moderator and Admin satisfy that role check

#### Scenario: Protected service receives an invalid role
- **WHEN** identity presented to a protected service has a missing or unsupported role
- **THEN** the service rejects the request before executing the action

### Requirement: Role assignment

The system SHALL allow only an Admin to assign a different supported role to an existing account. Assigning the role SHALL leave current session credentials and their invalidation cutoff unchanged.

#### Scenario: Assign a different role
- **WHEN** an Admin assigns an existing account a supported role different from its assigned role
- **THEN** the account receives the new role, which a fresh sign-in uses

#### Scenario: Reject an unauthorized or unchanged assignment
- **WHEN** a caller below Admin attempts assignment or an Admin submits the account's already assigned role
- **THEN** the system rejects the assignment

#### Scenario: Admin attempts to assign an unsupported role
- **WHEN** an Admin attempts to assign the retired Contributor role or another unsupported role
- **THEN** the system rejects the assignment and keeps the account's current role
