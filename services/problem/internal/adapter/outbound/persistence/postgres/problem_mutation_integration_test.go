package postgres_test

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/config"
	"go-judge-system/pkg/database"
	"go-judge-system/pkg/rbac"
	"go-judge-system/pkg/schema"
	"go-judge-system/services/problem/internal/adapter/outbound/persistence/postgres"
	"go-judge-system/services/problem/internal/application/dto"
	"go-judge-system/services/problem/internal/application/port/outbound"
	problem "go-judge-system/services/problem/internal/application/usecase/admin/problem"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"

	"gorm.io/gorm"
)

func mutationFixture(t *testing.T) (*gorm.DB, outbound.ProblemRepository, outbound.TagRepository) {
	t.Helper()
	portText := os.Getenv("ASTRACODE_PROBLEM_MUTATION_TEST_PGPORT")
	if portText == "" {
		t.Skip("ASTRACODE_PROBLEM_MUTATION_TEST_PGPORT is unset (requires fresh disposable PostgreSQL)")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		t.Fatal("invalid fixture port")
	}
	db, err := database.ConnectDatabase(config.DatabaseConfig{
		Host: "127.0.0.1", Port: port, User: "problem_fixture", Password: "problem_fixture",
		DBName: "problem_mutation_test", SSLMode: "disable", MaxOpenConns: 4, MaxIdleConns: 4,
	})
	requireMutation(t, err)
	sqlDB, err := db.DB()
	requireMutation(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	requireMutation(t, schema.VerifyFixture(ctx, sqlDB, "problem"))
	return db, postgres.NewProblemRepository(db), postgres.NewTagRepository(db)
}

type mutationBarrierRepo struct {
	outbound.ProblemRepository
	beforeCommit func(context.Context) error
}

func (r mutationBarrierRepo) WithLockedProblem(ctx context.Context, id int64, write func(context.Context, *entity.Problem) error) error {
	return r.ProblemRepository.WithLockedProblem(ctx, id, func(txCtx context.Context, p *entity.Problem) error {
		if err := write(txCtx, p); err != nil {
			return err
		}
		return r.beforeCommit(txCtx)
	})
}

func requireMutation(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func waitForProblemLock(t *testing.T, ctx context.Context, db *gorm.DB) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		requireMutation(t, db.WithContext(ctx).Raw(`
			SELECT EXISTS (SELECT 1 FROM pg_stat_activity
				WHERE datname = current_database()
				  AND wait_event_type = 'Lock'
				  AND query LIKE '%FOR UPDATE%'
				  AND cardinality(pg_blocking_pids(pid)) > 0)
		`).Scan(&blocked).Error)
		if blocked {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("competing mutation did not reach the Problem row lock")
		case <-ticker.C:
		}
	}
}

func runProblemRace(t *testing.T, ctx context.Context, db *gorm.DB, repo outbound.ProblemRepository, first, second func(outbound.ProblemRepository) error) error {
	t.Helper()
	locked := make(chan struct{})
	release := make(chan struct{})
	firstResult, secondResult := make(chan error, 1), make(chan error, 1)
	go func() {
		firstResult <- first(mutationBarrierRepo{repo, func(ctx context.Context) error {
			close(locked)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}})
	}()
	select {
	case <-locked:
	case err := <-firstResult:
		t.Fatalf("first transaction failed before the barrier: %v", err)
	case <-ctx.Done():
		t.Fatal("first transaction did not reach its commit barrier")
	}
	go func() { secondResult <- second(repo) }()
	waitForProblemLock(t, ctx, db)
	close(release)
	requireMutation(t, <-firstResult)
	return <-secondResult
}

func TestProblemMutationPostgresConcurrency(t *testing.T) {
	db, repo, tags := mutationFixture(t)
	packages := postgres.NewTestCaseRepository(db)
	owner := auth.Claims{UserID: "owner", Role: rbac.RoleUser}
	staff := auth.Claims{UserID: "staff", Role: rbac.RoleModerator}
	tag := &entity.Tag{Name: "Race fixture", Slug: "race-fixture", IsActive: true}
	requireMutation(t, tags.Create(context.Background(), tag))

	for _, tc := range []struct {
		name, first, second string
		wantErr             error
		wantHidden          bool
	}{
		{"publication rejects waiting user edit", "publish", "edit", domain.ErrForbidden, false},
		{"publication rejects waiting user delete", "publish", "delete", domain.ErrForbidden, false},
		{"publication preserves prior edit", "edit", "publish", nil, false},
		{"hiding preserves prior edit", "edit", "hide", nil, true},
		{"deletion prevents publication", "delete", "publish", domain.ErrProblemNotFound, false},
		{"rollback preserves content and tags", "rollback", "", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			slug := strings.ReplaceAll(tc.name, " ", "-")
			p := entity.NewProblem("Original", slug, "description", "input", "output", entity.Easy, nil, nil, nil, nil, 1000, 256, "owner")
			p.IsHidden = true
			requireMutation(t, repo.Create(ctx, p))
			if tc.first == "delete" {
				requireMutation(t, packages.Upsert(ctx, entity.NewTestCase(p.ID, "original.zip", 1, 1)))
			}
			params := dto.ProblemIDRequest{ID: p.ID}
			title := "Edited"
			tagIDs := []uint{tag.ID}

			operation := func(name string) func(outbound.ProblemRepository) error {
				return func(r outbound.ProblemRepository) error {
					switch name {
					case "edit":
						_, err := problem.NewUpdateProblemUseCase(r, tags).Execute(ctx, owner, params, dto.UpdateProblemRequest{Title: &title, TagIDs: &tagIDs})
						return err
					case "publish":
						_, err := problem.NewPublishProblemUseCase(r).Execute(ctx, staff, params)
						return err
					case "hide":
						_, err := problem.NewHiddenProblemUseCase(r).Execute(ctx, staff, params)
						return err
					case "delete":
						return problem.NewDeleteProblemUseCase(r).Execute(ctx, owner, params)
					default:
						return errors.New("unrecognized test mutation")
					}
				}
			}
			if tc.first == "rollback" {
				injected := errors.New("abort after write")
				err := operation("edit")(mutationBarrierRepo{repo, func(context.Context) error { return injected }})
				if !errors.Is(err, injected) {
					t.Fatalf("rollback error = %v", err)
				}
			} else if err := runProblemRace(t, ctx, db, repo, operation(tc.first), operation(tc.second)); !errors.Is(err, tc.wantErr) {
				t.Fatalf("waiting mutation error = %v, want %v", err, tc.wantErr)
			}
			got, err := repo.GetByID(ctx, p.ID)
			if tc.first == "delete" {
				if !errors.Is(err, domain.ErrProblemNotFound) {
					t.Fatalf("read after soft deletion = %v", err)
				}
				pkg, err := packages.GetByProblemID(ctx, p.ID)
				requireMutation(t, err)
				if pkg.ZipObjectKey != "original.zip" {
					t.Fatalf("retained package key = %q", pkg.ZipObjectKey)
				}
				return
			}
			requireMutation(t, err)
			if got.IsHidden != tc.wantHidden {
				t.Fatalf("hidden = %t, want %t", got.IsHidden, tc.wantHidden)
			}
			if tc.first == "edit" {
				if got.Title != title || len(got.Tags) != 1 || got.Tags[0].ID != tag.ID {
					t.Fatalf("edit not preserved: title=%q tags=%v", got.Title, got.Tags)
				}
			} else if got.Title != "Original" || len(got.Tags) != 0 {
				t.Fatalf("unexpected edit: title=%q tags=%v", got.Title, got.Tags)
			}
		})
	}
}
