# progress.md — baseline-identity-session

## Verified state

- Branch `docs/apply-m0-baselines` at review input `0bb19b2`. Working tree and staging area were clean.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` passed in a disposable checkout. Go tests and vet, website typecheck, Compose config, and strict validation of all eight changes passed.
- `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed in the same checkout, including race tests and the Next.js 15.5.29 build. The build reported existing lint warnings.
- Task 1.1 verified through the wired handlers, admission scopes, mail branches, and purpose-specific Redis token lifecycle. `TestTokenPurposeIsolation_RegisterForgotThenVerify`, `TestMailAdmissionDeniedRequestsHaveNoSideEffectsOrReplaceTokens`, `TestMailAdmissionMissingIPAndStoreFailureFailClosed`, and `TestTokenKeysArePurposeScoped` passed.
- Task 1.2 verified by the login, refresh, and credential-handler trace. `TestLoginPairThrottleDoesNotLockVictimFromDifferentIP` and `TestRefreshRejectsSuspendedAndInvalidatedUser` passed. Sign-in uses the current account role. Refresh uses the presented token's claims and leaves that token reusable while eligible.
- Task 1.3 verified by the gateway config audit and the logout/cutoff trace. Both Envoy configurations matched all 34 protected routes, credential sources, claim checks, and filter order. `TestAuthMiddlewareRejectsTokenAtOrBeforeInvalidationCutoff` passed. Logout-all writes the cutoff before clearing cookies.
- Task 1.4 verified by handler binding, token consumption, invalidation, and the password-only persistence path. `TestResetPasswordKeepsSessionsRevokedWhenPasswordPersistenceFails` and `TestChangePasswordKeepsSessionsRevokedWhenPasswordPersistenceFails` passed.
- Task 1.5 verified by the role order and Admin checks in the router and use cases. `TestAssignRoleRequiresAdminInUseCase` and `TestAdminUsersSuspensionRevokesBeforePersistenceAndUnsuspendKeepsCutoff` passed.
- Task 2.1 verified by the proposal findings trace, a non-secret configuration audit, and deployment manifest review. The checked-in Auth defaults are 15m access and 168h refresh. The audit also checked login, token and refresh rate windows and the mail cooldown against their wired settings. The Compose manifests and config loader allow deployment-specific overrides.
- Task 2.2 verified by `openspec validate baseline-identity-session --strict` (valid) and the structural audit (21 ADDED requirements, 52 WHEN/THEN scenarios, one Evidence row per requirement). The current count includes the registration admission failure scenario added after round 1.

## Last session

- Reviewed all seven tasks on the documentation baseline. Updated `tasks.md` and this evidence log.

## Broken or unverified

- The proposal's deployed-settings and mail-delivery question remains open. Checked-in defaults and deployment wiring establish the configured inputs. Effective running values and actual SMTP delivery require deployment or delivery evidence.
- The proposal's concurrent-outcomes question remains open. Code and fixture tests establish operation order and covered failures. Live cross-request interleavings were outside the review evidence.
- OpenSpec 1.13.0 ignored the repository's artifact-rule entries because they are strings. The scoped audit checked the requirement and scenario structure and Evidence titles separately.

## Archive

- Archived on 2026-11-20 after matching the Purpose and all 21 requirements against the delta specs for `identity-session`.
- `openspec validate --all --strict --no-interactive` passed (9 items, zero failures).
