## Purpose

Record how AstraCode creates and verifies accounts, establishes and invalidates sessions, and applies roles and suspension.

## ADDED Requirements

### Requirement: Account registration

The system SHALL create an unverified account with the User role from a valid registration and store a hash of its password. Registration SHALL require a full name, a username of at least three characters, a valid email address and a password of at least eight bytes. It SHALL normalize the email to lowercase and reject duplicate email addresses and duplicate usernames.

#### Scenario: Register an unused identity
- **WHEN** a visitor registers with valid details and unused identity values
- **THEN** the system creates an unverified User account, saves a verification token and attempts to send the verification email without signing the account in

#### Scenario: Reject invalid or duplicate details
- **WHEN** a registration is admitted for processing but contains invalid details or an email or username already in use
- **THEN** the system rejects it without creating another account

#### Scenario: Verification email delivery fails
- **WHEN** registration has created the account and saved its verification token but email delivery returns an error
- **THEN** registration still reports success and the account remains unverified

### Requirement: Email verification

The system SHALL activate an unverified account only when presented with its latest unexpired email verification token. The system SHALL consume the token before persisting activation. A verification token SHALL expire after seven days.

#### Scenario: Verify an account
- **WHEN** an unverified account presents its current verification token within seven days
- **THEN** the system consumes the token and activates the account on a successful write

#### Scenario: Reject an unusable verification token
- **WHEN** a verification token is invalid, expired, replaced, or already consumed
- **THEN** verification fails

#### Scenario: Account is already verified
- **WHEN** a valid verification token resolves to an already active account
- **THEN** the system rejects verification as already active

#### Scenario: Activation cannot be saved
- **WHEN** the system consumes a valid verification token and then fails to save activation
- **THEN** the system reports failure and the consumed token cannot be reused

### Requirement: Resend verification email

The system SHALL issue a replacement verification token and attempt to send a new verification email for an unverified account when the request is admitted. An unknown email, an already verified account or an admission denial SHALL receive the generic resend success response without sending mail.

#### Scenario: Request a new verification email
- **WHEN** an admitted resend request names an unverified account
- **THEN** a new seven-day verification token replaces the previous token and the system attempts delivery

#### Scenario: Suppress a verification email
- **WHEN** a request names an unknown or already verified account, or exceeds the resend quota or cooldown
- **THEN** the system returns generic success without sending mail or replacing a token

#### Scenario: Replacement email delivery fails
- **WHEN** the replacement token is saved but email delivery returns an error
- **THEN** the resend action still reports success

### Requirement: Password recovery request

The system SHALL issue a five-minute password reset token and attempt to send it to a known account when the recovery request is admitted. It SHALL return generic success without sending mail for an unknown email or when recovery admission is denied.

#### Scenario: Request recovery for a known account
- **WHEN** a recovery request for a known email passes admission
- **THEN** the system replaces any previous reset token, attempts email delivery, and returns generic success if delivery reports success

#### Scenario: Account is unverified or suspended
- **WHEN** a known account is unverified or suspended and its recovery request passes admission
- **THEN** the system still issues the reset token and attempts email delivery

#### Scenario: Recovery request is suppressed
- **WHEN** an email is unknown or the recovery request exceeds its quota or cooldown
- **THEN** the system returns generic success without sending mail or replacing a token

#### Scenario: Recovery email delivery fails
- **WHEN** the system saves a password reset token but cannot send the email
- **THEN** the system reports failure

### Requirement: Verification and reset token purpose

The system SHALL accept verification tokens only for email verification and password reset tokens only for password reset. Replacing or consuming one kind of token SHALL leave the other kind unaffected.

#### Scenario: One account has both tokens
- **WHEN** an account requests a password reset while it has an outstanding verification token
- **THEN** the verification token continues to work for verification and neither token can be used for the other action

### Requirement: Admission limits for registration and email actions

The system SHALL apply configured registration quotas by client IP and by client IP and email together. For eligible verification resend and password recovery requests, it SHALL apply per-account quotas and cooldowns as well as client IP limits. The system SHALL separately limit verification and password reset token submissions by client IP.

#### Scenario: Registration or token submission exceeds its limit
- **WHEN** a registration, email verification, or password reset token submission is over its applicable limit
- **THEN** the system rejects it as rate limited without creating an account or consuming a token

#### Scenario: Mail admission cannot be checked
- **WHEN** admission for verification resend or password recovery cannot be established because trusted client IP information or the admission store is unavailable
- **THEN** the action returns generic success without sending mail

