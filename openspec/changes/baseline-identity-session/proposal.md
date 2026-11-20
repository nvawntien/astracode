## Why

AstraCode needs a reviewable record of how accounts, roles and sessions work today. This baseline gives future changes a code backed reference for identifying differences in behaviour.

## What Changes

- Add requirements and scenarios for registration, email verification and resend, sign-in, refresh, logout, logout-all, password reset and change, roles and role checks, suspension, and session invalidation.
- Trace each requirement to the current implementation and record observed gaps separately.
- Out of scope: public profile, user search and avatar (`user-profile`).

## Capabilities

### New Capabilities

- `identity-session` — Existing account activation, credential and session lifecycle, role enforcement and suspension.

### Modified Capabilities

None.

## Impact

The deliverable is an OpenSpec baseline. It introduces no runtime or contract changes.

## Findings

- Role assignment updates the account but neither revokes current sessions nor makes refresh reload the role. An existing refresh token can carry its previous role into newly issued tokens. See `assignRoleUseCase.Execute` and `refreshTokenUseCase.Execute`.
- Sign-in lowercases the identifier, while registration stores the supplied username and username lookup uses an equality predicate. Mixed case usernames can therefore fail username sign-in. Email sign-in uses the normalized email identity. See `register.Execute`, `normalizedIdentifier` and `userRepository.GetUserByUsername`.
- Refresh uses the presented token as the rate-limit scope even though the setting is named as an IP limit. It does not consume the old token. See `refreshTokenUseCase.Execute`.
- Ordinary logout clears browser cookies only. Account-wide invalidation is a separate action. See `LogoutHandler.Handle` and `LogoutAllHandler.Handle`.
- Password recovery returns an error on mail delivery failure for an existing eligible account, whereas an unknown email receives generic success. Verification mail failures are ignored by registration and resend after the token is saved. See `forgotPasswordUseCase.Execute`, `register.Execute` and `resendVerificationUseCase.Execute`.
- Email activation, role assignment and suspension take a user snapshot and later write the whole user record. A concurrent change to another field may be overwritten by that write. See `userRepository.UpdateUser` and its callers.
- The gateway inventory still declares a legacy forgot-password verification action that Auth does not register. The baseline covers the implemented password reset flow. See `envoy/routes.json` and `Router.SetupRoutes`.

## Open questions

- What session lifetimes, abuse thresholds and mail delivery settings are actually active in deployed environments? The source establishes checked-in settings and runtime overrides, not deployed values or mail delivery.
- Which in-flight outcomes can occur across simultaneous sign-in, refresh, role assignment, suspension and password changes in a live stack? The reviewed code establishes the order of checks and writes, but does not establish an atomic cross-request guarantee.
