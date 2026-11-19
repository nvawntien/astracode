package user

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/submission/internal/application/dto"
	"go-judge-system/services/submission/internal/application/port/outbound"
	"go-judge-system/services/submission/internal/domain"
	"go-judge-system/services/submission/internal/domain/entity"
)

type fakeGetSubmissionRepository struct {
	submission *entity.Submission
	err        error
	summary    outbound.SubmissionResultSummary
	calls      int
	id         int64
	ownerID    *string
}

func newFakeGetSubmissionRepository(submission *entity.Submission) *fakeGetSubmissionRepository {
	return &fakeGetSubmissionRepository{submission: submission}
}

func (r *fakeGetSubmissionRepository) GetCurrentDetail(
	ctx context.Context, id int64, ownerID *string,
) (*entity.Submission, outbound.SubmissionResultSummary, error) {
	r.calls++
	r.id = id
	r.ownerID = ownerID
	if err := ctx.Err(); err != nil {
		return nil, outbound.SubmissionResultSummary{}, err
	}
	if r.err != nil {
		return nil, outbound.SubmissionResultSummary{}, r.err
	}
	if r.submission == nil || r.submission.ID != id || (ownerID != nil && *ownerID != r.submission.UserID) {
		return nil, outbound.SubmissionResultSummary{}, domain.ErrSubmissionNotFound
	}
	return r.submission, r.summary, nil
}

func submissionDetailFixture(ownerID string) *entity.Submission {
	executionTime := 12
	memoryUsed := 4300
	compileOutput := "main.go:8:2: undefined: fmtx"
	return &entity.Submission{
		ID:            77,
		ProblemID:     42,
		ProblemName:   "Two Sum",
		UserID:        ownerID,
		Username:      "owner-name",
		Language:      entity.LanguageGo,
		SourceCode:    "package main\n",
		Status:        entity.StatusCompilationError,
		ExecutionTime: &executionTime,
		MemoryUsed:    &memoryUsed,
		CompileOutput: &compileOutput,
		CreatedAt:     time.Date(2026, 7, 23, 14, 0, 0, 0, time.UTC),
		UpdatedAt:     time.Date(2026, 7, 23, 14, 1, 0, 0, time.UTC),
	}
}

func TestGetSubmissionAccessMatrix(t *testing.T) {
	tests := []struct {
		name        string
		role        rbac.Role
		actorUserID string
		wantErr     error
	}{
		{name: "user reads own submission", role: rbac.RoleUser, actorUserID: "owner"},
		{name: "user reads another submission", role: rbac.RoleUser, actorUserID: "another", wantErr: domain.ErrSubmissionNotFound},
		{name: "contributor reads own submission", role: rbac.RoleContributor, actorUserID: "owner"},
		{name: "contributor reads another submission", role: rbac.RoleContributor, actorUserID: "another", wantErr: domain.ErrSubmissionNotFound},
		{name: "moderator reads own submission", role: rbac.RoleModerator, actorUserID: "owner"},
		{name: "moderator reads another submission", role: rbac.RoleModerator, actorUserID: "another"},
		{name: "admin reads own submission", role: rbac.RoleAdmin, actorUserID: "owner"},
		{name: "admin reads another submission", role: rbac.RoleAdmin, actorUserID: "another"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			submission := submissionDetailFixture("owner")
			submission.CurrentAttemptID = "attempt-77"
			repo := newFakeGetSubmissionRepository(submission)
			repo.summary = outbound.SubmissionResultSummary{SubmissionID: submission.ID, Passed: 4, Total: 20}
			uc := NewGetSubmissionUseCase(repo)

			got, err := uc.Execute(
				context.Background(),
				auth.Claims{UserID: tt.actorUserID, Role: tt.role},
				dto.GetSubmissionRequest{SubmissionID: submission.ID},
			)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Execute() error = %v, want %v", err, tt.wantErr)
			}
			if repo.calls != 1 || repo.id != submission.ID {
				t.Fatalf("repository calls/id = %d/%d, want 1/%d", repo.calls, repo.id, submission.ID)
			}
			if tt.role == rbac.RoleUser || tt.role == rbac.RoleContributor {
				if repo.ownerID == nil || *repo.ownerID != tt.actorUserID {
					t.Fatalf("restricted read has wrong owner filter: %v", repo.ownerID)
				}
			} else if repo.ownerID != nil {
				t.Fatalf("privileged read has an owner filter: %v", repo.ownerID)
			}
			if tt.wantErr != nil {
				if got != (dto.GetSubmissionResponse{}) {
					t.Fatalf("response = %+v, want zero value", got)
				}
				return
			}
			want := dto.GetSubmissionResponse{
				ID:              submission.ID,
				AttemptID:       &submission.CurrentAttemptID,
				ProblemID:       submission.ProblemID,
				ProblemTitle:    submission.ProblemName,
				UserID:          submission.UserID,
				Username:        submission.Username,
				Language:        string(submission.Language),
				SourceCode:      submission.SourceCode,
				Status:          string(submission.Status),
				ExecutionTimeMS: submission.ExecutionTime,
				MemoryUsedKB:    submission.MemoryUsed,
				PassedTestCases: intPointer(4),
				TotalTestCases:  intPointer(20),
				CompileOutput:   submission.CompileOutput,
				ErrorMessage:    nil,
				CreatedAt:       submission.CreatedAt,
				UpdatedAt:       submission.UpdatedAt,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("response = %+v, want %+v", got, want)
			}
			if got.ProblemTitle != "Two Sum" {
				t.Fatalf("ProblemTitle = %q, want ProblemName snapshot", got.ProblemTitle)
			}
		})
	}
}

