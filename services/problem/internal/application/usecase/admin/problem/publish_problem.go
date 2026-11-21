package problem

import (
	"context"
	"strings"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/application/dto"
	inbound "go-judge-system/services/problem/internal/application/port/inbound/admin"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/application/usecase"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

type publishProblemUseCase struct {
	problemRepo outbound.ProblemRepository
	cache       outbound.SubmissionProblemCache
}

func NewPublishProblemUseCase(problemRepo outbound.ProblemRepository) inbound.PublishProblemUseCase {
	return newPublishProblemUseCase(problemRepo, nil)
}

func NewCachedPublishProblemUseCase(problemRepo outbound.ProblemRepository, cache outbound.SubmissionProblemCache) inbound.PublishProblemUseCase {
	return newPublishProblemUseCase(problemRepo, cache)
}

func newPublishProblemUseCase(problemRepo outbound.ProblemRepository, cache outbound.SubmissionProblemCache) inbound.PublishProblemUseCase {
	return &publishProblemUseCase{problemRepo: problemRepo, cache: cache}
}

func (uc *publishProblemUseCase) Execute(ctx context.Context, claims auth.Claims, params dto.ProblemIDRequest) (dto.ProblemDetailResponse, error) {
	if strings.TrimSpace(claims.UserID) == "" || !claims.Role.AtLeast(rbac.RoleModerator) {
		return dto.ProblemDetailResponse{}, domain.ErrForbidden
	}

	var updated *entity.Problem
	err := uc.problemRepo.WithLockedProblem(ctx, params.ID, func(txCtx context.Context, locked *entity.Problem) error {
		if hasInactiveTags(locked.Tags) {
			return domain.ErrProblemContainsInactiveTags
		}
		locked.Publish()
		updated = locked
		if err := uc.problemRepo.Update(txCtx, locked); err != nil {
			return domain.ErrInternalServer.Wrap(err)
		}
		return nil
	})
	if err != nil {
		return dto.ProblemDetailResponse{}, err
	}
	invalidateSubmissionProblemCache(ctx, uc.cache, params.ID)

	return dto.ProblemDetailResponse{
		ProblemResponse: usecase.MapProblemToResponse(updated, true),
	}, nil
}
