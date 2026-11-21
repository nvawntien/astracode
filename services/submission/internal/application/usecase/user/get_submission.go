package user

import (
	"context"
	"errors"
	"strings"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/submission/internal/application/dto"
	inbound "go-judge-system/services/submission/internal/application/port/inbound/user"
	"go-judge-system/services/submission/internal/application/port/outbound"
	"go-judge-system/services/submission/internal/domain"
)

type getSubmissionUseCase struct {
	detailRepo outbound.CurrentSubmissionDetailRepository
}

func NewGetSubmissionUseCase(detailRepo outbound.CurrentSubmissionDetailRepository) inbound.GetSubmissionUseCase {
	return &getSubmissionUseCase{detailRepo: detailRepo}
}

func (uc *getSubmissionUseCase) Execute(ctx context.Context, claims auth.Claims, req dto.GetSubmissionRequest) (dto.GetSubmissionResponse, error) {
	if req.SubmissionID <= 0 {
		return dto.GetSubmissionResponse{}, domain.ErrInvalidSubmissionID
	}
	if strings.TrimSpace(claims.UserID) == "" || claims.Role == "" {
		return dto.GetSubmissionResponse{}, domain.ErrSubmissionUnauthenticated
	}

	var ownerID *string
	switch claims.Role {
	case rbac.RoleUser:
		ownerID = &claims.UserID
	case rbac.RoleModerator, rbac.RoleAdmin:
	default:
		return dto.GetSubmissionResponse{}, domain.ErrSubmissionForbidden
	}

	submission, summary, err := uc.detailRepo.GetCurrentDetail(ctx, req.SubmissionID, ownerID)
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrSubmissionNotFound):
			return dto.GetSubmissionResponse{}, domain.ErrSubmissionNotFound
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			return dto.GetSubmissionResponse{}, err
		default:
			return dto.GetSubmissionResponse{}, domain.ErrInternalServer.Wrap(err)
		}
	}
	if submission == nil {
		return dto.GetSubmissionResponse{}, domain.ErrInternalServer
	}

	var attemptID *string
	if strings.TrimSpace(submission.CurrentAttemptID) != "" {
		attemptID = &submission.CurrentAttemptID
	}
	passed, total := testcaseSummaryForStatus(submission.Status, summary, summary.Total > 0)

	return dto.GetSubmissionResponse{
		ID:              submission.ID,
		AttemptID:       attemptID,
		ProblemID:       submission.ProblemID,
		ProblemTitle:    submission.ProblemName,
		UserID:          submission.UserID,
		Username:        submission.Username,
		Language:        string(submission.Language),
		SourceCode:      submission.SourceCode,
		Status:          string(submission.Status),
		ExecutionTimeMS: submission.ExecutionTime,
		MemoryUsedKB:    submission.MemoryUsed,
		PassedTestCases: passed,
		TotalTestCases:  total,
		CompileOutput:   submission.CompileOutput,
		ErrorMessage:    submission.ErrorMessage,
		CreatedAt:       submission.CreatedAt,
		UpdatedAt:       submission.UpdatedAt,
	}, nil
}
