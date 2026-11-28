# progress.md — azure-walking-skeleton

<!-- Template: docs/process/templates/progress.md. Overwrite this file at the end of every session; keep it under 40 lines. -->

## Verified state

- Branch — `feature/azure-walking-skeleton`. The reviewed implementation revision is `8db87e1`. Hosted CI and OpenSpec passed on that PR revision. The exact-head S3 rehearsal check was skipped. [Verification evidence](../../../docs/evidence/m0-13-phase-a.md#source-and-scope)
- Progress — 7 of 15 tasks. The change-specific two-stage Gate 2 sequence and Phase A authorization are recorded separately from implementation and cloud acceptance. [Gate 1 Round 2](review-gate1-round2.md)
- Documentation review scope — ADR-0012 acceptance recorded. ADR-0013 remains Proposed. The 36 ED scenarios have individual evidence rows. Runtime tests rely on the recorded implementation runs. [Scenario verification](../../../docs/evidence/m0-13-phase-a.md#scenario-verification)

## Last session

- Recorded the Orchestrator's acceptance in [ADR-0012](../../../docs/architecture/adr/0012-judge-executor-trust-boundary.md) after review of `d1cfa4bd464fd189b4dd7da6f2da3d6d2ed7cc60`. The original Phase A approval remains linked there.

## Broken or unverified

- The privileged Judge workload, launch-gate trust assumptions and S3/S2 exposure follow Accepted ADR-0012 and still require real S3 isolation evidence.
- The protected controller API, App poller, S2 controller-owned power, S3 recovery and independent cleanup, and workflow identity integration depend on Proposed ADR-0013. Tenant A directory support, actual federation and receipt access, billing and hosting feasibility remain unverified. Task 2.1 stays open.
- The two outstanding lifecycle review findings remain separate and open. Their disposition requires implementation review, not this documentation change.

## Next action

- Independent ADR-only documentation review under [workflow §10](../../../docs/process/workflow.md#10-adrs). The accepted ADR-0004 and historical review records remain intact. Return to Phase B only under separate authorization and the recorded prerequisites.
