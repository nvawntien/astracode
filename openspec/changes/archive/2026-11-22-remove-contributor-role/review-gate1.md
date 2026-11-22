---
change: remove-contributor-role
gate: 1
round: 2
max_rounds: 3
reviewed_commit: 1e5b0d70e4a278a4b26019444fda38e9a8e44ae4
risk: high
status: approved
---

## Round 1 review history

```yaml
change: remove-contributor-role
gate: 1
round: 1
max_rounds: 3
reviewed_commit: 8dbcd7a7b300b2a82514ec734b89200503f6a118
risk: high
status: changes-requested
```

## Evidence of checks run

- `openspec validate remove-contributor-role --strict` → `Change 'remove-contributor-role' is valid`.
- `openspec list` → only `remove-contributor-role` (0/8 tasks) is active, so check 8 (in-flight conflicts) passes.
- Check 4: every MODIFIED and REMOVED header matches a current requirement exactly. That covers 8 in content-moderation, 4 in identity-session, 5 in problem-catalog, 1 in realtime-updates, 3 in submission, and the 2 REMOVED content-moderation requirements. Every current requirement that mentions Contributor is covered by a delta. The only stale mention left is the content-moderation Purpose line (see 1.11).
- Check 3: no scenario from a current MODIFIED requirement is dropped. The deltas add scenarios: "Refresh carries the retired role", "Access credential carries the retired role", "Admin attempts to assign the retired role", "Guest requests an own catalog" and "Migrated owner reads history".
- Checks 1 and 2: the PRD gives F-01 ("removal of the Contributor role") and the F-03 acceptance criterion "The Contributor role no longer exists", and this change covers both. The other F-03 acceptance criteria are approval-gated visibility, pre-check, eligibility, track access and the pending limit. proposal.md line 14 defers them to M1-03, M1-04 and M1-07. No PRD §2.3 non-goal is touched.
- Check 11: tasks.md has 8 tasks, and each names a verification. `envoy/generate.py --check` and the website `test` and `typecheck` scripts exist.

