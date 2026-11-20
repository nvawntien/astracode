## Context

Auth owns user visibility, profile data, and avatar references. Submission owns the aggregate statistics derived from its submissions. The boundary follows the [M0-03 row](../../../docs/process/templates/baseline-prompt.md#boundary-table). For existing service boundaries and flows, see [Architecture](../../../docs/codebase/ARCHITECTURE.md), [Flows](../../../docs/codebase/FLOWS.md), [Data](../../../docs/codebase/DATA.md), [Services](../../../docs/codebase/SERVICES.md), and [Domain](../../../docs/codebase/DOMAIN.md).

## Goals / Non-Goals

**Goals**

- Trace each baseline requirement to current code and record how visibility and aggregate definitions are enforced.
- Keep the two capability deltas reviewable independently.

**Non-Goals**

- Change an API, event, data model, dependency, or deployment.
- Establish a new quality target or a cross-service consistency guarantee.

## Decisions

- Auth serves public identity and discovery directly. Protected own profile reads and writes use the authenticated account ID. Public visibility depends on account state, while identity and session policy belongs to `identity-session`.
- Submission uses the authenticated ID for own statistics. Public statistics resolve the username through Auth before making any aggregate reads, then use the returned stable ID. Auth unavailability is distinct from an invisible account.
- The public and own paths share the aggregate code. Accepted totals, solved totals, and verdict counts use current submission status. Language counts and activity include unfinished submissions. Historical attempts do not count as extra submissions. The daily series uses UTC creation dates and returns sparse counts.
- Avatar replacement stores an image before updating the profile reference and attempts cleanup afterward. Public profile and search expose a URL when present. Production Envoy forwarding for avatar URLs is defined by `build` in `envoy/generate.py` and `envoy/envoy.prod.yaml`. Deployed storage access and caching remain open questions.

## Evidence

Paths are relative to the repository root. Each row maps to one requirement title in the delta specs.

| Capability | Requirement | File paths and implementing functions or handlers |
| --- | --- | --- |
| `user-profile` | Public profile visibility | `services/auth/internal/adapter/inbound/http/handler/user/get_profile.go` — `GetProfileHandler.Handle`. `services/auth/internal/application/usecase/user/get_profile.go` — `getProfileUseCase.Execute`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.GetUserByUsername`. `envoy/routes.json` — public profile route. |
| `user-profile` | Public profile fields | `services/auth/internal/application/usecase/user/mappers.go` — `toGetProfileResponse`. `services/auth/internal/application/dto/user.go` — `GetProfileResponse`. |
| `user-profile` | Public user search matching and visibility | `services/auth/internal/adapter/inbound/http/handler/user/search_public_users.go` — `SearchPublicUsersHandler.Handle`. `services/auth/internal/application/usecase/user/search_public_users.go` — `searchPublicUsersUseCase.Execute`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.SearchPublicUsers`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `escapeLikePattern`. `envoy/routes.json` — public search route. |
| `user-profile` | Public user search bounds and pagination | `services/auth/internal/application/usecase/user/search_public_users.go` — `searchPublicUsersUseCase.Execute`. `services/auth/internal/application/usecase/user/search_public_users.go` — `parsePublicUserSearchPagination`. `services/auth/internal/application/usecase/user/search_public_users.go` — `emptyPublicUserSearchResponse`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.SearchPublicUsers`. |
| `user-profile` | Own profile access and edits | `services/auth/internal/adapter/inbound/http/router.go` — `Router.SetupRoutes`. `services/auth/internal/adapter/inbound/http/handler/user/get_me.go` — `GetMeHandler.Handle`. `services/auth/internal/adapter/inbound/http/handler/user/update_profile.go` — `UpdateProfileHandler.Handle`. `services/auth/internal/application/usecase/user/get_me.go` — `getMeUseCase.Execute`. `services/auth/internal/application/usecase/user/update_profile.go` — `updateProfileUseCase.Execute`. `services/auth/internal/application/usecase/user/mappers.go` — `toGetMeResponse`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.UpdateProfile`. |
| `user-profile` | Profile edit validation | `services/auth/internal/application/usecase/user/update_profile.go` — `validateProfileFields`. `services/auth/internal/application/usecase/user/update_profile.go` — `validateOptionalText`. `services/auth/internal/application/usecase/user/update_profile.go` — `validateOptionalURL`. `services/auth/internal/domain/entity/user.go` — `User.UpdateProfile`. |
| `user-profile` | Avatar upload eligibility and validation | `services/auth/internal/adapter/inbound/http/router.go` — `Router.SetupRoutes`. `services/auth/internal/adapter/inbound/http/handler/user/upload_avatar.go` — `UploadAvatarHandler.Handle`. `services/auth/internal/application/usecase/user/upload_avatar.go` — `uploadAvatarUseCase.Execute`. `services/auth/internal/application/usecase/user/upload_avatar.go` — `isAllowedAvatarContentType`. |
| `user-profile` | Avatar replacement and cleanup | `services/auth/internal/application/usecase/user/upload_avatar.go` — `uploadAvatarUseCase.Execute`. `services/auth/internal/adapter/outbound/persistence/postgres/user.go` — `userRepository.UpdateAvatar`. `services/auth/internal/adapter/outbound/storage/minio/avatar_storage.go` — `avatarStorage.UploadAvatar`. `services/auth/internal/adapter/outbound/storage/minio/avatar_storage.go` — `avatarStorage.DeleteAvatar`. |
| `statistics` | Own profile statistics access | `services/submission/internal/adapter/inbound/http/router.go` — `Router.SetupRoutes`. `services/submission/internal/adapter/inbound/http/handler/user/get_my_profile_stats.go` — `GetMyProfileStatsHandler.Handle`. `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `getMyProfileStatsUseCase.Execute`. `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `submissionRepository.GetUserProfileStats`. `envoy/routes.json` — protected own statistics route. |
| `statistics` | Public profile statistics eligibility | `services/submission/internal/adapter/inbound/http/handler/user/get_public_profile_stats.go` — `GetPublicProfileStatsHandler.Handle`. `services/submission/internal/application/usecase/user/get_public_profile_stats.go` — `getPublicProfileStatsUseCase.Execute`. `services/submission/internal/adapter/outbound/auth/grpc_client.go` — `grpcPublicUserResolver.ResolvePublicUser`. `services/auth/internal/adapter/inbound/grpc/handler/resolve_public_user.go` — `ResolvePublicUserHandler.Handle`. `services/auth/internal/application/usecase/user/resolve_public_user.go` — `resolvePublicUserUseCase.Execute`. `services/submission/internal/domain/errors.go` — `ErrPublicProfileNotFound`. `services/submission/internal/domain/errors.go` — `ErrAuthServiceUnavailable`. `envoy/routes.json` — public statistics route. |
| `statistics` | Statistics response contains aggregates | `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `getProfileStats`. `services/submission/internal/application/dto/submission.go` — `GetMyProfileStatsResponse`. |
| `statistics` | Submission totals and acceptance rate | `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `submissionRepository.GetUserProfileStats`. `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `getProfileStats`. `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `acceptanceRate`. |
| `statistics` | Verdict distribution | `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `submissionRepository.GetUserProfileStats`. `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `getProfileStats`. |
| `statistics` | Language distribution | `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `submissionRepository.GetUserProfileStats`. `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `getProfileStats`. |
| `statistics` | Daily submission activity | `services/submission/internal/application/usecase/user/get_my_profile_stats.go` — `getProfileStats`. `services/submission/internal/adapter/outbound/persistence/postgres/submission.go` — `submissionRepository.GetUserProfileStats`. |

## Risks / Trade-offs

- Account visibility can change between resolution and aggregation → The spec describes eligibility at the time of the check.
- Statistics sections use separate reads → Review the status and timing findings in the proposal before assuming a single snapshot.
- Avatar cleanup is best effort → The spec distinguishes profile update success from media deletion success.

## Documentation impact

The change adds two delta specs and their review artifacts. The architecture and product references serve as context for this baseline.
