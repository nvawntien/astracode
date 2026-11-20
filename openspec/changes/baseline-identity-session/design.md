## Context

Auth owns account credentials and status. The gateway verifies access credentials and passes derived identity to the services. Shared middleware checks the account's session invalidation cutoff and enforces required roles. The architecture references are [Architecture](../../../docs/codebase/ARCHITECTURE.md), [Flows](../../../docs/codebase/FLOWS.md), [Data](../../../docs/codebase/DATA.md) and [Services](../../../docs/codebase/SERVICES.md). The evidence below identifies the source used for the baseline.

## Goals / Non-Goals

**Goals**

- Make each requirement in the [baseline spec](specs/identity-session/spec.md) traceable to its runtime entry point and enforcing code.
- Capture observable ordering and failure behaviour where an action combines token state, account state and credential issuance.

**Non-Goals**

- Change implementation, API or event contracts, configuration, or deployment.
- Specify `user-profile` behaviour or assert conformance to a new quality target.

## Decisions

- Base the delta on public request wiring, runtime use cases and their adapters. The gateway implementation lives in `envoy/`. `envoy/routes.json` and `Router.SetupRoutes` identify which actions are exposed and protected. `InitializeApp` in `services/auth/cmd/server/wire_gen.go` wires the use cases with abuse protection, so unprotected constructors used by tests are not the production authority.
- Treat account activation, suspension, and token eligibility as distinct checks. Login and refresh read the account state, while downstream protected requests validate the verified access identity against the recorded cutoff. Role guards evaluate token-derived claims. This matters when an account's stored role changes while it still has active tokens.
- Describe configurable session lifetimes and abuse limits in terms of their scope. The checked-in Auth settings use 15 minutes for access tokens and seven days for refresh tokens. `pkg/config/config.go` (`LoadConfig`) permits environment overrides. The seven-day verification lifetime and five-minute password reset lifetime are constants in their use cases.

## Evidence

Paths are relative to the repository root. Each row corresponds to one requirement title.