## Round 1 findings
| # | Severity | Check | Location | Problem | Expected |
|---|---|---|---|---|---|
| 1.1 | blocking | 12 | proposal.md "Modified Capabilities" (lines 22–26); `specs/` has 5 folders | The change modifies 5 capabilities: content-moderation, identity-session, problem-catalog, realtime-updates and submission. The maximum is 3. You cannot drop the submission and realtime-updates deltas, because the current specs name "legacy Contributor" in openspec/specs/submission/spec.md:98,174,177,217 and openspec/specs/realtime-updates/spec.md:10. | Split into changes of 3 or fewer capabilities. Example: (A) content-moderation + problem-catalog opens authoring and the own catalog to every authenticated account while Contributor still exists. (B) identity-session + submission + realtime-updates then retires the role, converts accounts and handles the cutover. Ship A before B so no author loses access. If you keep one change, record an explicit human waiver of the size limit in the proposal. |
| 1.2 | major | 9 / 1 | proposal.md line 1 (no `Follows:`); design.md Decisions 2 and 4, Migration Plan step 4 | docs/process/workflow.md §10 requires an ADR for "any decision that is costly to reverse or affects several capabilities". This change removes a role across 5 capabilities and 5 deployables. design.md step 4 also says that restoring Contributor "would require … a separate decision". `docs/architecture/adr/` is empty. | Add a Proposed ADR for retiring the Contributor role and for the one-time conversion and cutover. Cite it on the first line as `Follows: ADR-xxxx`. Alternatively, state why §10 does not apply. |
| 1.3 | major | 9 | design.md Decision 4; tasks.md 1.2 | AGENTS.md says "No … migration runner … exists—do not invent one without first establishing the toolchain." Decision 4 adds an Auth-owned preview/apply data-conversion command. It is narrower than a runner, but it is new migration tooling, and the design does not say who runs it in production or how. Hard constraint 8 forbids agents from touching production. | State that this is a one-off command, not a general migration runner. Say how operators invoke it, and say that the agent only rehearses it locally (task 3.2). Get human confirmation that this approach is acceptable. |
| 1.4 | minor | 7 | specs/identity-session/spec.md "Existing Contributor account conversion" and scenario "Migrated author signs in again" | identity-session asserts that converted accounts keep ownership of and access to drafts, Published problems and prior Submissions. Problem ownership and access belong to content-moderation and problem-catalog. Submission access belongs to submission, which already covers it in "Migrated owner reads history". | Limit the identity-session requirement to account outcomes: same account ID, User role, verification and suspension unchanged, and pre-cutover credentials rejected. Rely on the problem-catalog and submission scenarios for data access. |
| 1.5 | minor | 5 | specs/identity-session/spec.md "Existing Contributor account conversion" | A one-time migration becomes a permanent SHALL. After archive, the identity-session spec will always require "convert existing Contributor accounts", and "Conversion is retried" describes a run of the migration rather than system behaviour. | Phrase it as an invariant, for example "No account SHALL hold the retired Contributor role; an account that held it keeps …". Keep the run and retry mechanics in design.md's Migration Plan and in task 1.2. |
| 1.6 | minor | 6 | specs/problem-catalog/spec.md "Internal problem metadata visibility" | The requirement keeps "recognized role" without defining it against the supported set. No scenario says that an actor role of Contributor is rejected, although design.md Decision 2 and the Contract Draft row "Internal Problem `GetProblem` — BREAKING for old role values" require it. | Use "supported role (User, Moderator, Admin)". Add a scenario: WHEN the actor role is the retired Contributor role THEN the request is rejected as forbidden. |
| 1.7 | minor | 6 | Scenario titles: content-moderation CM-01 "Contributor attempts a moderation action", CM-03 "Contributor creates a problem", CM-05 "Contributor mutates another author's draft" and "Contributor edits a Published problem", CM-15 "Contributor mutates a Published package"; problem-catalog "Contributor reads their own catalog" and "Contributor reads another author's problem" | After archive these titles name a role that no longer exists. Their WHEN clauses ("a former Contributor signs in as a User") also narrow general User rules to migrated accounts, so a test that uses only migrated fixtures would satisfy them. | Retitle them as "User …" and use "a User" in WHEN. Keep the migrated-author case in a single scenario in identity-session (or submission). |
| 1.8 | minor | 3 | specs/content-moderation/spec.md, REMOVED CM-02/CM-04 plus ADDED CM-02/CM-04 | The rename from "Contributor Workspace" to "Contributions workspace" uses REMOVED + ADDED with the same CM IDs. It validates, but history then shows a deletion and an addition instead of a rename with changed behaviour. | Prefer `## RENAMED Requirements` (FROM/TO) plus MODIFIED for the new text. |
| 1.9 | minor | 6 | specs/content-moderation/spec.md CM-02 scenario "Base-role User opens the workspace" | The WHEN says "authenticated User with a verified email", but the requirement says "authenticated Users". Sign-in already requires a verified account (identity-session "Sign-in credentials and account eligibility"), so the qualifier is redundant. It also hints at a verified-email gate that the proposal assigns to M1-07. | Drop "with a verified email", or state the gate in the requirement if it is intended. |
| 1.10 | minor | 11 | tasks.md 1.2, 2.1, 3.1, 3.2 | Some changed scenarios have no named test. These are CM-14 "Hide a Published contribution" (a User can edit again after staff hide), CM-12 "Lower role opens administrative problem management" (a User is denied), CM-24 "A problem is created" from the Contributions workspace, and CM-11 "Delete an owned Draft" by a User. Task 1.2 names no command ("Auth tests with PostgreSQL and Redis"). Task 3.2 is a manual rehearsal and has no defined evidence. | Add those scenarios to tasks 2.1 and 3.1. Name the exact command or test for task 1.2 (for example `(cd services/auth && go test ./...)` with the required tags or env). Say that task 3.2 records commands and outputs in progress.md. |
| 1.11 | minor | 7 | openspec/specs/content-moderation/spec.md:4 (Purpose) | The Purpose still says "Contributor ownership", and delta specs cannot change it, so it will be stale after archive. | Note in tasks.md or design.md how the Purpose is updated through the archive or sync process. Do not edit openspec/specs directly. |

## Summary for the human reviewer
This change removes the Contributor role. It converts existing Contributor accounts to User and revokes their old sessions, rejects `contributor` at Envoy, Auth refresh, the services and internal GetProblem, and opens draft authoring and the Contributions workspace to every signed-in User. Publish and hide stay staff-only. Risk is high because it touches authentication, authorization, a Redis-and-PostgreSQL data conversion, BREAKING contracts and the content-moderation hotspot. The blocking issue is size (5 capabilities; see 1.1). Look first at design.md's Migration Plan and the cutoff-before-commit ordering, the missing ADR (1.2), and the new conversion command against the AGENTS.md "no migration runner" rule (1.3). Separately, decide whether letting any verified User upload Testcase packages before the M1-07 eligibility limits exist is acceptable for the pilot.

