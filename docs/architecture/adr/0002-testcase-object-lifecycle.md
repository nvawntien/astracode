# ADR-0002: Testcase package objects are immutable, and a manual reconciler reclaims them

- **Status:** Accepted (instructed by the project owner on 2026-11-22; the reviewer confirms this when the PR merges, per workflow §10)
- **Decision date:** 2026-11-21, design approval for `remove-contributor-role`
- **Scope:** testcase ZIP objects in MinIO, `test_cases.zip_object_key`, and the operator command `services/problem/cmd/reconcile-testcase-objects`

## Context

Workers download testcase ZIPs through presigned URLs that last 15 minutes. The worker's download timeout is 30 seconds, and the issuer and MinIO can disagree on the clock. Replacing or deleting a package must not break a download that is already in flight. Deletion is logical: the metadata row goes away, and the object does not.

## Options

The approved design records the chosen approach. The alternatives below are the ones it rules out by its wording; they were not argued in a separate record.

- **A. Immutable keys, metadata-first deletion, manual reconciler (chosen).** Each upload gets a fresh key `problems/<id>/testcases/<random>.zip`. Deletion removes only the metadata row. Reclaiming objects is a manual procedure with a retention window and reviewed exact keys.
- **B. Physical delete after the metadata commit (ruled out).** Breaks downloads issued before the commit, which may still be inside the retention window.
- **C. Reuse one key per version, such as `v<N>.zip` (ruled out).** Concurrent uploads collide, and an already-signed URL can fetch different content.
- **D. Automated background cleanup (not chosen for this change).** The design chose a manual procedure.

## Decision

- Uploads stage the object under a fresh key before the Problem row lock (see ADR-0001). The lock then attaches or replaces the metadata row.
- Deletion removes only the metadata row. The request does not touch the object.
- Reclamation requires all of the following, enforced by `ReconcileObjects`:
  1. Writers and URL issuers are quiesced for the full window: 15 minutes (`judge.TestcaseDownloadURLLifetime`) + 30 seconds (`judge.TestcaseDownloadTimeout`) + the verified clock-skew bound. Cleanup is refused if the window cannot be established.
  2. The reference set is read from `test_cases` including soft-deleted Problems. Any failed read or listing stops cleanup.
  3. A dry run lists candidates. A second run with `-apply-reviewed` removes only those exact keys, after a fresh reference check.
  4. The command requires loopback PostgreSQL and MinIO endpoints.

## Trade-offs

- Unreferenced objects accumulate between maintenance windows.
- Reclamation needs a quiet period for testcase writers and URL issuers, which is an operational cost.
- Automation is not provided. Anyone who wants it must revisit this decision, since the retention rule is a hard invariant.

## Consequences

- `docs/codebase/DATA.md` and `docs/codebase/TECH_DEBT.md` describe the procedure and the open debt.
- `docs/codebase/FLOWS.md` describes the upload and delete flow.
- The retention constants live in `pkg/judge/limits.go` and must stay aligned with the presigned URL lifetime and the worker timeout.

## Links

- `openspec/changes/remove-contributor-role/design.md`, "Testcase package lifecycle" and "Orphan-object reconciliation"
- `openspec/changes/remove-contributor-role/specs/content-moderation/spec.md`: CM-20
- ADR-0001 for the transaction that orders the metadata deletion
