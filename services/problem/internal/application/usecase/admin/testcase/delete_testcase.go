package testcase

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/application/dto"
	inbound "go-judge-system/services/problem/internal/application/port/inbound/admin"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

type deleteTestCaseUseCase struct {
	problemRepo  outbound.ProblemRepository
	testcaseRepo outbound.TestCaseRepository
}

func NewDeleteTestCaseUseCase(problemRepo outbound.ProblemRepository, testcaseRepo outbound.TestCaseRepository) inbound.DeleteTestCaseUseCase {
	return &deleteTestCaseUseCase{
		problemRepo:  problemRepo,
		testcaseRepo: testcaseRepo,
	}
}

func (uc *deleteTestCaseUseCase) Execute(ctx context.Context, claims auth.Claims, params dto.ProblemIDRequest) error {
	if strings.TrimSpace(claims.UserID) == "" || !claims.Role.AtLeast(rbac.RoleUser) {
		return domain.ErrForbidden
	}

	var key string
	err := uc.problemRepo.WithLockedProblem(ctx, params.ID, func(txCtx context.Context, locked *entity.Problem) error {
		if !canMutateTestcase(claims, locked) {
			return domain.ErrForbidden
		}

		tc, err := uc.testcaseRepo.GetByProblemID(txCtx, locked.ID)
		if errors.Is(err, domain.ErrTestCaseNotFound) {
			return domain.ErrTestCaseNotFound
		}
		if err != nil {
			return domain.ErrInternalServer.Wrap(err)
		}
		key = tc.ZipObjectKey
		if err := uc.testcaseRepo.DeleteByProblemID(txCtx, locked.ID); err != nil {
			return domain.ErrInternalServer.Wrap(err)
		}
		return nil
	})
	if errors.Is(err, outbound.ErrMutationCommitUncertain) {
		slog.WarnContext(ctx, "testcase deletion commit needs reconciliation", "object_key", key)
	}
	return err
}
