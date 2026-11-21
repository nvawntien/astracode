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

type hiddenProblemUseCase struct {
	problemRepo outbound.ProblemRepository
	cache       outbound.SubmissionProblemCache
}

func NewHiddenProblemUseCase(problemRepo outbound.ProblemRepository) inbound.HiddenProblemUseCase {
	return newHiddenProblemUseCase(problemRepo, nil)
}

func NewCachedHiddenProblemUseCase(problemRepo outbound.ProblemRepository, cache outbound.SubmissionProblemCache) inbound.HiddenProblemUseCase {
	return newHiddenProblemUseCase(problemRepo, cache)
}

func newHiddenProblemUseCase(problemRepo outbound.ProblemRepository, cache outbound.SubmissionProblemCache) inbound.HiddenProblemUseCase {
	return &hiddenProblemUseCase{problemRepo: problemRepo, cache: cache}
}

func (uc *hiddenProblemUseCase) Execute(ctx context.Context, claims auth.Claims, params dto.ProblemIDRequest) (dto.ProblemDetailResponse, error) {
	if strings.TrimSpace(claims.UserID) == "" || !claims.Role.AtLeast(rbac.RoleModerator) {
		return dto.ProblemDetailResponse{}, domain.ErrForbidden
	}

	var updated *entity.Problem
	err := uc.problemRepo.WithLockedProblem(ctx, params.ID, func(txCtx context.Context, locked *entity.Problem) error {
		locked.Hidden()
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
