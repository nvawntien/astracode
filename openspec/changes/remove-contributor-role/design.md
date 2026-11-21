## Context

Auth owns account roles and issues credentials. Envoy verifies access JWTs and supplies identity headers to protected services. Problem owns problem visibility and author ownership, and Submission uses Problem's canonical metadata to authorize Run Code and official Submission creation. The existing authoring routes and Contributions workspace currently gate access on Contributor. [Architecture](../../../docs/codebase/ARCHITECTURE.md) · [Execution flows](../../../docs/codebase/FLOWS.md) · [Data ownership](../../../docs/codebase/DATA.md)

## Goals / Non-Goals

- Enforce the supported role set across credential and service boundaries. Check ownership and current visibility in Problem use cases. NFR-S01 covers authentication and NFR-S02 covers server-side authorization. [Quality targets](../../../docs/product/nfr.md)
- Retain existing HTTP routes, payload shapes, judge protocols, transactional outbox, and AttemptID correlation. See the proposal for milestone boundaries. [Proposal](proposal.md)

## Decisions

1. **Reuse existing Problem authoring routes.** Authenticate through the gateway and enforce ownership and current visibility in Problem use cases. Derive author identity from claims at creation and create a hidden draft. A User can list and read their own undeleted problems and read their testcase metadata. Content and package mutations require an owned, undeleted, hidden draft. Keep the own catalog scoped to the caller for every role. Moderator and Admin retain cross-author reads and mutations, staff catalog and taxonomy access, publication, and hiding.
2. **Use the same three role values at each trust boundary.** In Auth, validate the stored role before sign-in issues credentials, the token role during refresh, and the requested value during Admin assignment. Preserve refresh rate limits, account eligibility, session invalidation and supported-token reuse. Keep existing logout-all behavior. Envoy checks the JWT role alongside the existing signature and claim checks and replaces caller-supplied identity headers with verified values. Shared RBAC accepts only `user`, `moderator`, and `admin`. Protected service middleware rejects missing or unsupported role claims before invoking handlers. The existing private service boundary limits trusted identity headers to the gateway.
3. **Keep existing workspace and draft execution paths.** Enable Contributions for Users through the existing navigation and preserve sign-in return paths and staff routing. Run Code and Submission continue forwarding authenticated actor identity and role to internal Problem metadata. Problem validates the role and authorizes hidden metadata for its User owner, Moderator, or Admin, with the existing not-found result for unrelated Users. Submission checks supported roles on its protected use cases. Personal history and stream ticket issuance stay owner-scoped for all supported roles, while staff retain authorized cross-owner detail access. SSE stream admission continues to check the ticket's purpose, expiry, Submission, and owner.

## Contract Draft

| Interface | Compatibility | Proposed contract |
| --- | --- | --- |
| Auth role fields and `PUT /api/v1/admin/users/{user_id}/role` | **BREAKING** for allowed role values | Support `user`, `moderator`, and `admin`. Unsupported assignments use the existing invalid-role response. The request and response structures remain the same. |
| Access JWT at Envoy and refresh JWT at Auth | **BREAKING** for unsupported role claims | Reject unsupported roles, including `contributor`, even in an otherwise valid token. Keep token formats, the single-credential gateway rule, and existing refresh and invalidation semantics for eligible credentials. |
| `GET /api/v1/my/problems` and existing authoring and testcase routes under `/api/v1/admin/problems` | **NON-BREAKING** for paths and payloads | Users can create hidden drafts, read their own problems, and edit or delete their own hidden drafts and packages within the existing error and upload contracts. Publication, hiding, staff list, and taxonomy operations still require Moderator or Admin. During implementation, update authorization annotations in `envoy/routes.json` and regenerate with the checked-in generator. |
| Internal Problem `GetProblem` | **BREAKING** for unsupported actor roles, **NON-BREAKING** for protocol shape | The existing actor role field accepts `user`, `moderator`, and `admin`. A User can resolve Published problems and their own hidden drafts. Moderator and Admin can also resolve hidden drafts across authors. Absent or disallowed problems retain the not-found result. |
| Run Code, Submission creation, history and detail, and SSE ticket issuance | **BREAKING** for unsupported role claims, **NON-BREAKING** for paths and payloads | Draft execution uses canonical Problem metadata and existing limits. Personal history and ticket issuance stay owner-scoped, and a missing or other owner's Submission produces the same ticket not-found result. Staff detail retains its current access and response fields. |

## Risks / Trade-offs

- Divergent role lists can let one boundary admit a credential that another rejects. Exercise the same supported and unsupported values at Auth, Envoy, shared middleware, Problem metadata, and Submission.
- Authenticated Users can now upload testcase packages for their own hidden drafts. Keep existing ZIP structure and size checks, upload bounds, and worker-only access to private package data. Author-facing metadata excludes private inputs, expected outputs, storage locations, and download access. Run Code uses caller-supplied testcases and receives only canonical problem metadata.

## Development Data Policy

The project currently runs locally and has no production user data requiring preservation. Developers may reset local databases manually when needed. Database reset or deletion requires explicit manual execution.

## Documentation Impact

Assess the role and ownership descriptions in the codebase architecture, flows, data and service inventory, relevant service and website READMEs, and the Envoy configuration guide and generated route inventory. Record the affected passages and intended updates in the change's implementation evidence. [Architecture](../../../docs/codebase/ARCHITECTURE.md) · [Flows](../../../docs/codebase/FLOWS.md) · [Data](../../../docs/codebase/DATA.md) · [Services](../../../docs/codebase/SERVICES.md) · [Envoy guide](../../../envoy/README.md)

### Archive disposition

The project owner approved preserving scenario headings that OpenSpec requires by name. The WHEN and THEN clauses define the revised role behavior. The stale labels are the Contributor references in six `content-moderation` and two `problem-catalog` scenario headings, plus the `problem-catalog` heading “Base User cannot access Hidden metadata,” whose scenario applies to another author's draft. The existing `content-moderation` Purpose still says “Contributor ownership” and should say “author ownership.” [Gate 1 Round 2](review-gate1.md#round-2-review) · [Content moderation delta](specs/content-moderation/spec.md) · [Problem catalog delta](specs/problem-catalog/spec.md) · [Current Purpose](../../specs/content-moderation/spec.md#purpose)

At archive, record the disposition of the headings and Purpose. Use a supported archive operation for wording cleanup only if it preserves every scenario and passes strict validation. OpenSpec 1.13.0 rejects renamed scenario headings in MODIFIED requirements and retains the existing Purpose. If those constraints still apply at archive, preserve the text and record it for a subsequent documentation-only OpenSpec change. Make main-spec updates through the archive workflow.
