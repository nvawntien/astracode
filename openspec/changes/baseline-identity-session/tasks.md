## 1. Review requirement evidence

- [ ] 1.1 Verify registration, email verification and resend, recovery requests, token purpose, and admission limits by tracing the corresponding Evidence rows through request binding, use cases, token storage and mail. Cross-check token isolation and denied mail side effects against `TestTokenPurposeIsolation_RegisterForgotThenVerify` and `TestMailAdmissionDeniedRequestsHaveNoSideEffectsOrReplaceTokens`.
- [ ] 1.2 Verify sign-in eligibility, sign-in abuse controls, credential issuance, refresh eligibility, and refresh role and token reuse against the wired use cases and credential handlers. Check the role source and absence of token consumption on refresh. Cross-check abuse and suspension with `TestLoginPairThrottleDoesNotLockVictimFromDifferentIP` and `TestRefreshRejectsSuspendedAndInvalidatedUser`.
- [ ] 1.3 Verify protected access, logout, logout-all and invalidation cutoff against the local and production gateway filters, logout handlers and shared middleware. Cross-check the inclusive cutoff against `TestAuthMiddlewareRejectsTokenAtOrBeforeInvalidationCutoff`.
- [ ] 1.4 Verify password reset and authenticated password change against the handler validation, token consumption and password write ordering. Cross-check failure paths against `TestResetPasswordKeepsSessionsRevokedWhenPasswordPersistenceFails` and `TestChangePasswordKeepsSessionsRevokedWhenPasswordPersistenceFails`.
- [ ] 1.5 Verify role checks, role assignment, suspension and lifting suspension against the role order, protected request wiring, and account mutations. Cross-check the admin and cutoff rules against `TestAssignRoleRequiresAdminInUseCase` and `TestAdminUsersSuspensionRevokesBeforePersistenceAndUnsuspendKeepsCutoff`.

## 2. Review findings and validate

- [ ] 2.1 Review Findings and answer or record the disposition of the proposal's Open questions. Check effective lifetimes and abuse settings against authorized non-secret deployment evidence, and use an isolated stack if confirming concurrent outcomes or actual mail delivery. Keep any unconfirmed behaviour outside the delta.
- [ ] 2.2 Run `openspec validate baseline-identity-session --strict` and verify that all requirement titles have exactly one matching Evidence row.
