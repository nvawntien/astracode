<!-- .github/pull_request_template.md -->

## Change
- OpenSpec change: `<change-id>`
- Implements: F-xx | Addresses: NFR-xx | Follows: ADR-xxxx
- Issue: #

## Gate
- [ ] Gate 1 (draft): change folder only — proposal, delta specs, design, tasks
- [ ] Gate 2 (ready): implementation

## Verification
- [ ] CI green (build, tests, `openspec validate --strict`, lint, scans)
- [ ] `scripts/verify.sh` run locally; any check not run or failing is listed under Checks not run
- [ ] Every delta scenario covered by a test or recorded manual check (NFR-D09; list below)
- [ ] Cross-agent review done (Claude Code ↔ Codex); findings resolved
- [ ] Doc impact ticks below match the diff (reviewer confirms)
- [ ] Unfinished user-facing behaviour behind a feature flag
- [ ] Scoped to the change: no unrelated cleanup, no debug leftovers
- [ ] No secrets, credentials, personal data, or private testcase content committed
- [ ] UI changes include screenshots or recordings (when applicable)

| Scenario | Test / check |
|---|---|
| | |

Checks not run (and why):

## Doc impact (tick all that apply)
<!-- The architecture documents below are planned (see docs/architecture/README.md). If one does not exist yet, say so here instead of creating it. -->
- [ ] Behaviour changed → delta spec in this change
- [ ] API/event changed → contract updated (BREAKING / NON-BREAKING)
- [ ] Structure/components changed → `docs/architecture/application.md` and/or new ADR
- [ ] Data/ownership changed → `docs/architecture/data.md`
- [ ] Deployment/pipeline changed → `docs/architecture/deployment.md`
- [ ] New attack surface → `docs/architecture/security.md`
- [ ] New paid resource → `docs/architecture/finops.md`
- [ ] None of the above (explain):

## Compatibility / deployment impact
<!-- API, schema, configuration, migration, rollout or rollback impact. Write "None" when not applicable. -->
