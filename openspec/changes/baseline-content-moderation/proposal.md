# Proposal

## Why

Record the current content-moderation behavior at source revision `728aef2` so later changes can distinguish existing Contributor authoring and Moderator/Admin actions from the planned community review workflow. This is a documentation baseline: all requirements are ADDED to a new capability, with no implementation changes.

## What Changes

- Add `content-moderation` requirements for Contributor drafts and ownership, structured coding-problem authoring, testcase packages, publish/hide, and administrative problem management.
- Record both server-side decisions and the Contributor Workspace/Admin Console behavior, including current validation differences.
- Add one implementation-evidence row per requirement and review-only tasks.
- Depend on `problem-catalog` for own and staff listing, privileged problem reads, and tag taxonomy. This baseline covers how those results are used in the management UI, tag assignment during authoring, and the inactive-tag publication check.

## Capabilities

### New Capabilities

- `content-moderation`: Baseline of existing coding-problem authoring, draft/package ownership and administrative content actions. “New” describes the spec inventory, not new application functionality.

### Modified Capabilities

None.

## Impact

- **NON-BREAKING** documentation only. No API, event, schema, gateway, dependency, runtime, or production-configuration changes.
- Read-only evidence comes from `services/problem/`, the Contributor Workspace and Admin Console in `website/`, and the shared role/request-binding helpers used by those paths.
- The four requested `docs/codebase/` documents provide context; source code, not those descriptions, supports each requirement. The root `AGENTS.md` applies; no module-specific `AGENTS.md` was found in the inspected areas.
- All repository edits stay inside `openspec/changes/baseline-content-moderation/`. No main spec edits, implementation, merge, or archive is included.
- No feature, NFR, or ADR identifier was supplied for this baseline; none is inferred from future product documents.

## Findings

1. **Terminology drift:** the glossary marks Contributor deprecated, but both the service and website still implement that role. The baseline uses Contributor in that existing-code sense. The current lifecycle is hidden/published, not Pending, Claim, In review, Changes requested, or Rejected. A previously Published problem that is Hidden becomes editable by its Contributor author again.
2. **Execution-limit mismatch:** creation defaults a missing or nonpositive time limit to `1000` and memory to `256`, with no upper-bound validation on positive creation values. Editing accepts time greater than zero and at most `30`, and memory from `16` to `1024`. New website forms use time `1` and memory `256`. The browser applies time `1`–`30` in increments of `0.5` and memory `16`–`1024` in both modes.
3. **Publication has no package/pre-check gate:** publish checks attached tags for inactivity but does not load a testcase package, require a Reference solution, run an Automatic pre-check, or require a review decision. Moderators/Admins may edit Published problems and change their packages directly.
4. **Package validation is structural:** upload checks a running sum of declared uncompressed sizes in a fixed-width counter. The counter has no overflow check. The upload validator does not decompress entry payloads or verify their contents or checksums.
5. **Package operations are not atomic across storage and metadata:** replacement cleanup is best effort, versions are computed from a read without a concurrency guard, and deletion removes the stored package before deleting its metadata. Deleting a problem only soft-deletes that problem; its use case performs no testcase-package cleanup. No atomicity, concurrent-upload safety, or cleanup-completion guarantee is specified.
6. **Possible slug reuse conflict:** slug availability reads exclude soft-deleted problems while the slug uniqueness declaration is unconditional. Reusing a deleted problem's slug may therefore fail at persistence instead of receiving an automatically suffixed slug. Runtime reproduction is not claimed.
7. **Inactive tag creation mismatch (confirmed on isolated PostgreSQL 15.6):** a valid Moderator request with `is_active=false` returned HTTP 201 and an inactive response. The DAO entered GORM as `false`, but the v1.31.1 create callback bound `true` for the insert. Both a direct query and the tag repository reread returned `true`. Omitted activation returned and persisted `true` in the control case. This is an observed taxonomy defect. Its evidence is recorded in `review.md`; taxonomy requirements belong to `problem-catalog`.

## Open questions

- **OQ-2 — Concurrent package replacement and failure recovery:** which package survives simultaneous uploads or an object/metadata partial failure in a running deployment? No concurrency/fault-injection evidence was found; requirements cover the sequential successful path and explicit error handling only.

The planned review workflow remains outside this baseline. The current authoring paths use Contributor ownership and hidden/Published state.