func TestGetSubmissionReturnsStoredRuntimeErrorMessage(t *testing.T) {
	submission := submissionDetailFixture("owner")
	runtimeError := "panic: runtime error: index out of range"
	submission.Status = entity.StatusRuntimeError
	submission.CompileOutput = nil
	submission.ErrorMessage = &runtimeError
	repo := newFakeGetSubmissionRepository(submission)
	uc := NewGetSubmissionUseCase(repo)

	got, err := uc.Execute(
		context.Background(),
		auth.Claims{UserID: "owner", Role: rbac.RoleUser},
		dto.GetSubmissionRequest{SubmissionID: submission.ID},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if got.CompileOutput != nil {
		t.Fatalf("compile_output = %v, want nil for runtime error", got.CompileOutput)
	}
	if got.ErrorMessage == nil || *got.ErrorMessage != runtimeError {
		t.Fatalf("error_message = %v, want %q", got.ErrorMessage, runtimeError)
	}
}

func TestGetSubmissionValidation(t *testing.T) {
	tests := []struct {
		name    string
		claims  auth.Claims
		req     dto.GetSubmissionRequest
		wantErr error
	}{
		{
			name:    "zero submission ID",
			claims:  auth.Claims{UserID: "actor", Role: rbac.RoleUser},
			wantErr: domain.ErrInvalidSubmissionID,
		},
		{
			name:    "negative submission ID",
			claims:  auth.Claims{UserID: "actor", Role: rbac.RoleUser},
			req:     dto.GetSubmissionRequest{SubmissionID: -1},
			wantErr: domain.ErrInvalidSubmissionID,
		},
		{
			name:    "missing actor user ID",
			claims:  auth.Claims{Role: rbac.RoleUser},
			req:     dto.GetSubmissionRequest{SubmissionID: 77},
			wantErr: domain.ErrSubmissionUnauthenticated,
		},
		{
			name:    "missing actor role",
			claims:  auth.Claims{UserID: "actor"},
			req:     dto.GetSubmissionRequest{SubmissionID: 77},
			wantErr: domain.ErrSubmissionUnauthenticated,
		},
		{
			name:    "unsupported actor role",
			claims:  auth.Claims{UserID: "actor", Role: rbac.Role("auditor")},
			req:     dto.GetSubmissionRequest{SubmissionID: 77},
			wantErr: domain.ErrSubmissionForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := newFakeGetSubmissionRepository(submissionDetailFixture("actor"))
			uc := NewGetSubmissionUseCase(repo)

			_, err := uc.Execute(context.Background(), tt.claims, tt.req)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Execute() error = %v, want %v", err, tt.wantErr)
			}
			if repo.calls != 0 {
				t.Fatalf("repository calls = %d, want 0", repo.calls)
			}
		})
	}
}

