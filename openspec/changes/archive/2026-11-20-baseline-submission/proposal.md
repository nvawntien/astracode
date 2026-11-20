## Why

Submission behavior exists in the running code but has no OpenSpec capability spec (`openspec list --specs` reports no specs). This M0-06 baseline records that behavior with source evidence so later changes can distinguish existing guarantees from proposed ones.

## What Changes

- Add the `submission` delta spec using ADDED requirements only, covering creation and problem access, cooldown, attempts, personal and staff history, detail, rejudge, and current-attempt result application.
- Record one evidence mapping per requirement in `design.md`, with review-only tasks and verification evidence in `progress.md`.
- Preserve the implementation, including its limitations and likely bugs listed below. This change introduces no runtime behavior.

## Capabilities

### New Capabilities

- `submission`: Baseline of the existing official Submission lifecycle and reads; new documentation of an existing capability.

### Modified Capabilities

None.

## Impact

- Classification: **NON-BREAKING**, documentation only. No API, event, gateway, dependency, persistence, or production configuration change.
- All writes in this checkout belong to `openspec/changes/baseline-submission/`. No main spec edits, code changes, merge, or archive.
- In scope: submission validation and problem access delegation; transactional outbox intake; attempt identity and metadata; personal/staff history and detail; rejudge; validation, correlation, and persistence of results.
- Out of scope: `judging`, `realtime-updates`. Interactive Custom run, profile statistics, and product features absent from this code are also outside this baseline.
- Architecture document impact: none; the existing codebase documents are context, and source code is the evidence of behavior.

## Findings

- **Cooldown survives failed creation.** `createSubmissionUseCase.Execute` acquires cooldown before allocating/persisting the Submission, and there is no release on a later failure. A failed transaction can therefore delay the next request for the same user and coding problem.
- **The first terminal result wins, including System Error.** `applyJudgeResultUseCase.Execute` ignores later valid results once the Submission is terminal. A System Error followed by Accepted for the same Attempt remains System Error; this baseline records that outcome without changing policy.
- **Read-side access does not re-check problem access.** Creation calls the Problem reader with the actor identity. Personal/staff history and detail read Submission-owned data using identity/role/ownership checks without consulting the Problem reader. Per-read Premium entitlement enforcement cannot be claimed from these paths; a correction requires a separate approved change.
- **Some related reads can race with rejudge.** Personal detail reads the selected Attempt and counts in one statement. Personal history obtains items and counts separately; staff detail obtains the Submission, Attempt, and results separately. A coherent snapshot across those separate reads cannot be claimed.
- **Result validation is structural rather than a full consistency check.** Duplicate positive testcase indexes and disagreement between reported totals and result count are not rejected. Optional version/count/runtime/memory values have no positivity check here. Incoming testcase input/output values are copied into persistence; the user/staff read responses omit them. This baseline does not claim sanitization at intake.
- **Durable intake does not establish eventual delivery.** The outbox relay skips records after five recorded publication failures; no recovery path is established by this baseline.
- **Legacy compatibility remains.** The glossary deprecates Contributor, but current personal history/detail code still accepts it. Staff history recognizes C and JavaScript even though new Submission creation and personal history language filters permit only CPP, GO, PYTHON, and JAVA.

## Open questions

- What transitions an official Submission into Judging in this checkout? `MarkJudging` is defined, but no production caller was found in `services/submission/`; create/rejudge set Pending and result application accepts terminal statuses only. No requirement promises that an intermediate Judging state is reached.
- Are historical Attempt details available through a consumer outside the inspected Submission service? This service retains previous Attempts/results but exposes current-Attempt detail only. No requirement promises a historical-Attempt browsing operation or retention duration.

These questions bound what is undocumented; neither blocks recording the confirmed behavior or authorizes implementation work.