#### Scenario: Registration admission cannot be checked
- **WHEN** registration admission cannot be established because trusted client IP information or the admission store is unavailable
- **THEN** registration fails with a service-unavailable error without creating an account

### Requirement: Sign-in credentials and account eligibility

The system SHALL use a trimmed and lowercased username or email identifier to find an account for sign-in. It SHALL require an active, unsuspended account and a matching password before issuing session credentials.

#### Scenario: Sign in with valid credentials
- **WHEN** a normalized email or username resolves to an active, unsuspended account and the password matches
- **THEN** sign-in issues session credentials using the account's role

#### Scenario: Invalid credentials
- **WHEN** a sign-in identifier is unknown or the password is wrong for an active, unsuspended account, and the request remains within the allowed failure limits
- **THEN** the system reports invalid credentials

#### Scenario: Unverified or suspended account
- **WHEN** an account reached by sign-in is unverified or suspended
- **THEN** the system rejects sign-in with its account-state error before checking the password

### Requirement: Sign-in abuse controls

The system SHALL enforce configured failed sign-in limits for the client IP and identifier pair and for the client IP overall. Elevated failure counts for an identifier alone SHALL apply the configured bounded delay instead of an identifier-wide lockout. An accepted password check SHALL attempt to clear the pair and identifier counters.

#### Scenario: A client exhausts the pair limit
- **WHEN** failed attempts exhaust the limit for one client IP and identifier pair
- **THEN** that pair is rate limited and another client can still sign in with valid credentials if its own limits allow

#### Scenario: Successful sign-in from a shared IP
- **WHEN** a request passes admission and the password check succeeds
- **THEN** the system attempts to clear the pair and identifier failure counts but leaves the broader client IP failure count in place

#### Scenario: Protection cannot be established
- **WHEN** trusted client IP information or the failure counters needed to admit a sign-in are unavailable
- **THEN** the system fails the sign-in attempt

### Requirement: Session credential issuance

On successful sign-in or refresh, the system SHALL issue signed access and refresh tokens with configured lifetimes and issue times. It SHALL return both tokens in the response and set them as HTTP-only cookies.

#### Scenario: Establish a browser session
- **WHEN** sign-in or refresh succeeds
- **THEN** the response provides both credentials and sets both cookies with their corresponding lifetimes

### Requirement: Refresh eligibility

The system SHALL require a valid refresh token in the refresh cookie, an eligible account, and an issue time newer than any recorded invalidation cutoff. The system SHALL rate limit refresh attempts by the presented refresh token.

#### Scenario: Refresh without an eligible credential
- **WHEN** the refresh cookie is missing or its token is invalid, expired or invalidated
- **THEN** the system rejects refresh without issuing replacement credentials

#### Scenario: Refresh after account status changes
- **WHEN** a refresh token resolves to an account that is missing, unverified or suspended
- **THEN** the system rejects refresh without issuing replacement credentials

#### Scenario: Refresh quota is exceeded
- **WHEN** attempts with the same presented refresh token exceed the configured limit
- **THEN** further attempts in that rate window are rejected as rate limited

### Requirement: Refresh role and previous token

On successful refresh, the system SHALL issue credentials carrying the account ID, username and role from the presented refresh token. Issuing the credentials SHALL leave the previously presented token usable while it remains valid and eligible.

#### Scenario: Refresh after a role assignment
- **WHEN** an active, unsuspended account refreshes with a still eligible token issued before its role changed
- **THEN** both issued credentials carry the role in the presented token

#### Scenario: Repeat a refresh
- **WHEN** a previously presented refresh token is submitted again within its lifetime, with admission and account eligibility still satisfied
- **THEN** the system accepts the token again

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

### Requirement: Logout

The system SHALL clear the calling browser's access and refresh cookies on authenticated logout. This action SHALL leave the account-wide invalidation cutoff unchanged.

#### Scenario: Sign out the current browser
- **WHEN** an authenticated User logs out
- **THEN** the response expires both cookies and leaves other eligible credentials unaffected

### Requirement: Logout-all

The system SHALL record a session invalidation cutoff for the authenticated account and then clear the calling browser's access and refresh cookies on logout-all.

#### Scenario: End existing sessions for one account
- **WHEN** an authenticated User logs out of all sessions and the cutoff write succeeds
- **THEN** the system invalidates that account's credentials issued at or before the cutoff and expires both cookies in the response

#### Scenario: Session invalidation write fails
- **WHEN** the cutoff cannot be recorded
- **THEN** logout-all reports failure without returning cookie deletion

