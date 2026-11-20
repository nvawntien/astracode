## 1. Review user-profile evidence

- [ ] 1.1 Verify public lookup, public fields, and user search against the Auth handlers, visibility checks, response shapes, and search query. Cross-check `TestGetProfileHidesNonPublicAccountStates`, `TestSearchPublicUsersSupportsPaginationNoMatchBlankAndLiteralWildcards`, and `TestEscapeLikePatternTreatsWildcardsAndEscapeAsLiterals`.
- [ ] 1.2 Verify own profile access, editable fields and validation against the claims-based handlers, field validators, and scoped persistence write. Cross-check `TestUpdateProfileUsesScopedWriteAndOnlyAllowsHTTPURLs`.
- [ ] 1.3 Verify avatar upload validation and cleanup outcomes against the avatar use case and storage adapter. Cross-check `TestScopedProfileAndAvatarUpdatesPreserveUnrelatedFields` for the scoped write.

## 2. Review statistics evidence

- [ ] 2.1 Verify own and public access, account identity, public visibility, and lookup failure mapping against both use cases and the Auth resolver. Cross-check `TestGetMyProfileStatsZeroAndAuthorizationBehavior` and `TestGetPublicProfileStatsDoesNotQuerySubmissionDataWhenAuthRejectsOrFails`.
- [ ] 2.2 Verify the aggregate response, totals, acceptance rate, distributions, and UTC date boundary against the response mapping and queries. Cross-check `TestSubmissionRepositoryGetUserProfileStatsUsesBoundedAggregates`, `TestGetMyProfileStatsPreservesCurrentAttemptAggregateSemantics`, and `TestAcceptanceRateRoundsToTwoDecimalPlaces`.

## 3. Review open questions and validate

- [ ] 3.1 Review the Findings and record answers or dispositions for the proposal's Open questions. Use isolated concurrency checks or authorized non-secret deployment evidence where needed. Keep unverified behaviour outside the delta specs.
- [ ] 3.2 Verify each requirement has one matching Evidence row, then run `openspec validate baseline-user-profile-statistics --strict`.
