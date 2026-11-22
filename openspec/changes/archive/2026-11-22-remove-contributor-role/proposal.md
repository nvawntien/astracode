Implements: F-01 (role removal), F-03 (draft authoring) | Addresses: NFR-S01, NFR-S02

## Why

Problem authors currently need an Admin to assign the Contributor role before they can draft a problem. M1-01 opens draft authoring to authenticated Users and keeps moderation with staff.

## What Changes

- **BREAKING** Retire `contributor`. User, Moderator, and Admin are the supported roles. Protected services and credential validation reject unsupported roles.
- Open the existing Contributions workspace and draft authoring routes to Users. Ownership and current visibility govern edits and testcase package changes. Users can also read their own Published contributions.
- Keep publication, hiding, the staff catalog, taxonomy administration, and cross-author management with Moderators and Admins. The existing staff publication action stays available in M1-01.
- Reuse the existing routes and payload structures, including the actor role field used for internal problem metadata.

Versioned schema migrations (M1-02), Tracks and DSA backfill (M1-03), premium entitlements (M1-04), and the community review lifecycle, automatic pre-check, moderation queue, and eligibility enforcement (M1-07) are out of scope. The five distinct Accepted problems and pending-item limit apply when an author submits a draft for review in M1-07. Draft creation in M1-01 requires an authenticated account and valid draft content.

## Acceptance Outcomes

- Eligible sessions for all three supported roles work. A signed access or refresh credential carrying an unsupported role is rejected, and Admin role assignment rejects unsupported values.
- A User with zero Accepted problems can create a draft. The author can read, edit, and delete their own hidden draft and manage its testcase package. Their Published contribution is read-only. Another User is denied access to the hidden draft. Staff can publish and hide it, and hiding restores author editing.
- An author can Run Code and create a Submission against their hidden draft through the existing metadata check. An unrelated User receives the existing not-found outcome. Private testcase inputs and expected outputs stay protected.
- Personal Submission history and SSE ticket issuance stay owner-scoped for all three roles. Staff retain their existing cross-owner detail access.

## Capabilities

### New Capabilities

### Modified Capabilities

- `identity-session` defines the role set and covers credential validation, protected access, and role assignment.
- `content-moderation` covers the Contributions workspace, draft ownership, and author testcase permissions.
- `problem-catalog` covers the own catalog, privileged detail, and internal metadata authorization for draft testing.
- `submission` covers supported roles for Submission creation, personal history, and source-bearing detail.
- `realtime-updates` covers supported roles for owner-only stream ticket issuance.

## Impact

Auth, shared RBAC and protected middleware, Envoy, Problem, Submission, and the website need the same supported role set. The design records the authorization contract changes and the local development data policy.

## Gate 1 Review

- **Approved five-capability exception.** The project owner approved keeping all five capabilities in this change as an exception to the workflow's three-capability maximum. Revising the specs together keeps the supported role set and authorization outcomes consistent across credential admission, draft authoring and reads, Submission access, and ticket issuance. [Gate 1 Round 2](review-gate1.md#round-2-review) · [Workflow §§4–5](../../../docs/process/workflow.md)
- **Approved ADR exception for M1-01.** The project owner accepted PRD D-01 and this change's design as sufficient documentation for retiring Contributor through the existing authorization and service boundaries. This is an exception to the separate ADR requirement in workflow §10 for M1-01. [Gate 1 Round 2](review-gate1.md#round-2-review) · [PRD Appendix B](../../../docs/product/prd.md#appendix-b--decision-log) · [Workflow §10](../../../docs/process/workflow.md#10-adrs)
