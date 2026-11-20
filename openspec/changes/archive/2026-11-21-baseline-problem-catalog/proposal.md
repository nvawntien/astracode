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
5. **Initially-inactive tag creation mismatch.** Creation accepts an inactive flag, but the persistence model uses a non-pointer boolean with `default:true`. GORM's create callback substitutes that default for a zero boolean, while the repository copies back only the ID and timestamps. The isolated PostgreSQL result in Q1 confirms the discrepancy. Updates explicitly write boolean values.
6. **Internal visibility can use recently cached metadata.** Internal metadata access checks the caller on every request, but its configured metadata cache lasts five seconds. This baseline does not promise immediate visibility changes across every read surface.

## Resolved review questions

- **Q1 — Initially-inactive creation.** The isolated PostgreSQL 15.6 probe recorded in the M0-05 review at `3faa936` exercised the same handler, use case, repository and GORM v1.31.1. A request with `is_active=false` returned HTTP 201 and `false`. GORM inserted `true`, which a direct database query and the repository reread both returned. Omitting activation produced `true` in the response and the database. PC-20 covers default-active creation.
- **Q3 — Limit units.** The catalog returns both stored numbers unchanged. `pkg/judge/limits.go` interprets valid time values below 50 as seconds and values of 50 or greater as legacy milliseconds, and converts configured memory from MiB to KiB. Custom Run and official testcase metadata use these helpers. The website uses the same time threshold for display and labels the stored memory number `MB`. PC-11 covers the catalog's numeric pass-through.

## Open questions

- **Q2 — Installed taxonomy.** Which curated seed definitions are installed in a running environment? `seed-tags` is an explicit command with 209 checked-in definitions. No running local catalog was available to compare against them. PC-24 covers the seeding operation and preservation rules. Task 2.1 stays open pending an inventory from an identified running environment.
