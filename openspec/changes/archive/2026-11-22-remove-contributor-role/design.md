## Context

Auth owns account roles and issues credentials. Envoy verifies access JWTs and supplies identity headers to protected services. Problem owns problem visibility and author ownership, and Submission uses Problem's canonical metadata to authorize Run Code and official Submission creation. The existing authoring routes and Contributions workspace currently gate access on Contributor. [Architecture](../../../docs/codebase/ARCHITECTURE.md) · [Execution flows](../../../docs/codebase/FLOWS.md) · [Data ownership](../../../docs/codebase/DATA.md)

## Goals / Non-Goals

- Enforce the supported role set across credential and service boundaries. Check ownership and current visibility in Problem use cases. NFR-S01 covers authentication and NFR-S02 covers server-side authorization. [Quality targets](../../../docs/product/nfr.md)
- Retain existing HTTP routes, payload shapes, judge protocols, transactional outbox, and AttemptID correlation. See the proposal for milestone boundaries. [Proposal](proposal.md)

## Decisions

1. **Reuse existing Problem authoring routes.** Authenticate through the gateway and enforce ownership and current visibility in Problem use cases. Derive author identity from claims at creation and create a hidden draft. A User can list and read their own undeleted problems and read their testcase metadata. Content and package mutations require an owned, undeleted, hidden draft. Keep the own catalog scoped to the caller for every role. Moderator and Admin retain cross-author reads and mutations, staff catalog and taxonomy access, publication, and hiding.
2. **Use the same three role values at each trust boundary.** In Auth, validate the stored role before sign-in issues credentials, the token role during refresh, and the requested value during Admin assignment. Preserve refresh rate limits, account eligibility, session invalidation and supported-token reuse. Keep existing logout-all behavior. Envoy checks the JWT role alongside the existing signature and claim checks and replaces caller-supplied identity headers with verified values. Shared RBAC accepts only `user`, `moderator`, and `admin`. Protected service middleware rejects missing or unsupported role claims before invoking handlers. The existing private service boundary limits trusted identity headers to the gateway.
3. **Keep existing workspace and draft execution paths.** Enable Contributions for Users through the existing navigation and preserve sign-in return paths and staff routing. Run Code and Submission continue forwarding authenticated actor identity and role to internal Problem metadata. Problem validates the role and authorizes hidden metadata for its User owner, Moderator, or Admin, with the existing not-found result for unrelated Users. Submission checks supported roles on its protected use cases. Personal history and stream ticket issuance stay owner-scoped for all supported roles, while staff retain authorized cross-owner detail access. SSE stream admission continues to check the ticket's purpose, expiry, Submission, and owner.

## Concurrent Problem and testcase mutations

