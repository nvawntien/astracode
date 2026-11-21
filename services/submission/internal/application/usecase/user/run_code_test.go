package user

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/pkg/response"
	"go-judge-system/services/submission/internal/application/dto"
	"go-judge-system/services/submission/internal/application/port/outbound"
	"go-judge-system/services/submission/internal/domain"
)

func TestRunCodeRequiresAuthorizedProblemActor(t *testing.T) {
	unauthorized := response.NewAppError(response.CodeUnauthorized, "unauthorized", nil)
	for _, test := range []struct {
		name     string
		userID   string
		role     rbac.Role
		lookup   bool
		notFound bool
		wantErr  error
	}{
		{name: "owner user", userID: "owner", role: rbac.RoleUser, lookup: true},
		{name: "other user", userID: "other", role: rbac.RoleUser, lookup: true, notFound: true, wantErr: domain.ErrProblemNotFound},
		{name: "moderator", userID: "staff", role: rbac.RoleModerator, lookup: true},
		{name: "admin", userID: "staff", role: rbac.RoleAdmin, lookup: true},
		{name: "missing identity", role: rbac.RoleUser, wantErr: unauthorized},
		{name: "missing role", userID: "owner", wantErr: unauthorized},
		{name: "retired role", userID: "owner", role: "contributor", wantErr: domain.ErrProblemActorForbidden},
		{name: "unknown role", userID: "owner", role: "owner", wantErr: domain.ErrProblemActorForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			problems := validProblemReader(1)
			if test.notFound {
				problems.err = domain.ErrProblemNotFound
			}
			runner := &stubJudgeRunner{}
			useCase := NewRunCodeUseCase(problems, runner, dto.RunCodeLimits{})
			req := validRunRequest([]dto.RunTestCaseInput{{ID: "custom-1", Kind: "custom"}})
			_, err := useCase.Execute(context.Background(), auth.Claims{UserID: test.userID, Role: test.role}, req)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
			if test.lookup {
				if problems.calls != 1 || problems.actor != (dto.ProblemActor{UserID: test.userID, Role: test.role}) {
					t.Fatalf("problem calls/actor = %d/%+v", problems.calls, problems.actor)
				}
			} else if problems.calls != 0 {
				t.Fatalf("problem calls = %d, want zero", problems.calls)
			}
			if (test.wantErr == nil && runner.calls != 1) || (test.wantErr != nil && runner.calls != 0) {
				t.Fatalf("runner calls = %d with error %v", runner.calls, err)
			}
		})
	}
}

func TestRunCodeUseCaseValidation(t *testing.T) {
	claims := auth.Claims{UserID: "u1", Username: "alice", Role: rbac.RoleUser}

	tests := []struct {
		name string
		req  dto.RunCodeRequest
		want error
	}{
		{
			name: "duplicate testcase IDs",
			req:  validRunRequest([]dto.RunTestCaseInput{{ID: "case-1", Kind: "sample", Stdin: "1\n", ExpectedOutput: stringPtr("1\n")}, {ID: "case-1", Kind: "custom", Stdin: "2\n"}}),
			want: domain.ErrInvalidRunTestCase,
		},
		{
			name: "blank testcase ID",
			req:  validRunRequest([]dto.RunTestCaseInput{{ID: " \t", Kind: "custom"}}),
			want: domain.ErrInvalidRunTestCase,
		},
		{
			name: "empty testcase array",
			req:  validRunRequest(nil),
			want: domain.ErrInvalidRunTestCase,
		},
		{
			name: "sample requires expected output",
			req:  validRunRequest([]dto.RunTestCaseInput{{ID: "sample-1", Kind: "sample", Stdin: "1\n"}}),
			want: domain.ErrInvalidRunTestCase,
		},
		{
			name: "unsupported language",
			req:  dto.RunCodeRequest{ProblemID: 1, Language: "JAVASCRIPT", SourceCode: "code", TestCases: []dto.RunTestCaseInput{{ID: "custom-1", Kind: "custom", Stdin: "1\n"}}},
			want: domain.ErrUnsupportedRunLanguage,
		},
		{
			name: "custom expected output optional",
			req:  validRunRequest([]dto.RunTestCaseInput{{ID: "custom-1", Kind: "custom", Stdin: "1\n"}}),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			judge := &stubJudgeRunner{}
			uc := NewRunCodeUseCase(&stubProblemReader{}, judge, dto.RunCodeLimits{RequestTimeout: time.Second})
			_, err := uc.Execute(context.Background(), claims, tt.req)
			if tt.want == nil {
				if err != nil {
					t.Fatalf("Execute() error = %v, want nil", err)
				}
				if judge.calls != 1 {
					t.Fatalf("Judge calls = %d, want 1", judge.calls)
				}
				return
			}
			if !errors.Is(err, tt.want) {
				t.Fatalf("Execute() error = %v, want %v", err, tt.want)
			}
			if judge.calls != 0 {
				t.Fatalf("Judge calls = %d, want 0", judge.calls)
			}
		})
	}
}

