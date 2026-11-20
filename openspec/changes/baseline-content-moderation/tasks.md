# Tasks

Review only. Evidence and verification are recorded in `design.md`, `review.md`, and `progress.md`.

## 1. Verify requirement-group evidence

- [x] 1.1 Verify authoring roles, draft ownership and mutation, deletion, and workspace behavior in CM-01–CM-05 and CM-11. Compare the Problem role/ownership and own-list matrices and the website role test.
- [x] 1.2 Trace CM-06–CM-10 through request binding, normalization, slug allocation, limits, and tag resolution, including browser validation and sequential edit behavior.
- [x] 1.3 Verify the staff controls and publish/hide branches in CM-12–CM-14. Confirm that inactive tags block publication and that the implementation has no testcase or pre-check publication gate.
- [x] 1.4 Trace CM-15–CM-20 through package authorization, ZIP validation, replacement, metadata projection, and deletion order. Compare the testcase role matrices and metadata-redaction test.
- [x] 1.5 Compare own/staff listing, privileged individual reads, and taxonomy requirements against M0-04. Trace handlers, use cases, repositories, and test coverage and record the ownership decisions in the review.
- [x] 1.6 Check Contributor Workspace and Admin Console source for redirects, state-specific navigation, read-only Published contributions, confirmations, duplicate-request guards, feedback, and refresh/navigation.

## 2. Review findings and validate the baseline

- [x] 2.1 Trace the former CM-22 explicit-inactive case through binding, application, DAO, GORM, and response. Confirm the PostgreSQL result in the isolated probe and record it as a finding. Retain OQ-2 for concurrent package replacement and failure recovery.
- [x] 2.2 Verify one Evidence row per requirement, all-ADDED operations, behavioral SHALL and WHEN/THEN wording, a clean whitespace check, and a documentation-only diff scoped to this change.
- [x] 2.3 Run `openspec validate baseline-content-moderation --strict` and the repository verification, and record the results in `progress.md`.
