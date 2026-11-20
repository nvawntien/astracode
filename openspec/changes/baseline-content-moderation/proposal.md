# Proposal

## Why

Record the current content-moderation behavior at source revision `728aef2` so later changes can distinguish existing Contributor authoring and Moderator/Admin actions from the planned community review workflow. This is a documentation baseline: all requirements are ADDED to a new capability, with no implementation changes.

## What Changes

- Add `content-moderation` requirements for Contributor drafts and ownership, structured coding-problem authoring, draft testcase packages, publish/hide, and administrative problem/tag management.
- Record both server-side decisions and the Contributor Workspace/Admin Console behavior, including current validation differences.
- Add one implementation-evidence row per requirement and review-only tasks.
- Keep catalog read behavior owned by `problem-catalog`; reference that capability without specifying its behavior.

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
2. **Execution-limit mismatch:** creation defaults a missing/nonpositive time limit to `1000` and memory to `256`, with no upper-bound validation on positive creation values. Editing accepts time greater than zero and at most `30`, and memory from `16` to `1024`; the website defaults time to `1` and applies the edit bounds to creation too. These values are recorded as observed, not corrected.
3. **Publication has no package/pre-check gate:** publish checks attached tags for inactivity but does not load a testcase package, require a Reference solution, run an Automatic pre-check, or require a review decision. Moderators/Admins may edit Published problems and change their packages directly.
4. **Package validation is structural:** upload inspects archive entries and declared uncompressed sizes; it does not read/decompress entry payloads to verify their contents or checksums. No payload-integrity guarantee is specified.
5. **Package operations are not atomic across storage and metadata:** replacement cleanup is best effort, versions are computed from a read without a concurrency guard, and deletion removes the stored package before deleting its metadata. Deleting a problem only soft-deletes that problem; its use case performs no testcase-package cleanup. No atomicity, concurrent-upload safety, or cleanup-completion guarantee is specified.
6. **Possible slug reuse conflict:** slug availability reads exclude soft-deleted problems while the slug uniqueness declaration is unconditional. Reusing a deleted problem's slug may therefore fail at persistence instead of receiving an automatically suffixed slug. Runtime reproduction is not claimed.
7. **Inactive tag creation mismatch:** the configured GORM create path substitutes the boolean default `true` for an explicitly requested `false`, while the response maps the original entity and reports `false`. A later database read therefore returns an active tag. This conclusion follows from source inspection of GORM v1.31.1 and has not been checked against a running database.

## Open questions

- **OQ-2 — Concurrent package replacement and failure recovery:** which package survives simultaneous uploads or an object/metadata partial failure in a running deployment? No concurrency/fault-injection evidence was found; requirements cover the sequential successful path and explicit error handling only.
- **OQ-3 — Future moderation workflow:** when, if ever, will Eligible user submission, Pending/Claim/review decisions, Reference solutions, and Automatic pre-check replace the implemented Contributor/hidden-state workflow? No current implementation was found for those behaviors in the inspected authoring paths, so they are not requirements of this baseline.
