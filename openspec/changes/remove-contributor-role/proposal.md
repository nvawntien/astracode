Implements: F-01 (role removal), F-03 (draft authoring) | Addresses: NFR-S01, NFR-S02

## Why

Problem authors currently need an Admin to assign the Contributor role before they can draft a problem. Removing that role lets verified Users prepare their own drafts and leaves staff responsible for moderation.

## What Changes

- **BREAKING** Remove `contributor` from the supported authorization roles. Convert existing Contributor accounts to User, preserve their IDs and authored data, and require affected accounts to sign in again.
- Open the existing Contributions workspace and authenticated draft operations to Users. Users may manage their own hidden drafts and Testcase packages, and read their own Published problems in the workspace.
- Keep publication, hiding, staff catalog access, and taxonomy changes restricted to Moderator and Admin. Retain the existing staff publication action for the pilot.
- Preserve owner-scoped solution history, live updates, and access to problem metadata for draft testing after the migration.

Out of scope for M1-01 are track persistence and DSA backfill (M1-03), premium entitlements (M1-04), and submitting a problem for review, automatic pre-check, review queues, and review decisions (M1-07). M1-07 remains responsible for requiring a verified email, five distinct Accepted problems, access to the target track, and fewer than three pending items at submission time.

## Capabilities

### New Capabilities

### Modified Capabilities

- `identity-session` covers supported roles, existing account conversion, and credential rejection at cutover.
- `content-moderation` covers the Contributions workspace, draft ownership, and author Testcase permissions.
- `problem-catalog` covers own-catalog access, author-specific detail, and internal visibility for draft testing.
- `submission` covers the supported roles for owner history and source-bearing detail and retains the staff boundary.
- `realtime-updates` covers the supported roles for owner-only stream ticket issuance.

## Impact

Auth, shared RBAC and middleware, Envoy, Problem, Submission, and the website consume the supported role list. The Auth-owned data conversion updates existing account roles. Existing protected HTTP paths and the role field in the internal problem metadata request are reused.

## Open Questions and Suggested Answers

| Question | Suggested answer used by this proposal |
| --- | --- |
| When should the five-solved requirement and pending limit apply? | Apply both when the User submits a draft for review in M1-07. Verified Users can prepare drafts during the pilot. |
| How should staff publish during the pilot? | Keep the existing Moderator/Admin publication action. Add the required automatic pre-check and review gate for community problems in M1-07, including enforcement on existing publication paths. |
| Should affected users have to sign in again? | Revoke pre-cutover sessions for migrated accounts and reject credentials carrying `contributor`. This provides a clear cutover and preserves existing refresh behavior for the supported roles. |
| Should private draft solves count toward future contribution eligibility? | Preserve existing draft testing during the pilot. For M1-07, count distinct Accepted problems from the published catalog so draft testing cannot satisfy the activity requirement. Define the exact counting rule in that change. |
