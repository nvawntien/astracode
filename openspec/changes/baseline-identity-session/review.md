---
change: baseline-identity-session
round: 1
max_rounds: 3
reviewed_commit: 2e635f07a6d0c751596a5741ff53542874f97321
status: approved
---

## Round 1 findings

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | specs/identity-session/spec.md: "Admission limits for registration and email actions" | The "Mail admission cannot be checked" scenario only covers resend/recovery returning generic success when client-IP info or the admission store is unavailable. Registration hits the identical failure (missing client IP or `acquire` error) but takes a different path: `services/auth/internal/application/usecase/auth/register.go:55-58,64-66` both `return err` (a hard service-unavailable failure), not generic success. The spec does not describe this case for registration at all. | Add a scenario (or a clause) noting that for registration specifically, an admission check that cannot be established returns a hard failure, unlike resend/recovery which return generic success. |

Checks performed, no issues found:
- `openspec validate baseline-identity-session --strict` → valid.
- All 21 `ADDED Requirement` titles in spec.md have exactly one matching row in design.md's Evidence table; no missing rows.
- Boundary table (`docs/process/templates/baseline-prompt.md`, M0-02 row): every requirement falls inside identity-session's listed scope (registration, verification, sign-in, refresh, logout, logout-all, password reset/change, roles, suspension, session invalidation). Nothing strays into user-profile (public profile/search/avatar) or any other capability.
- spec.md describes behaviour only; no endpoints, tables, class or file names. The one near-miss, "set them as HTTP-only cookies" (Session credential issuance), describes an observable cookie attribute, not an implementation detail — not a violation.
- Traced every requirement's scenarios against the cited code (file:line) via five independent passes:
  - Registration, email verification, resend, password recovery, token-purpose isolation, admission limits — all scenario claims hold, including the exact 7-day verification TTL (`register.go:18`, `24*7*time.Hour`), 5-minute reset TTL (`forgot_password.go:16`), byte-length password check (`valueobject/password.go`), the register/resend mail-failure-swallowed vs. recovery mail-failure-reported asymmetry (`forgot_password.go:98-100` vs `register.go:121`, `resend_verification.go:105`), and purpose-namespaced Redis token keys.
  - Sign-in, sign-in abuse controls, session issuance, refresh eligibility, refresh role/token-reuse — all hold, including the inclusive `<=` cutoff comparison, the refresh-token-as-rate-limit-scope naming oddity, and refresh issuing credentials from the presented token's role (not the DB's current role) with no rotation/consumption of the old token.
  - Gateway authentication, logout, logout-all, invalidation cutoff — all hold: `envoy/edge.lua` denies both-cookie-and-bearer and duplicate credentials; `header_mutation` strips caller-supplied `x-user-*` before `jwt_authn` sets verified claims; logout-all's cutoff write precedes and gates cookie clearing; `session_invalidation.go`'s wait-then-recheck fires exactly on `now == cutoff`.
  - Password reset and change-password — order of validation → token consumption/current-password check → session-invalidation write → password write all hold, including no rollback of the cutoff when the subsequent password write fails. The DTO-level rune-based `min=8` check and the use-case's byte-based `ValidatePlainPassword` check both apply to reset/change, but since byte length is always ≥ rune length, the byte check can never reject a string that already passed the character check — no observable behavioural mismatch with the spec's "eight characters" wording.
  - Role checks, role assignment, suspension, lift-suspension — all hold: role order User < Contributor < Moderator < Admin (`pkg/rbac/role.go`), Admin-only and no-op-rejected assignment, suspend-then-persist ordering with no rollback, unsuspend leaving verification state and cutoff untouched.
- proposal.md's "Findings" entries (role assignment not reloading on refresh; mixed-case username lookup; refresh token as IP-named rate-limit scope with no consumption; logout vs logout-all scope; mail-failure asymmetry; whole-record `UpdateUser` snapshot writes; legacy `verify-forgot-password` route with no backend handler) were spot-checked against the code and are all accurate as stated.
- proposal.md's "Open questions" (deployed settings/mail delivery values; live cross-request interleavings) are correctly left open — neither is answerable from the checked-in source.

No blocking findings. The one minor finding above is a missing scenario, not an incorrect one; status is `approved` per the loop's status rules.

## Round 1 author response
| # | Action | Note |
|---|---|---|
| 1.1 | fixed | Added a registration admission failure scenario and clarified its evidence: `services/auth/internal/application/usecase/auth/register.go:55` returns admission errors before account creation, and `services/auth/internal/application/usecase/auth/auth_abuse.go:20` maps unavailable admission and missing client IP to service-unavailable errors. |
