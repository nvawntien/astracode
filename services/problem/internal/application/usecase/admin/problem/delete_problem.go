package problem

import (
	"context"
	"strings"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/application/dto"
	inbound "go-judge-system/services/problem/internal/application/port/inbound/admin"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

type deleteProblemUseCase struct {
	problemRepo outbound.ProblemRepository
	cache       outbound.SubmissionProblemCache
}

func NewDeleteProblemUseCase(problemRepo outbound.ProblemRepository) inbound.DeleteProblemUseCase {
	return newDeleteProblemUseCase(problemRepo, nil)
}

func NewCachedDeleteProblemUseCase(problemRepo outbound.ProblemRepository, cache outbound.SubmissionProblemCache) inbound.DeleteProblemUseCase {
	return newDeleteProblemUseCase(problemRepo, cache)
}

func newDeleteProblemUseCase(problemRepo outbound.ProblemRepository, cache outbound.SubmissionProblemCache) inbound.DeleteProblemUseCase {
	return &deleteProblemUseCase{problemRepo: problemRepo, cache: cache}
}

func (uc *deleteProblemUseCase) Execute(ctx context.Context, claims auth.Claims, params dto.ProblemIDRequest) error {
	if strings.TrimSpace(claims.UserID) == "" || !claims.Role.AtLeast(rbac.RoleUser) {
		return domain.ErrForbidden
	}

	err := uc.problemRepo.WithLockedProblem(ctx, params.ID, func(txCtx context.Context, locked *entity.Problem) error {
		if !claims.Role.AtLeast(rbac.RoleModerator) && (locked.AuthorID != claims.UserID || !locked.IsHidden) {
			return domain.ErrForbidden
		}
		if err := uc.problemRepo.Delete(txCtx, params.ID); err != nil {
			return domain.ErrInternalServer.Wrap(err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	invalidateSubmissionProblemCache(ctx, uc.cache, params.ID)

	return nil
}
