# progress.md — baseline-user-profile-statistics

## Verified state

- Reviewed `docs/apply-m0-baselines` at `90f64408d2dd16c281341ae15f4d912cabccd3ca` before updating this log and the checklist.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` and `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` passed in an isolated checkout. The full run included race tests, website build and typecheck, Compose configuration, and strict OpenSpec validation for all eight changes. The website build reported lint warnings.
- `openspec validate baseline-user-profile-statistics --strict` passed with OpenSpec 1.13.0. The structural audit matched each ADDED requirement to one Evidence row and checked 29 referenced files and seven gateway routes.
- The current deltas contain 15 requirements, 37 WHEN/THEN scenarios, and 15 Evidence rows. User profile accounts for 8 requirements and 21 scenarios. Statistics accounts for 7 requirements and 16 scenarios. The earlier count of 36 scenarios predates the cancellation scenario added in `3286bc1`.

## Last session

- **1.1 Public profile and search.** Reviewed Auth eligibility and public response fields, plus the filtered and escaped PostgreSQL search. `TestGetProfileHidesNonPublicAccountStates`, `TestSearchPublicUsersSupportsPaginationNoMatchBlankAndLiteralWildcards`, and `TestEscapeLikePatternTreatsWildcardsAndEscapeAsLiterals` passed.
- **1.2 Own profile.** Reviewed claims-based access, field and URL validation, and the supplied-field update. `TestUpdateProfileUsesScopedWriteAndOnlyAllowsHTTPURLs` passed.
- **1.3 Avatar.** Reviewed the size and media type checks, storage upload, reference update, and best-effort deletion on both update outcomes. `TestScopedProfileAndAvatarUpdatesPreserveUnrelatedFields` passed for the scoped write.
- **2.1 Statistics access.** Reviewed claims for own reads and Auth visibility resolution before public reads by resolved user ID. `TestGetMyProfileStatsZeroAndAuthorizationBehavior`, `TestGetPublicProfileStatsDoesNotQuerySubmissionDataWhenAuthRejectsOrFails`, and `TestGRPCPublicUserResolverMapsContractAndStatuses` passed. The active-request cancellation scenario was verified in source. `grpcPublicUserResolver.ResolvePublicUser` returns `context.Canceled` when Auth cancels and the caller is still active. `response.HandleError` maps it to HTTP 500.
- **2.2 Statistics aggregates.** Reviewed response mapping and the four aggregate queries, including verdict and language grouping, rounding, and the UTC activity lower bound. `TestSubmissionRepositoryGetUserProfileStatsUsesBoundedAggregates`, `TestGetMyProfileStatsPreservesCurrentAttemptAggregateSemantics`, and `TestAcceptanceRateRoundsToTwoDecimalPlaces` passed.
- **3.1 Findings and open questions.** Confirmed the cancellation mapping, visibility check before aggregate reads, separate aggregate queries, avatar sniffing and best-effort deletion, and the UTC lower bound without an upper bound. Kept both live deployment questions open.
- **3.2 Evidence and strict validation.** Matched all 15 requirement titles to Evidence rows and confirmed the strict validation result above.

## Broken or unverified

- Live PostgreSQL aggregate isolation and the effects of a visibility or verdict change during a request remain unverified. Fixture and mock tests cover the request flow, query shape, and result mapping.
- Deployed avatar URL reachability and caching after replacement or suspension, plus object cleanup under live storage failures, remain unverified. The tests cover scoped writes and the storage outcomes were reviewed in source.

## Next action

- All seven review tasks are complete. The change is ready for archive.
