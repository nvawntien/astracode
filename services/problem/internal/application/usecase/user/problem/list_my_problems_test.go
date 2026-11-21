package problem

import (
	"context"
	"errors"
	"testing"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/application/dto"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

type listMyProblemRepository struct {
	outbound.ProblemRepository
	authorID string
	tagSlug  string
	problems []*entity.Problem
}

func (r *listMyProblemRepository) ListByAuthor(_ context.Context, authorID string, _, _ int, _, _, tagSlug string) ([]*entity.Problem, error) {
	r.authorID = authorID
	r.tagSlug = tagSlug
	return r.problems, nil
}

func (r *listMyProblemRepository) CountByAuthor(_ context.Context, authorID, _, _, _ string) (int64, error) {
	r.authorID = authorID
	return int64(len(r.problems)), nil
}

func TestListMyProblemsRoleAndOwnershipMatrix(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		role    rbac.Role
		allowed bool
	}{
		{role: rbac.RoleUser, allowed: true},
		{role: rbac.RoleModerator, allowed: true},
		{role: rbac.RoleAdmin, allowed: true},
		{role: "contributor"},
		{role: "owner"},
	} {
		t.Run(string(test.role), func(t *testing.T) {
			t.Parallel()
			repository := &listMyProblemRepository{problems: []*entity.Problem{
				{ID: 1, AuthorID: "actor", IsHidden: true},
				{ID: 2, AuthorID: "actor"},
			}}
			response, err := NewListMyProblemsUseCase(repository).Execute(
				context.Background(), auth.Claims{Role: test.role, UserID: "actor"}, dto.ListProblemsRequest{TagSlug: " Inactive-Tag "},
			)
			if !test.allowed {
				if !errors.Is(err, domain.ErrForbidden) || repository.authorID != "" {
					t.Fatalf("error/author = %v/%q, want forbidden and no query", err, repository.authorID)
				}
				return
			}
			if err != nil || repository.authorID != "actor" || repository.tagSlug != "inactive-tag" ||
				len(response.Items) != 2 || response.Items[0].AuthorID != "actor" || response.Items[1].AuthorID != "actor" {
				t.Fatalf("response/error/author = %+v/%v/%q", response, err, repository.authorID)
			}
		})
	}
}

func TestListMyProblemsEmptyCatalogAndMissingIdentity(t *testing.T) {
	repository := &listMyProblemRepository{}
	useCase := NewListMyProblemsUseCase(repository)
	if _, err := useCase.Execute(context.Background(), auth.Claims{}, dto.ListProblemsRequest{}); !errors.Is(err, domain.ErrActorUnauthenticated) || repository.authorID != "" {
		t.Fatalf("missing identity: error = %v, author = %q", err, repository.authorID)
	}
	result, err := useCase.Execute(context.Background(), auth.Claims{Role: rbac.RoleUser, UserID: "actor"}, dto.ListProblemsRequest{})
	if err != nil || result.Items == nil || len(result.Items) != 0 || result.Total != 0 {
		t.Fatalf("empty catalog: result = %+v, error = %v", result, err)
	}
}
