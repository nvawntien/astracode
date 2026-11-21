package problem

import (
	"context"
	"errors"
	"testing"

	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/application/dto"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

// statefulProblemRepository keeps committed writes so a later use case observes
// an earlier one, which the stateless access-matrix fake cannot do.
type statefulProblemRepository struct {
	outbound.ProblemRepository
	stored  entity.Problem
	deleted bool
}

func (r *statefulProblemRepository) WithLockedProblem(ctx context.Context, _ int64, mutate func(context.Context, *entity.Problem) error) error {
	if r.deleted {
		return domain.ErrProblemNotFound
	}
	locked := r.stored
	return mutate(ctx, &locked)
}

func (r *statefulProblemRepository) Update(_ context.Context, problem *entity.Problem) error {
	r.stored = *problem
	return nil
}

func (r *statefulProblemRepository) Delete(context.Context, int64) error {
	r.deleted = true
	return nil
}

func TestHidingPublishedContributionRestoresAuthorEditAndDelete(t *testing.T) {
	ctx := context.Background()
	repo := &statefulProblemRepository{stored: *matrixProblem("owner", false)}
	owner := matrixClaims(rbac.RoleUser, "owner")
	moderator := matrixClaims(rbac.RoleModerator, "moderator")
	params := dto.ProblemIDRequest{ID: 42}
	title := "Edited by author"
	edit := func() error {
		_, err := NewUpdateProblemUseCase(repo, nil).Execute(ctx, owner, params, dto.UpdateProblemRequest{Title: &title})
		return err
	}

	if err := edit(); !errors.Is(err, domain.ErrForbidden) || repo.stored.Title != "Owned problem" {
		t.Fatalf("author edit of Published problem = %v, title %q", err, repo.stored.Title)
	}
	if err := NewDeleteProblemUseCase(repo).Execute(ctx, owner, params); !errors.Is(err, domain.ErrForbidden) || repo.deleted {
		t.Fatalf("author delete of Published problem = %v, deleted %t", err, repo.deleted)
	}

	if _, err := NewHiddenProblemUseCase(repo).Execute(ctx, moderator, params); err != nil || !repo.stored.IsHidden {
		t.Fatalf("hide = %v, hidden %t", err, repo.stored.IsHidden)
	}

	if err := edit(); err != nil || repo.stored.Title != title {
		t.Fatalf("author edit after hide = %v, title %q", err, repo.stored.Title)
	}
	if err := NewDeleteProblemUseCase(repo).Execute(ctx, owner, params); err != nil || !repo.deleted {
		t.Fatalf("author delete after hide = %v, deleted %t", err, repo.deleted)
	}
	if err := edit(); !errors.Is(err, domain.ErrProblemNotFound) {
		t.Fatalf("edit after deletion = %v, want not found", err)
	}
}

func TestHidingAlreadyHiddenProblemSucceedsAndStaysHidden(t *testing.T) {
	for _, role := range []rbac.Role{rbac.RoleModerator, rbac.RoleAdmin} {
		t.Run(string(role), func(t *testing.T) {
			repo := &statefulProblemRepository{stored: *matrixProblem("owner", true)}
			_, err := NewHiddenProblemUseCase(repo).Execute(context.Background(), matrixClaims(role, "staff"), dto.ProblemIDRequest{ID: 42})
			if err != nil || !repo.stored.IsHidden {
				t.Fatalf("hide already hidden = %v, hidden %t", err, repo.stored.IsHidden)
			}
		})
	}
}
