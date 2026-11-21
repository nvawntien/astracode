package problem

import (
	"context"
	"errors"
	"strings"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/pkg/response"
	"go-judge-system/services/problem/internal/application/dto"
	inbound "go-judge-system/services/problem/internal/application/port/inbound/admin"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/application/usecase"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

type updateProblemUseCase struct {
	problemRepo outbound.ProblemRepository
	tagRepo     outbound.TagRepository
	cache       outbound.SubmissionProblemCache
}

func NewUpdateProblemUseCase(problemRepo outbound.ProblemRepository, tagRepo outbound.TagRepository) inbound.UpdateProblemUseCase {
	return newUpdateProblemUseCase(problemRepo, tagRepo, nil)
}

func NewCachedUpdateProblemUseCase(
	problemRepo outbound.ProblemRepository,
	tagRepo outbound.TagRepository,
	cache outbound.SubmissionProblemCache,
) inbound.UpdateProblemUseCase {
	return newUpdateProblemUseCase(problemRepo, tagRepo, cache)
}

func newUpdateProblemUseCase(problemRepo outbound.ProblemRepository, tagRepo outbound.TagRepository, cache outbound.SubmissionProblemCache) inbound.UpdateProblemUseCase {
	return &updateProblemUseCase{problemRepo: problemRepo, tagRepo: tagRepo, cache: cache}
}

func (uc *updateProblemUseCase) Execute(ctx context.Context, claims auth.Claims, params dto.ProblemIDRequest, req dto.UpdateProblemRequest) (dto.ProblemDetailResponse, error) {
	if strings.TrimSpace(claims.UserID) == "" || !claims.Role.AtLeast(rbac.RoleUser) {
		return dto.ProblemDetailResponse{}, domain.ErrForbidden
	}

	var updated *entity.Problem
	err := uc.problemRepo.WithLockedProblem(ctx, params.ID, func(txCtx context.Context, locked *entity.Problem) error {
		if !claims.Role.AtLeast(rbac.RoleModerator) && (locked.AuthorID != claims.UserID || !locked.IsHidden) {
			return domain.ErrForbidden
		}
		updated = locked
		return uc.updateDraft(txCtx, locked, req)
	})
	if err != nil {
		return dto.ProblemDetailResponse{}, err
	}
	invalidateSubmissionProblemCache(ctx, uc.cache, params.ID)

	return dto.ProblemDetailResponse{
		ProblemResponse: usecase.MapProblemToResponse(updated, true),
	}, nil
}

func (uc *updateProblemUseCase) updateDraft(ctx context.Context, problem *entity.Problem, req dto.UpdateProblemRequest) error {
	if req.Title != nil {
		title := strings.TrimSpace(*req.Title)
		if title == "" {
			return response.NewAppError(response.CodeBadRequest, "title is required", nil)
		}
		problem.Title = title
	}

	if req.NewSlug != nil {
		slug := slugify(*req.NewSlug)
		existing, err := uc.problemRepo.GetBySlug(ctx, slug)
		if err == nil && existing.ID != problem.ID {
			return domain.ErrProblemAlreadyExists
		}
		if err != nil && !errors.Is(err, domain.ErrProblemNotFound) {
			return domain.ErrInternalServer.Wrap(err)
		}
		problem.TitleSlug = slug
	}

	if req.Description != nil {
		description := strings.TrimSpace(*req.Description)
		if description == "" {
			return response.NewAppError(response.CodeBadRequest, "description is required", nil)
		}
		problem.Description = description
	}
	if req.InputFormat != nil {
		inputFormat := strings.TrimSpace(*req.InputFormat)
		if inputFormat == "" {
			return response.NewAppError(response.CodeBadRequest, "input_format is required", nil)
		}
		problem.InputFormat = inputFormat
	}
	if req.OutputFormat != nil {
		outputFormat := strings.TrimSpace(*req.OutputFormat)
		if outputFormat == "" {
			return response.NewAppError(response.CodeBadRequest, "output_format is required", nil)
		}
		problem.OutputFormat = outputFormat
	}

	if req.Difficulty != nil {
		difficulty, err := normalizeDifficulty(*req.Difficulty)
		if err != nil {
			return err
		}
		problem.Difficulty = difficulty
	}

	if req.TagIDs != nil {
		tags, err := resolveProblemTags(ctx, uc.tagRepo, *req.TagIDs)
		if err != nil {
			return err
		}
		problem.Tags = tags
	}

	if req.Examples != nil {
		problem.Examples = usecase.MapExampleDTOsToEntity(*req.Examples)
	}
	if req.Constraints != nil {
		problem.Constraints = *req.Constraints
	}
	if req.Hints != nil {
		problem.Hints = *req.Hints
	}
	if req.TimeLimit != nil {
		problem.TimeLimit = *req.TimeLimit
	}
	if req.MemoryLimit != nil {
		problem.MemoryLimit = *req.MemoryLimit
	}

	if err := uc.problemRepo.Update(ctx, problem); err != nil {
		if errors.Is(err, domain.ErrProblemAlreadyExists) {
			return domain.ErrProblemAlreadyExists
		}
		return domain.ErrInternalServer.Wrap(err)
	}
	return nil
}
