## Context

Auth owns account roles in PostgreSQL and applies per-account session cutoffs in Redis. Login reads the stored role. Refresh validates the account and cutoff, then copies the role from the presented token. Envoy checks the JWT role against its own allowlist. Problem owns problem records and uses the account ID for author ownership. The current router, authoring use cases, and website each use Contributor as an admission check. See [Architecture](../../../docs/codebase/ARCHITECTURE.md), [Execution flows](../../../docs/codebase/FLOWS.md), and [Data ownership](../../../docs/codebase/DATA.md).

## Goals / Non-Goals

**Goals**

- Enforce the supported role set at the trust boundaries and use ownership and current visibility in authoring use cases. NFR-S01 covers authentication, and NFR-S02 covers server-side role and ownership checks. See [Quality targets](../../../docs/product/nfr.md).
- Convert account roles and revoke old sessions without reassigning any problem, Testcase package, or Submission.

**Non-Goals**

- Track and entitlement models, the review lifecycle, route renaming, and changes to judge protocols or attempt processing. See [proposal.md](proposal.md) for the milestone boundaries.

## Decisions

1. **Keep shared authoring routes and centralize ownership rules in Problem.** Require verified gateway identity at HTTP admission. At the use case, a User must own the problem for authoring reads and must also have a hidden, undeleted draft for writes. Derive ownership from claims at create time. Moderator/Admin cross-author operations continue through the same handlers with their existing staff checks. Keep the list of one's own problems owner-scoped for every role. Reuse the existing separation between owner-authoring and staff-only operations so existing clients can keep their routes and payloads.
2. **Make the role set explicit at each identity boundary.** Keep only `user`, `moderator`, and `admin` in shared RBAC, Envoy's generated allowlist, Auth role assignment and refresh admission, and website role selection. Reject unsupported roles in protected service middleware and in the internal Problem metadata use case. Credential invalidation applies to every old session belonging to a migrated account, while explicit role rejection also covers a Contributor token issued to an account whose stored role changed before migration. Valid refresh credentials for supported roles retain their existing refresh semantics.
3. **Keep existing workspace and draft testing paths.** Show Contributions navigation for User accounts and keep sign-in return paths and staff routing. Change the internal hidden-problem check from role-plus-ownership to recognized identity-plus-ownership, retaining the staff override and existing not-found response for other users. Submission and Run already use that canonical check. The existing owner-only checks for Submission history and stream tickets continue to apply.
4. **Use a one-time Auth data conversion.** The current repository has no versioned migration runner. The change updates values in the existing role column through an Auth-owned command with a read-only preview. Reuse the session cutoff store and Auth's database access. Record a cutoff for all affected accounts before committing role updates, with failure and retry behavior given below.

## Contract Draft

| Interface | Compatibility | Proposed contract |
| --- | --- | --- |
| Auth HTTP role fields and `PUT /api/v1/admin/users/{user_id}/role` | **BREAKING** | `role` supports `user\|moderator\|admin`. Admin requests assigning `contributor` return the existing invalid-role response. Successful login and account reads return a supported role. |
| Access JWT at Envoy and refresh JWT at Auth | **BREAKING** | Reject `role=contributor` even with a valid signature. Reject credentials at or before the cutoff for migrated accounts. Existing token formats and the single-credential gateway policy continue. |
| `GET /api/v1/my/problems` and existing single-problem authoring, create/update/delete, and Testcase routes under `/api/v1/admin/problems` | **NON-BREAKING** for paths and payloads | An authenticated User can create a hidden draft, list and read their own problems, and change an owned hidden draft or its Testcase package. Other-author and disallowed writes retain the existing errors. Publish, hide, staff list, and taxonomy mutations retain their staff permissions. Update the authorization entries in `envoy/routes.json`, and regenerate Envoy output through the checked-in generator. |
| Internal Problem `GetProblem` | **BREAKING** for old role values, **NON-BREAKING** for protocol shape | The existing actor role field accepts `user\|moderator\|admin`. A User can resolve their own hidden problem. Staff can resolve any allowed hidden problem. Guests and unrelated Users cannot resolve a hidden problem. |
| Submission history/detail and stream ticket issuance | **BREAKING** for retired credentials, **NON-BREAKING** for payloads | A migrated User can still list and read their own Submissions and request tickets for them. A ticket request for another account's Submission retains the existing not-found outcome even for staff. |

## Risks / Trade-offs

- A mixed release could let an old Auth instance issue Contributor tokens after a cutoff. Rehearse the conversion in isolation and coordinate the release so old issuers and protected requests are held until the role conversion and runtime changes are in place.
- Redis and PostgreSQL have separate commit boundaries. Complete all required cutoff writes before committing any role conversion. A failure can sign out affected accounts early, while their stored roles remain eligible for a retry. Retain any already recorded cutoff and use the later of the existing value and cutover time.
- Any authenticated User will be able to create drafts and upload valid Testcase packages. Keep existing upload bounds and private package access restrictions. M1-07 owns admission limits for sending drafts into review.

## Migration Plan

1. Rehearse on a local stack and report only aggregate counts. Select accounts by their current stored Contributor role. Include suspended accounts and keep verification and suspension state.
2. With old token issuance and authenticated requests drained at cutover, record a per-account cutoff using the existing refresh-lifetime expiry. Update selected rows conditionally from `contributor` to `user` in one transaction after the cutoff writes succeed. Verify the remaining Contributor count is zero. A repeat run after success selects zero rows and leaves new sessions valid.
3. Admit traffic with coordinated Auth, Envoy, Problem, Submission, and website versions. Verify that old access and refresh credentials fail, that a fresh User session can open the author's prior data, and that unaffected accounts can still refresh. Existing short-lived Submission stream tickets retain their admission rules and expiry.
4. If conversion fails before commit, retain the recorded cutoffs and rerun the forward conversion. After commit, use a compatible forward fix or a coordinated recovery that preserves the converted roles and cutoffs. Restoring Contributor permissions would require restoring the exact migrated cohort and a separate decision.

## Documentation Impact

Update [Architecture](../../../docs/codebase/ARCHITECTURE.md), [Execution flows](../../../docs/codebase/FLOWS.md), [Data ownership](../../../docs/codebase/DATA.md), [Service inventory](../../../docs/codebase/SERVICES.md), the relevant service and website READMEs, and [Envoy's configuration guide](../../../envoy/README.md). Use the Envoy route generator for the generated route documentation.

## Open Questions

- Where should M1-07 measure the five Accepted problems? Use distinct published problem IDs and specify how to handle problems that are later hidden. This decision belongs to the review lifecycle change and does not affect the pilot's existing draft execution paths.
