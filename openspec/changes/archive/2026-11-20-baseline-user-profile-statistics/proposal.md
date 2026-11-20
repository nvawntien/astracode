## Why

M0-03 records how AstraCode currently exposes user profiles and computes profile statistics. This gives reviewers a reference for visibility rules, aggregate definitions, and failure behaviour before future changes.

## What Changes

- Record public profile lookup, public user search, and authenticated self profile edits and avatar uploads under `user-profile`.
- Record self and public statistics, submission and problem totals, acceptance rate, verdict and language distributions, and 365-day activity under `statistics`.
- Keep submission history and detail with `submission`. Sign-in, roles, suspension changes, and session invalidation remain with `identity-session`.

## Capabilities

### New Capabilities

- `user-profile` — Public profile and discovery, the owner's profile fields, and avatar upload and replacement.
- `statistics` — Access, visibility, and aggregate submission metrics for personal and public profiles.

### Modified Capabilities

None.

## Impact

This is a documentation baseline. The change adds OpenSpec deltas and review artifacts without changing runtime behaviour, contracts, or dependencies.

## Findings

- A cancellation response from the identity lookup while the public statistics request remains active is reported as an internal error instead of temporary unavailability. See `grpcPublicUserResolver.ResolvePublicUser` and `response.HandleError`.
- Public statistics resolve visibility before reading aggregates. A suspension between those two operations can leave an already admitted request reading that account's statistics. The next request resolves visibility again. See `getPublicProfileStatsUseCase.Execute` and `resolvePublicUserUseCase.Execute`.
- The totals, verdict, language, and activity reads are separate queries on the profile request path. Concurrent submissions or verdict changes can make the sections reflect different moments. See `submissionRepository.GetUserProfileStats`.
- Avatar replacement attempts cleanup but ignores deletion errors, both when discarding a new upload after a failed profile write and when removing the old avatar after success. This can leave an unreferenced object. The upload checks the detected media type from the first 512 bytes rather than decoding the complete image. See `uploadAvatarUseCase.Execute`.
- The activity query applies a lower UTC date boundary only. A submission timestamped in the future would also qualify if such a record exists. See `getProfileStats` and `submissionRepository.GetUserProfileStats`.

## Open questions

- Which isolation and timing outcomes are observable when account visibility or submission status changes during a live profile request? The baseline records the check and read order without a cross-service snapshot guarantee.
- Which live storage policies and caching rules govern avatar URL reachability and the lifetime of a previously returned URL after replacement or suspension? The code establishes upload, reference update, and cleanup attempts.