### Requirement: Session invalidation cutoff

The system SHALL reject access and refresh tokens issued at or before the account's recorded invalidation cutoff. It SHALL set the cutoff to expire after the configured refresh lifetime and SHALL fail an authentication check if it cannot read the cutoff store. Sign-in SHALL wait past a cutoff that has not yet passed before issuing credentials.

#### Scenario: Token is issued in the same second as invalidation
- **WHEN** a token is checked while a cutoff is present and its issue time equals the cutoff
- **THEN** the system rejects the token

#### Scenario: Fresh sign-in at the cutoff
- **WHEN** sign-in reaches issuance in the same second as a recorded cutoff
- **THEN** it waits until a later second and rechecks account activation and suspension before issuing credentials

#### Scenario: The cutoff cannot be read
- **WHEN** the cutoff store returns an error while checking protected access or refresh
- **THEN** the request fails without accepting the credentials

### Requirement: Reset password with a recovery token

The system SHALL require a new password of at least eight characters and a matching confirmation before accepting the latest unexpired password reset token. It SHALL consume the token before recording session invalidation and saving the new password hash. A reset SHALL preserve the account's activation and suspension state.

#### Scenario: Reset using a valid token
- **WHEN** a user supplies the current reset token and a valid matching new password and confirmation
- **THEN** the system consumes that token, records session invalidation, and saves the new password without changing whether the account is active or suspended

#### Scenario: Reset cannot complete after consumption
- **WHEN** the token is consumed but session invalidation or password persistence fails
- **THEN** reset reports an error and the same token cannot be reused

#### Scenario: Password write fails after invalidation
- **WHEN** reset records session invalidation and then fails to save the new password
- **THEN** reset reports an error and leaves the cutoff in effect

### Requirement: Change password while signed in

The system SHALL require the authenticated account's correct current password, a different new password of at least eight characters, and matching confirmation. It SHALL record session invalidation before saving the new password hash.

#### Scenario: Change the current password
- **WHEN** a signed-in user provides the correct current password and a valid different new password with matching confirmation
- **THEN** the system records session invalidation and saves the new password

#### Scenario: Invalid change request
- **WHEN** the current password is wrong or the new password equals the current password or fails validation
- **THEN** the system rejects the change without saving the new password or invalidating sessions through that request

#### Scenario: Password write fails after invalidation
- **WHEN** the change records session invalidation and then fails to save the new password
- **THEN** the change reports an error and leaves the cutoff in effect

### Requirement: Role checks

For actions with a minimum Role, the system SHALL compare the authenticated role against the action's minimum. The current order from lowest to highest SHALL be User, Contributor, Moderator, and Admin.

#### Scenario: Minimum role is enforced
- **WHEN** a signed-in User or Contributor tries an action with a Moderator minimum
- **THEN** the action is forbidden while Moderator and Admin satisfy that role check

### Requirement: Role assignment

The system SHALL allow only an Admin to assign a different supported role to an existing account. Assigning the role SHALL leave current session credentials and their invalidation cutoff unchanged.

#### Scenario: Assign a different role
- **WHEN** an Admin assigns an existing account a supported role different from its assigned role
- **THEN** the account receives the new role, which a fresh sign-in uses

#### Scenario: Reject an unauthorized or unchanged assignment
- **WHEN** a caller below Admin attempts assignment or an Admin submits the account's already assigned role
- **THEN** the system rejects the assignment

### Requirement: Account suspension

The system SHALL allow only an Admin to suspend an existing account. It SHALL record session invalidation before persisting suspension. A suspended account SHALL be ineligible for sign-in and refresh.

#### Scenario: Suspend an account
- **WHEN** an Admin suspends an account and the cutoff and suspension writes succeed
- **THEN** the account becomes suspended and its credentials issued at or before the cutoff become invalid

#### Scenario: Cutoff write fails
- **WHEN** the system cannot record session invalidation for a requested suspension
- **THEN** the system reports failure without persisting the suspension

#### Scenario: Suspension write fails after invalidation
- **WHEN** the system records the cutoff but fails to persist suspension
- **THEN** it reports failure and leaves the cutoff in effect

### Requirement: Lift account suspension

The system SHALL allow only an Admin to lift suspension while preserving the account's verification state and any existing invalidation cutoff.

#### Scenario: Restore access after suspension
- **WHEN** an Admin lifts suspension from a verified account
- **THEN** that account can sign in again and credentials invalidated by the recorded cutoff remain invalid
