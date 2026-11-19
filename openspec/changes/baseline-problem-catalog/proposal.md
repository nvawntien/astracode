# Proposal

## Why

The current coding problem catalog has no capability spec. Record its implemented behaviour so later changes can distinguish existing rules and quirks from proposed product behaviour.

## What Changes

- Add the `problem-catalog` baseline, using only ADDED requirements grounded in current code.
- Cover public visibility, listing, pagination, search, difficulty and tag filters, statement structure, configured limits, privileged read visibility, and tag taxonomy administration and seeding.
- Include one evidence-table row per requirement, known findings, unresolved questions, and review-only tasks.
- Make no runtime, interface, dependency, architecture, or main-spec changes. This records behaviour; it does not implement or repair it.

### Scope boundaries

The catalog owns read visibility, including the existing own-catalog and staff-catalog exceptions, and tag taxonomy. Draft authoring, testcase upload, and publish/hide belong to `content-moderation`; they are referenced here only by that capability name.

## Capabilities

### New Capabilities

- `problem-catalog`: Baseline of coding problem discovery, statements, limits, access visibility, and tag taxonomy. The capability is new to OpenSpec; its behaviour already exists.

### Modified Capabilities

None. `openspec list --specs` reports no existing specs.

## Impact

- Changed files are confined to `openspec/changes/baseline-problem-catalog/`.
- Source evidence comes principally from `services/problem/`, with shared request-binding and role helpers and the read-only gateway inventory checked where necessary.
- Contract classification: **NON-BREAKING** documentation only; no contract changes or drafts are needed.
- Documentation impact: this change's artifacts only. No architecture documents, code, main specs, other changes, or production configuration are updated.
- No F-xx, NFR-xx, or ADR ID was supplied as a governing target; none is invented or claimed as satisfied.

## Findings

1. **Legacy role remains enforced.** The glossary marks Contributor as deprecated, but the running composition, role hierarchy, and own/private catalog reads still use it. The baseline retains that observed role rather than replacing it with User.
2. **Public listing returns full statements.** Listing and detail share the same public mapping, including statement prose, examples, constraints, hints, and limits. There is no catalog teaser, track, or Premium entitlement decision in this read path. This is evidence of current access behaviour, not proof of the glossary's future track/entitlement model.
3. **Tag visibility differs by read.** The public tag directory and public tag filter require active tags, but tags attached to returned problems are loaded without an active-only restriction. An inactive attached tag can therefore appear on a public problem even though that tag is absent from the public directory and cannot match the public tag filter.
4. **Difficulty validation differs by layer.** Public request binding accepts the exact lower-case values `easy`, `medium`, and `hard`; the application subsequently trims and lowercases difficulty. Upper-case or padded non-empty public values fail binding before normalization. The baseline describes the public boundary.
5. **Possible initially-inactive tag persistence bug.** Creation accepts an inactive flag, but the persistence model uses a non-pointer boolean with `default:true`. GORM's create callback substitutes that default for a zero boolean, while the repository does not copy the resulting active flag back to the returned entity. This suggests a create response and later reads can disagree. No database execution was used to confirm this case; the spec does not promise successful initially-inactive creation. Updates explicitly write boolean values and do not have this particular ambiguity.
6. **Internal visibility can use recently cached metadata.** Internal metadata access checks the caller on every request, but its configured metadata cache lasts five seconds. This baseline does not promise immediate visibility changes across every read surface.

## Open questions

- **Q1 — Initially-inactive creation:** What does the current PostgreSQL-backed create/read round trip return when a new tag is requested inactive? Finding 5 is supported by source inspection, but a database-backed reproduction is still needed before specifying that corner case.
- **Q2 — Installed taxonomy:** Which curated seed definitions are actually installed in a running environment? Code establishes the optional seed operation and preservation rules, not the contents of any deployed catalog. No fixed deployed tag inventory is required here.
- **Q3 — Limit units:** Which units are authoritative for the configured numeric time and memory limits across consumers? The catalog model and response mapping do not declare units. This baseline requires unchanged values and does not infer units, conversion, or execution enforcement.

These unanswered points are excluded from normative claims. Their resolution is a review task; it does not authorize code changes or expansion into `content-moderation`.