| Requirement | File paths and implementing functions or handlers |
| --- | --- |
| Account registration | `services/auth/internal/adapter/inbound/http/handler/auth/register.go` — `RegisterHandler.Handle` and request binding via `services/auth/internal/application/dto/auth.go` (`RegisterRequest`). `services/auth/internal/application/usecase/auth/register.go` — `register.Execute`. `services/auth/internal/domain/entity/user.go` — `NewUser`. `services/auth/internal/domain/valueobject/email.go` — `NewEmail`. `services/auth/internal/domain/valueobject/password.go` — `ValidatePlainPassword`. `services/auth/internal/adapter/outbound/security/bcrypt_hasher.go` — `bcryptHasher.HashAndSalt`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `GetUserByEmail`, `GetUserByUsername`, `CreateUser`. |
| Email verification | `services/auth/internal/application/usecase/auth/verify_email.go` — `verifyEmail.Execute`. `services/auth/internal/application/usecase/auth/register.go` — `register.Execute` and the verification lifetime. `services/auth/internal/adapter/outbound/cache/redis/token.go` — `tokenRepository.FindByToken`, `Consume`. `services/auth/internal/domain/entity/user.go` — `User.Activate`. |
| Resend verification email | `services/auth/internal/application/usecase/auth/resend_verification.go` — `resendVerificationUseCase.Execute`. `services/auth/internal/adapter/inbound/http/handler/auth/resend_verification.go` — `ResendVerificationHandler.Handle`. `services/auth/internal/adapter/outbound/mail/smtp_provider.go` — `smtpProvider.SendVerificationEmail`. `services/auth/internal/adapter/outbound/cache/redis/token.go` — `tokenRepository.Save`. |
| Password recovery request | `services/auth/internal/application/usecase/auth/forgot_password.go` — `forgotPasswordUseCase.Execute` and the reset token lifetime. `services/auth/internal/adapter/inbound/http/handler/auth/forgot_password.go` — `ForgotPasswordHandler.Handle`. `services/auth/internal/adapter/outbound/mail/smtp_provider.go` — `smtpProvider.SendForgotPasswordEmail`. |
| Verification and reset token purpose | `services/auth/internal/adapter/outbound/cache/redis/token.go` — `tokenRepository.Save`, `FindByToken`, `Consume` and purpose-specific key builders. `services/auth/internal/application/usecase/auth/verify_email.go` and `reset_password.go` (same directory) — `verifyEmail.Execute`, `resetPasswordUseCase.Execute` select their respective purposes. |
| Admission limits for registration and email actions | `services/auth/internal/application/usecase/auth/register.go` — `register.Execute`. `services/auth/internal/application/usecase/auth/resend_verification.go` — `resendVerificationUseCase.Execute`. `services/auth/internal/application/usecase/auth/forgot_password.go` — `forgotPasswordUseCase.Execute`. `services/auth/internal/application/usecase/auth/verify_email.go` — `verifyEmail.Execute`. `services/auth/internal/application/usecase/auth/reset_password.go` — `resetPasswordUseCase.Execute`. `services/auth/internal/application/usecase/auth/auth_abuse.go` — `clientIP`, `acquire`, `allow`, `emailRequestScopes`. `services/auth/internal/adapter/outbound/cache/redis/auth_abuse.go` — `authAbuseLimiter.Acquire`, `Allow`. `envoy/edge.lua` — `envoy_on_request`. `pkg/middleware/request_metadata.go` — `NewRequestMetadataMiddleware`. |
| Sign-in credentials and account eligibility | `services/auth/internal/application/usecase/auth/login.go` — `loginUseCase.Execute`, `resolveUser`. `services/auth/internal/application/usecase/auth/auth_abuse.go` — `normalizedIdentifier`. `services/auth/internal/adapter/outbound/security/bcrypt_hasher.go` — `bcryptHasher.ComparePasswords`. |
| Sign-in abuse controls | `services/auth/internal/application/usecase/auth/login.go` — `loginUseCase.Execute`, `recordLoginFailure`. `services/auth/internal/application/usecase/auth/auth_abuse.go` — `clientIP`, `checkFailureLimit`, `delayForIdentifierRisk`. `services/auth/internal/adapter/outbound/cache/redis/auth_abuse.go` — `authAbuseLimiter.Count`, `Allow`, `Reset`. |
| Session credential issuance | `services/auth/internal/adapter/outbound/jwt/jwt_provider.go` — `jwtProvider.GenerateAccessToken`, `GenerateRefreshToken`. `services/auth/internal/adapter/inbound/http/handler/auth/login.go` — `LoginHandler.Handle`. `services/auth/internal/adapter/inbound/http/handler/auth/refresh_token.go` — `RefreshTokenHandler.Handle`. |
| Refresh eligibility | `services/auth/internal/adapter/inbound/http/handler/auth/refresh_token.go` — `RefreshTokenHandler.Handle`. `services/auth/internal/application/usecase/auth/refresh_token.go` — `refreshTokenUseCase.Execute`. `services/auth/internal/adapter/outbound/jwt/jwt_provider.go` — `jwtProvider.VerifyRefreshToken`, `verifyToken`. `services/auth/internal/application/usecase/auth/auth_abuse.go` — `authAbuse.allow`. |
| Refresh role and previous token | `services/auth/internal/application/usecase/auth/refresh_token.go` — `refreshTokenUseCase.Execute`. `services/auth/internal/adapter/outbound/jwt/jwt_provider.go` — `jwtProvider.VerifyRefreshToken`, `GenerateAccessToken`, `GenerateRefreshToken`. `services/auth/internal/application/usecase/admin/assign_role.go` — `assignRoleUseCase.Execute`. |
| Authentication for protected actions | `envoy/edge.lua` — `envoy_on_request`. `envoy/generate.py` — `build`, `authorization`. `envoy/envoy.yaml` and `envoy/envoy.prod.yaml` — active filter configuration for JWT verification, claim propagation and claim checks. |
| Logout | `services/auth/internal/adapter/inbound/http/router.go` — `Router.SetupRoutes`. `services/auth/internal/adapter/inbound/http/handler/auth/logout.go` — `LogoutHandler.Handle`. |
| Logout-all | `services/auth/internal/adapter/inbound/http/handler/auth/logout_all.go` — `LogoutAllHandler.Handle`. `services/auth/internal/application/usecase/auth/logout_all.go` — `logoutAllUseCase.Execute`. `pkg/auth/logout_all_iat_store.go` — `redisLogoutAllIATStore.SetLogoutAllIAT`. |
| Session invalidation cutoff | `pkg/auth/logout_all_iat_store.go` — `redisLogoutAllIATStore.SetLogoutAllIAT`, `GetLogoutAllIAT`. `pkg/middleware/auth.go` — `NewAuthMiddleware`. `services/auth/internal/application/usecase/auth/refresh_token.go` — `refreshTokenUseCase.Execute`. `services/auth/internal/application/usecase/auth/login.go` — `loginUseCase.Execute`. `services/auth/internal/application/usecase/auth/session_invalidation.go` — `waitForTokenIssuedAfterInvalidation`. |
| Reset password with a recovery token | `services/auth/internal/adapter/inbound/http/handler/auth/reset_password.go` — `ResetPasswordHandler.Handle` and request binding via `services/auth/internal/application/dto/auth.go` (`ResetPasswordRequest`). `services/auth/internal/application/usecase/auth/reset_password.go` — `resetPasswordUseCase.Execute`. `services/auth/internal/adapter/outbound/cache/redis/token.go` — `tokenRepository.Consume`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.UpdatePassword`. |
| Change password while signed in | `services/auth/internal/adapter/inbound/http/handler/auth/change_password.go` — `ChangePasswordHandler.Handle` and request binding via `services/auth/internal/application/dto/auth.go` (`ChangePasswordRequest`). `services/auth/internal/application/usecase/auth/change_password.go` — `changePasswordUseCase.Execute`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.UpdatePassword`. |
| Role checks | `pkg/middleware/auth.go` — `NewAuthMiddleware`. `pkg/middleware/role.go` — `RequireRole`. `pkg/rbac/role.go` — `Role.Level`, `AtLeast`. |
| Role assignment | `services/auth/internal/adapter/inbound/http/handler/admin/assign_role.go` — `AssignRoleHandler.Handle` and request binding via `services/auth/internal/application/dto/admin.go` (`AssignRoleRequest`). `services/auth/internal/application/usecase/admin/assign_role.go` — `assignRoleUseCase.Execute`. `services/auth/internal/domain/entity/user.go` — `User.AssignRole`. |
| Account suspension | `services/auth/internal/adapter/inbound/http/handler/admin/users.go` — `AdminUsersHandler.SetSuspension`. `services/auth/internal/application/usecase/admin/users.go` — `adminUsersUseCase.SetSuspension`. `services/auth/internal/domain/entity/user.go` — `User.Suspend`. `services/auth/internal/application/usecase/auth/login.go` and `refresh_token.go` (same directory) — `loginUseCase.Execute`, `refreshTokenUseCase.Execute`. |
| Lift account suspension | `services/auth/internal/application/usecase/admin/users.go` — `adminUsersUseCase.SetSuspension`. `services/auth/internal/domain/entity/user.go` — `User.Unsuspend`. `pkg/middleware/auth.go` — `NewAuthMiddleware`. `services/auth/internal/application/usecase/auth/refresh_token.go` — `refreshTokenUseCase.Execute`. |

## Risks / Trade-offs

- The glossary labels Contributor deprecated → The baseline records that the runtime still accepts Contributor and ranks it between User and Moderator.
- Some actions span separate state writes → The baseline records the order and observed failure outcomes. It does not assert atomicity across concurrent requests.
- Deployment overrides may differ from checked-in settings → Actual deployment values and live interleavings remain review questions in the proposal.

## Documentation impact

The change adds the baseline delta and its review artifacts. The architecture references require no update for this proposal.