## Round 2 review

Reviewed on 2026-11-21 against `1e5b0d7` and the decisions recorded in this review.

### Project owner decisions

1. Approved an exception to the three-capability maximum. Keep all five capability deltas in `remove-contributor-role`.
2. Accepted PRD D-01 and the existing design as sufficient documentation. Approved an exception to the workflow's separate ADR requirement for M1-01.
3. Approved retaining existing scenario headings where OpenSpec requires them by name. Record the stale headings and the `content-moderation` Purpose disposition during archive. Use a subsequent documentation-only OpenSpec change for wording that the archive tooling cannot safely update. Main-spec updates go through archive.

### Round 1 finding dispositions

| Finding | Disposition | Round 2 evidence |
| --- | --- | --- |
| 1.1 | Resolved by approved exception | The proposal records the owner's waiver. All five capabilities remain coordinated in the change. |
| 1.2 | Resolved by approved exception | The proposal cites D-01 and records the owner's acceptance of the design and the M1-01 exception to workflow §10. |
| 1.3 | Resolved | The Auth conversion command, migration-specific cutoff, production cutover, and rehearsal were removed. The design permits manual local database resets and preserves existing logout-all behavior. |
| 1.4 | Resolved | Identity-session no longer claims ownership or data continuity for converted accounts. Author access belongs to content-moderation and problem-catalog, and personal Submission access belongs to submission. |
| 1.5 | Resolved | The conversion requirement and its four scenarios were removed. Identity-session specifies ongoing credential eligibility and role rejection. |
| 1.6 | Resolved | Internal Problem metadata explicitly allows User, Moderator, and Admin and includes a forbidden outcome for Contributor, including for an owner. |
| 1.7 | Behavior resolved. Wording follow-up accepted. | The affected scenarios now exercise general User behavior. The prior headings are required by OpenSpec 1.13.0. The design records their archive disposition and the documentation-only follow-up if they remain. The migrated-owner history scenario was removed. |
| 1.8 | Resolved | CM-02 and CM-04 use `RENAMED` and complete `MODIFIED` blocks under their new names. Read-only merge reconstruction found each requirement exactly once and preserved the capability's requirement count. |
| 1.9 | Resolved | The workspace scenario requires an authenticated User. Draft creation has no M1-07 review eligibility gate. |
| 1.10 | Resolved in the implementation plan | Tasks 2.1 and 2.3 verify restored edit and package permissions after hiding and task 2.1 covers owned-draft deletion. Task 4.1 covers Admin Console denial and successful creation opening the draft detail. Task 1.2 specifies the Auth suite command. Task 4.2 requires recording verification evidence. The cutover rehearsal was deleted. |
| 1.11 | Archive follow-up accepted | OpenSpec 1.13.0 retains the existing `content-moderation` Purpose in the read-only merge preview. The design specifies “author ownership” and records the need for a subsequent documentation-only OpenSpec change if the wording remains at archive. |

### Evidence and verdict

- OpenSpec 1.13.0 strict validation passed with `openspec validate remove-contributor-role --strict --no-interactive`. `openspec list --json` showed one active change and 0 of 11 implementation tasks complete.
- Read-only reconstruction of all five specs confirmed the delta targets, requirement renames, and scenario preservation. The preview retained the stale scenario headings and existing Purpose. See the archive disposition. [Design](design.md#archive-disposition)
- The proposal and design keep M1-02, M1-03, M1-04, and M1-07 outside this change. The contract draft labels role compatibility changes and preserves existing routes and payload shapes. Backend ownership checks, secure credential admission, staff authorization, and testcase upload and confidentiality rules are specified.
- The owner-approved pilot permits authenticated Users to manage testcase packages for their own hidden drafts within the existing limits and protections. Review eligibility belongs to M1-07.

**Gate 1 approved.** Blocking and major findings are resolved, with no new findings. The recorded archive wording follow-up is accepted. This is specification approval. The implementation checklist remains at 0 of 11.