func TestRunCodeUseCaseTestcaseCount(t *testing.T) {
	for _, tt := range []struct {
		name       string
		configured int
		count      int
		wantErr    bool
	}{
		{name: "default accepts ten", count: 10},
		{name: "default rejects eleven", count: 11, wantErr: true},
		{name: "configured cap accepts two", configured: 2, count: 2},
		{name: "configured cap rejects three", configured: 2, count: 3, wantErr: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cases := make([]dto.RunTestCaseInput, tt.count)
			for i := range cases {
				cases[i] = dto.RunTestCaseInput{ID: fmt.Sprintf("custom-%d", i+1), Kind: "custom"}
			}
			judge := &stubJudgeRunner{}
			uc := NewRunCodeUseCase(&stubProblemReader{}, judge, dto.RunCodeLimits{MaxTestCases: tt.configured})
			result, err := uc.Execute(context.Background(), auth.Claims{UserID: "u1", Role: rbac.RoleUser}, validRunRequest(cases))
			if tt.wantErr {
				if !errors.Is(err, domain.ErrInvalidRunTestCase) || judge.calls != 0 {
					t.Fatalf("Execute() error = %v, Judge calls = %d, want invalid testcase error and zero calls", err, judge.calls)
				}
				return
			}
			if err != nil || judge.calls != 1 || len(result.Tests) != tt.count {
				t.Fatalf("Execute() error = %v, Judge calls = %d, results = %d, want success with %d cases", err, judge.calls, len(result.Tests), tt.count)
			}
		})
	}
}

func TestRunCodeUseCasePreservesResultOrder(t *testing.T) {
	uc := NewRunCodeUseCase(&stubProblemReader{}, &stubJudgeRunner{}, dto.RunCodeLimits{RequestTimeout: time.Second})
	res, err := uc.Execute(
		context.Background(),
		auth.Claims{UserID: "u1", Username: "alice", Role: rbac.RoleUser},
		validRunRequest([]dto.RunTestCaseInput{
			{ID: "sample-1", Kind: "sample", Stdin: "1\n", ExpectedOutput: stringPtr("1\n")},
			{ID: "custom-1", Kind: "custom", Stdin: "2\n"},
		}),
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if got := []string{res.Tests[0].ID, res.Tests[1].ID}; got[0] != "sample-1" || got[1] != "custom-1" {
		t.Fatalf("result order = %v, want [sample-1 custom-1]", got)
	}
}

func TestRunCodeUseCaseForwardsNormalizedProblemLimits(t *testing.T) {
	for _, tt := range []struct {
		name   string
		time   float64
		memory int
		wantMS int64
		wantKB int64
	}{
		{"fractional seconds", 0.5, 128, 500, 131_072},
		{"one second", 1, 512, 1_000, 524_288},
		{"two seconds", 2, 256, 2_000, 262_144},
		{"legacy one second", 1000, 1024, 1_000, 1_048_576},
		{"legacy two seconds", 2000, 512, 2_000, 524_288},
		{"legacy threshold", 50, 512, 50, 524_288},
		{"configured defaults", 0, -1, 3_100, 65_536},
	} {
		t.Run(tt.name, func(t *testing.T) {
			runner := &stubJudgeRunner{}
			metadata := dto.ProblemMetadata{TimeLimit: tt.time, MemoryLimit: tt.memory}
			uc := NewRunCodeUseCase(&stubProblemReader{metadata: &metadata}, runner, dto.RunCodeLimits{
				DefaultTimeLimit: 3100 * time.Millisecond, DefaultMemoryLimitKB: 65_536,
			})
			_, err := uc.Execute(
				context.Background(),
				auth.Claims{UserID: "u1", Role: rbac.RoleUser},
				validRunRequest([]dto.RunTestCaseInput{{ID: "custom-1", Kind: "custom"}}),
			)
			if err != nil {
				t.Fatal(err)
			}
			if got := runner.request; got.TimeLimitMS != tt.wantMS || got.MemoryLimitKB != tt.wantKB {
				t.Fatalf("Run request limits = %d ms / %d KiB, want %d / %d", got.TimeLimitMS, got.MemoryLimitKB, tt.wantMS, tt.wantKB)
			}
		})
	}
}

func validRunRequest(testCases []dto.RunTestCaseInput) dto.RunCodeRequest {
	return dto.RunCodeRequest{
		ProblemID:  1,
		Language:   "GO",
		SourceCode: "package main\nfunc main() {}\n",
		TestCases:  testCases,
	}
}

type stubProblemReader struct{ metadata *dto.ProblemMetadata }

func (s *stubProblemReader) GetProblem(context.Context, int64, dto.ProblemActor) (dto.ProblemMetadata, error) {
	if s.metadata != nil {
		return *s.metadata, nil
	}
	return dto.ProblemMetadata{ID: 1, Title: "Two Sum", Slug: "two-sum", TimeLimit: 2, MemoryLimit: 256}, nil
}

func (s *stubProblemReader) GetTestCaseMetadata(context.Context, int64) (dto.ProblemTestCaseMetadata, error) {
	return dto.ProblemTestCaseMetadata{}, nil
}

type stubJudgeRunner struct {
	calls   int
	request outbound.JudgeRunRequest
}

func (s *stubJudgeRunner) RunCode(_ context.Context, req outbound.JudgeRunRequest) (dto.RunCodeResponse, error) {
	s.calls++
	s.request = req
	tests := make([]dto.RunTestCaseResult, 0, len(req.TestCases))
	for _, tc := range req.TestCases {
		tests = append(tests, dto.RunTestCaseResult{ID: tc.ID, Kind: tc.Kind, Status: "executed"})
	}
	return dto.RunCodeResponse{Status: "completed", Tests: tests}, nil
}

func stringPtr(value string) *string {
	return &value
}
