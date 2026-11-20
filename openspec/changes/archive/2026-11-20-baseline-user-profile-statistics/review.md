---
change: baseline-user-profile-statistics
round: 1
max_rounds: 3
reviewed_commit: e859d62
status: approved
---

## Round 1 findings

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | specs/statistics/spec.md: "Public profile statistics eligibility" | When the Auth gRPC call returns `codes.Canceled` while the parent request context is still live (`ctx.Err() == nil`), `grpcPublicUserResolver.ResolvePublicUser` (`services/submission/internal/adapter/outbound/auth/grpc_client.go:37-41`) returns a bare `context.Canceled`, not `domain.ErrAuthServiceUnavailable`. `response.HandleError` (`pkg/response/handle.go:441-461`) then maps any non-`AppError` to a generic `500 internal server error`, not the "temporary unavailability" outcome the spec describes for every lookup failure. | Either note this one error path as a narrower exception in the scenario ("temporary unavailability ... except a bare-cancellation race, which reports an internal error"), or confirm (if intentional) that this is covered under the existing Findings in proposal.md as an additional item. |

## Round 1 author response

| # | Action | Note |
|---|---|---|
| 1.1 | fixed | Added the active-request cancellation scenario and evidence, and recorded the error mapping as a finding. `services/submission/internal/adapter/outbound/auth/grpc_client.go:37` returns a bare cancellation, which `pkg/response/handle.go:447` maps to an internal error. |
