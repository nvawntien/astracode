# Tasks

Review only. Source tracing is recorded in `design.md`; unchecked items await reviewer acceptance, not implementation. No task authorizes changes outside this change directory.

## 1. Verify requirement-group evidence

- [ ] 1.1 Verify CM-01 through CM-05 and CM-11 against the role, ownership, own-list, deletion, and workspace branches in their Evidence rows; compare the existing problem access-matrix, own-list, and website role tests and record any discrepancy in the proposal.
- [ ] 1.2 Verify CM-06 through CM-10 against request binding, create/update normalization, slug allocation, limits, and tag resolution; confirm the creation/edit/browser differences and every positive/negative scenario by source inspection.
- [ ] 1.3 Verify CM-12 through CM-14 against staff listing and publish/hide implementations; confirm that inactive tags block publication and that neither testcase existence nor a review/pre-check state is required.
- [ ] 1.4 Verify CM-15 through CM-20 against package authorization, ZIP validation, version replacement, metadata mappers, and deletion ordering; compare the existing testcase access-matrix and metadata-redaction tests without inferring untested payload integrity or concurrency guarantees.
- [ ] 1.5 Verify CM-21 through CM-23 against tag list/create/update/deactivation and Published-usage checks; confirm that deletion retains associations and that explicitly inactive creation remains excluded under OQ-1.
- [ ] 1.6 Verify the website scenarios in CM-02, CM-06, CM-07, and CM-24 against Contributor/Admin pages, the structured editor, and the package manager; confirm redirects, read-only Published contributions, confirmation, busy guards, feedback, and reload behavior by source inspection.

## 2. Review unresolved cases and validate the baseline

- [ ] 2.1 Answer proposal OQ-1 through OQ-3 with concrete evidence, or record the reviewer's explicit decision to retain their unresolved/excluded status; verify that no unconfirmed outcome becomes a SHALL requirement.
- [ ] 2.2 Verify one Evidence row per requirement, all-ADDED operations, WHEN/THEN scenarios, behavior-only wording, glossary usage, and the `problem-catalog` boundary; verify `git diff --check` and that changed/staged paths belong exclusively to this change directory. Confirm that architecture/doc/contract impact is documentation-only.
- [x] 2.3 Run `openspec validate baseline-content-moderation --strict` and record its exact result and the CLI invocation in `progress.md`; do not treat validation as runtime acceptance evidence.