func TestGetSubmissionRepositoryErrors(t *testing.T) {
	databaseErr := errors.New("database unavailable")
	tests := []struct {
		name    string
		repoErr error
		wantErr error
	}{
		{name: "missing submission", repoErr: domain.ErrSubmissionNotFound, wantErr: domain.ErrSubmissionNotFound},
		{name: "repository failure", repoErr: databaseErr, wantErr: domain.ErrInternalServer},
		{name: "repository deadline", repoErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := newFakeGetSubmissionRepository(nil)
			repo.err = tt.repoErr
			uc := NewGetSubmissionUseCase(repo)

			_, err := uc.Execute(
				context.Background(),
				auth.Claims{UserID: "actor", Role: rbac.RoleUser},
				dto.GetSubmissionRequest{SubmissionID: 77},
			)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Execute() error = %v, want %v", err, tt.wantErr)
			}
			if repo.calls != 1 {
				t.Fatalf("repository calls = %d, want 1", repo.calls)
			}
			if tt.repoErr == databaseErr && !errors.Is(err, databaseErr) {
				t.Fatalf("Execute() error = %v, want wrapped repository error", err)
			}
		})
	}
}

func TestGetSubmissionPreservesSummaryAndLegacySemantics(t *testing.T) {
	for _, tc := range []struct {
		name, attemptID       string
		status                entity.Status
		passed, total         int
		wantPassed, wantTotal *int
	}{
		{"pending without results", "attempt-77", entity.StatusPending, 0, 0, nil, nil},
		{"terminal without results", "attempt-77", entity.StatusCompilationError, 0, 0, intPointer(0), intPointer(0)},
		{"current attempt with zero passing", "attempt-77", entity.StatusWrongAnswer, 0, 3, intPointer(0), intPointer(3)},
		{"legacy with result rows", "", entity.StatusAccepted, 2, 3, intPointer(2), intPointer(3)},
		{"blank legacy identity", "  ", entity.StatusAccepted, 0, 0, intPointer(0), intPointer(0)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			submission := submissionDetailFixture("actor")
			submission.Status = tc.status
			submission.CurrentAttemptID = tc.attemptID
			repo := newFakeGetSubmissionRepository(submission)
			repo.summary = outbound.SubmissionResultSummary{SubmissionID: submission.ID, Passed: tc.passed, Total: tc.total}
			got, err := NewGetSubmissionUseCase(repo).Execute(
				context.Background(),
				auth.Claims{UserID: "actor", Role: rbac.RoleUser},
				dto.GetSubmissionRequest{SubmissionID: submission.ID},
			)
			if err != nil {
				t.Fatal(err)
			}
			var wantAttempt *string
			if tc.attemptID == "attempt-77" {
				wantAttempt = &tc.attemptID
			}
			if got.Status != string(tc.status) || !reflect.DeepEqual(got.AttemptID, wantAttempt) ||
				!reflect.DeepEqual(got.PassedTestCases, tc.wantPassed) || !reflect.DeepEqual(got.TotalTestCases, tc.wantTotal) {
				t.Fatalf("unexpected response: %+v", got)
			}
		})
	}
}

func TestGetSubmissionPreservesContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	repo := newFakeGetSubmissionRepository(submissionDetailFixture("actor"))
	uc := NewGetSubmissionUseCase(repo)
	_, err := uc.Execute(
		ctx,
		auth.Claims{UserID: "actor", Role: rbac.RoleUser},
		dto.GetSubmissionRequest{SubmissionID: 77},
	)

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Execute() error = %v, want context canceled", err)
	}
	if errors.Is(err, domain.ErrInternalServer) {
		t.Fatalf("context cancellation must not be remapped to internal error: %v", err)
	}
}

func TestGetSubmissionReportsCurrentAttempt(t *testing.T) {
	submission := submissionDetailFixture("owner")
	submission.CurrentAttemptID = "attempt-77"
	repo := newFakeGetSubmissionRepository(submission)
	got, err := NewGetSubmissionUseCase(repo).Execute(
		context.Background(),
		auth.Claims{UserID: "owner", Role: rbac.RoleUser},
		dto.GetSubmissionRequest{SubmissionID: submission.ID},
	)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	if field, present := fields["attempt_id"]; !present || string(field) != `"attempt-77"` {
		t.Fatalf("attempt_id = %q (present=%t), want current attempt", []byte(field), present)
	}
}