The project owner approved this design extension on 2026-11-21 for tasks 2.1 and 2.3 and confirmed the focused Gate 1 addendum for CM-20 at commit `1cfbda7`. The original Gate 1 review records the role-model approval. [CM-20 delta](specs/content-moderation/spec.md#requirement-cm-20-testcase-package-deletion) · [Review evidence](progress.md)

### PostgreSQL transaction scope

Use a Problem-owned GORM transaction at PostgreSQL READ COMMITTED. A narrow internal repository operation locks the undeleted Problem row with `SELECT … FOR UPDATE` and provides the current state to the use case. Edit, soft delete, publish, hide, and testcase metadata mutations acquire the same row lock before their authoritative state and permission checks. A User mutation requires the current owner and Hidden state. Staff keep their existing cross-author permissions and publication checks.

Use the same transaction handle for the locked read, any Problem or tag reads used to decide the write, the Problem update and tag synchronization, and any testcase metadata read or write in that operation. Extend the existing repository methods to participate in the enclosing transaction. Publish or hide observes a preceding committed edit, and a subsequent edit observes the committed visibility. Soft deletion preserves testcase metadata and storage. Invalidate the existing canonical metadata cache after a successful Problem commit. ZIP validation, MinIO transfers and cleanup, and cache invalidation all run outside the transaction.

### Testcase package lifecycle

1. **Stage uploads.** Check role, ownership, and visibility before ZIP processing. Validate the ZIP with the existing limits and upload to a fresh immutable key under the Problem's testcase prefix. Use a unique key per upload, including when package version numbers are reused.
2. **Attach or replace.** Once upload finishes, acquire the Problem row lock and check permission again. Read current testcase metadata using the same transaction. Assign version one when metadata is absent and increment the current version for replacement. Upsert the new key, version, and count together. A confirmed commit makes the new object current. The previous key becomes a candidate for reconciliation.
3. **Delete logically.** Under the same lock, check permission, read the current key, and remove the metadata row. A confirmed commit returns success through the existing HTTP response. A missing row retains the existing missing-package outcome. The delete request does not remove the stored object. The object stays eligible for the manual reconciler described under Orphan-object reconciliation, so a later cleanup failure cannot change the confirmed deletion result. Metadata rollback leaves the previous package current.
4. **Handle staging and commit failures.** A staged key that definitely never became current can be removed outside the transaction once its upload is settled. Keep all possibly referenced keys when commit is uncertain. Record definite staging cleanup failures and unresolved commits for reconciliation using internal identifiers, without logging signed URLs or package contents.

### Orphan-object reconciliation

Use a manual local maintenance window and the existing Problem testcase object listing and removal operations.

1. Quiesce testcase writers and worker download URL issuers on every Problem instance that uses the bucket. Wait for their requests and transactions to settle. Record that time as the start of the retention window and keep those paths paused through cleanup.
2. Wait the full 15-minute presigned URL lifetime plus the worker's 30-second download timeout and the maximum clock skew between the issuer and MinIO. For example, wait at least 16 minutes when the verified skew bound is 30 seconds. Defer cleanup if the window or quiescence cannot be established. An object's modification time alone gives no evidence about when its last download URL was issued.
3. Read every current package key from the primary Problem database using `SELECT DISTINCT zip_object_key FROM test_cases`. Include metadata for soft-deleted Problems. After quiescence, this complete read resolves references from previously uncertain commits. List the managed keys in the private Problem testcase prefixes in MinIO. Produce a dry-run list of keys in storage and absent from the complete reference set. A failed or incomplete database read or storage listing stops cleanup.
4. Refresh the primary reference set before deleting the reviewed, exact candidate keys while writers remain paused. Keep referenced keys and unresolved candidates. Record removal failures for a later run, using a fresh retention and reference check for each retry. Resume service access after the maintenance window.

For this manual procedure, run `go run ./cmd/reconcile-testcase-objects -quiesced-at "$TESTCASE_DRAINED_AT" -max-clock-skew "$TESTCASE_CLOCK_SKEW_BOUND"` from `services/problem` with a local configuration. Save the JSON candidate array and review the exact keys. Rerun with the same verified quiescence inputs and `-apply-reviewed <reviewed.json>` while the services remain paused. The command requires loopback PostgreSQL and MinIO endpoints and uses the existing tables and bucket. An apply failure identifies keys to recheck during the next reconciliation.

### Worker official testcase cache

Use the existing download URL to distinguish immutable objects. Derive cache identity from the Problem ID and a digest of the storage origin and object path, excluding the signature query and fragment. Apply the existing version, ZIP checksum, and extracted-testcase checks to the cache entry for that object. A fresh signature for the same object can reuse its entry. A new object with version one gets its own entry.

Stage each cache fill in a unique directory, validate it, and atomically publish a reference to the complete generation on the same filesystem. Resolve that reference once per load and return input paths inside the resolved generation. Concurrent fills and refreshes of a corrupt entry can publish a new generation while earlier loads and active jobs retain their paths. A failed fill cleans up only its private staging directory. Reclaim old generations, including legacy cache directories, only after draining every worker and executor that shares the cache volume.

The extension uses existing HTTP and gRPC routes and payloads, PostgreSQL schemas, judging protocols, and the Submission transactional outbox. The observable cleanup-failure outcome is described in CM-20.

## Contract Draft

| Interface | Compatibility | Proposed contract |
| --- | --- | --- |
| Auth role fields and `PUT /api/v1/admin/users/{user_id}/role` | **BREAKING** for allowed role values | Support `user`, `moderator`, and `admin`. Unsupported assignments use the existing invalid-role response. The request and response structures remain the same. |
| Access JWT at Envoy and refresh JWT at Auth | **BREAKING** for unsupported role claims | Reject unsupported roles, including `contributor`, even in an otherwise valid token. Keep token formats, the single-credential gateway rule, and existing refresh and invalidation semantics for eligible credentials. |
| `GET /api/v1/my/problems` and existing authoring and testcase routes under `/api/v1/admin/problems` | **NON-BREAKING** for paths and payloads | Users can create hidden drafts, read their own problems, and edit or delete their own hidden drafts and packages. Publication, hiding, staff list, and taxonomy operations still require Moderator or Admin. During implementation, update authorization annotations in `envoy/routes.json` and regenerate with the checked-in generator. |
| Testcase package deletion (CM-20) | **BREAKING** for the storage-cleanup failure outcome, **NON-BREAKING** for the HTTP route and payloads | A confirmed metadata deletion succeeds. Subsequent reads report the package missing. Physical cleanup failure leaves that result in effect, and the object can be reconciled later. Report metadata removal failure or an unconfirmed commit as an error. |
| Internal Problem `GetProblem` | **BREAKING** for unsupported actor roles, **NON-BREAKING** for protocol shape | The existing actor role field accepts `user`, `moderator`, and `admin`. A User can resolve Published problems and their own hidden drafts. Moderator and Admin can also resolve hidden drafts across authors. Absent or disallowed problems retain the not-found result. |
| Run Code, Submission creation, history and detail, and SSE ticket issuance | **BREAKING** for unsupported role claims, **NON-BREAKING** for paths and payloads | Draft execution uses canonical Problem metadata and existing limits. Personal history and ticket issuance stay owner-scoped, and a missing or other owner's Submission produces the same ticket not-found result. Staff detail retains its current access and response fields. |

## Risks / Trade-offs

- Divergent role lists can let one boundary admit a credential that another rejects. Exercise the same supported and unsupported values at Auth, Envoy, shared middleware, Problem metadata, and Submission.
- Authenticated Users can now upload testcase packages for their own hidden drafts. Keep existing ZIP structure and size checks, upload bounds, and worker-only access to private package data. Author-facing metadata excludes private inputs, expected outputs, storage locations, and download access. Run Code uses caller-supplied testcases and receives only canonical problem metadata.
- Retained objects and cache generations consume space between maintenance windows. Use the reconciliation procedure and drain shared cache users before removing generations.

## Development Data Policy

The project currently runs locally and has no production user data requiring preservation. Developers may reset local databases manually when needed. Database reset or deletion requires explicit manual execution.

## Documentation Impact

Assess the role and ownership descriptions in the codebase architecture, flows, data and service inventory, relevant service and website READMEs, and the Envoy configuration guide and generated route inventory. Record the affected passages and intended updates in the change's implementation evidence. [Architecture](../../../docs/codebase/ARCHITECTURE.md) · [Flows](../../../docs/codebase/FLOWS.md) · [Data](../../../docs/codebase/DATA.md) · [Services](../../../docs/codebase/SERVICES.md) · [Envoy guide](../../../envoy/README.md)

### Archive disposition

The project owner approved preserving scenario headings that OpenSpec requires by name. The WHEN and THEN clauses define the revised role behavior. The stale labels are the Contributor references in six `content-moderation` and two `problem-catalog` scenario headings, plus the `problem-catalog` heading “Base User cannot access Hidden metadata,” whose scenario applies to another author's draft. The existing `content-moderation` Purpose still says “Contributor ownership” and should say “author ownership.” [Gate 1 Round 2](review-gate1.md#round-2-review) · [Content moderation delta](specs/content-moderation/spec.md) · [Problem catalog delta](specs/problem-catalog/spec.md) · [Current Purpose](../../specs/content-moderation/spec.md#purpose)

At archive, record the disposition of the headings and Purpose. Use a supported archive operation for wording cleanup only if it preserves every scenario and passes strict validation. OpenSpec 1.13.0 rejects renamed scenario headings in MODIFIED requirements and retains the existing Purpose. If those constraints still apply at archive, preserve the text and record it for a subsequent documentation-only OpenSpec change. Make main-spec updates through the archive workflow.
