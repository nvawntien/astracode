package postgres_test

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"maps"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/adapter/outbound/persistence/postgres"
	"go-judge-system/services/problem/internal/application/dto"
	"go-judge-system/services/problem/internal/application/port/outbound"
	problem "go-judge-system/services/problem/internal/application/usecase/admin/problem"
	testcase "go-judge-system/services/problem/internal/application/usecase/admin/testcase"
	"go-judge-system/services/problem/internal/domain"
	"go-judge-system/services/problem/internal/domain/entity"
)

type mutationStorage struct {
	outbound.TestCaseStorage
	mu         sync.Mutex
	objects    map[string][]byte
	afterPut   func(context.Context) error
	uploadErr  error
	cleanupErr error
}

func (s *mutationStorage) UploadTestCase(ctx context.Context, key, path string) error {
	if s.uploadErr != nil {
		return s.uploadErr
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	s.mu.Lock()
	_, exists := s.objects[key]
	if !exists {
		s.objects[key] = data
	}
	s.mu.Unlock()
	if exists {
		return errors.New("staging object key was reused")
	}
	if s.afterPut != nil {
		return s.afterPut(ctx)
	}
	return nil
}

func (s *mutationStorage) DeleteTestCase(_ context.Context, key string) error {
	if s.cleanupErr != nil {
		return s.cleanupErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	return nil
}

func (s *mutationStorage) keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Sorted(maps.Keys(s.objects))
}

func (s *mutationStorage) ListTestCasesByPrefix(_ context.Context, prefix string) ([]string, error) {
	var matches []string
	for _, key := range s.keys() {
		if strings.HasPrefix(key, prefix) {
			matches = append(matches, key)
		}
	}
	return matches, nil
}

type uncertainMutationRepo struct{ outbound.ProblemRepository }

func (r uncertainMutationRepo) WithLockedProblem(ctx context.Context, id int64, write func(context.Context, *entity.Problem) error) error {
	if err := r.ProblemRepository.WithLockedProblem(ctx, id, write); err != nil {
		return err
	}
	return outbound.ErrMutationCommitUncertain
}

func testcaseUploadRequest(t *testing.T) dto.UploadTestCaseRequest {
	t.Helper()
	var archive bytes.Buffer
	zipper := zip.NewWriter(&archive)
	for _, name := range []string{"1.in", "1.out"} {
		file, err := zipper.Create(name)
		requireMutation(t, err)
		_, err = file.Write([]byte("fixture\n"))
		requireMutation(t, err)
	}
	requireMutation(t, zipper.Close())

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "fixture.zip")
	requireMutation(t, err)
	_, err = file.Write(archive.Bytes())
	requireMutation(t, err)
	requireMutation(t, form.Close())
	request := httptest.NewRequest("POST", "/", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	requireMutation(t, request.ParseMultipartForm(1<<20))
	t.Cleanup(func() { _ = request.MultipartForm.RemoveAll() })
	return dto.UploadTestCaseRequest{File: request.MultipartForm.File["file"][0]}
}

func TestTestcaseMutationPostgresConcurrency(t *testing.T) {
	db, repo, _ := mutationFixture(t)
	packages := postgres.NewTestCaseRepository(db)
	owner := auth.Claims{UserID: "owner", Role: rbac.RoleUser}
	staff := auth.Claims{UserID: "staff", Role: rbac.RoleModerator}
	uploadRequest := testcaseUploadRequest(t)
	for _, name := range []string{
		"publish during upload", "publish before delete", "concurrent replacements", "delete before replacement",
		"failed upload", "rollback staged replacement", "rollback cleanup failure", "uncertain replacement commit",
		"rollback logical deletion", "uncertain deletion commit",
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			p := entity.NewProblem("Fixture", strings.ReplaceAll(name, " ", "-"), "description", "input", "output", entity.Easy, nil, nil, nil, nil, 1000, 256, "owner")
			p.IsHidden = true
			requireMutation(t, repo.Create(ctx, p))
			params := dto.ProblemIDRequest{ID: p.ID}
			original := entity.NewTestCase(p.ID, "original.zip", 1, 1)
			requireMutation(t, packages.Upsert(ctx, original))
			storage := &mutationStorage{objects: map[string][]byte{original.ZipObjectKey: []byte("original")}}
			upload := func(r outbound.ProblemRepository) (dto.TestCaseMetadataResponse, error) {
				return testcase.NewUploadTestCaseUseCase(r, packages, storage).Execute(ctx, owner, params, uploadRequest)
			}
			deletePackage := func(r outbound.ProblemRepository) error {
				return testcase.NewDeleteTestCaseUseCase(r, packages).Execute(ctx, owner, params)
			}
			publish := func(r outbound.ProblemRepository) error {
				_, err := problem.NewPublishProblemUseCase(r).Execute(ctx, staff, params)
				return err
			}

			wantVersion, wantObjects := 1, 1
			wantOriginal := true
			injected := errors.New("injected fixture failure")
			rollback := mutationBarrierRepo{repo, func(context.Context) error { return injected }}
			switch name {
			case "publish during upload":
				staged, release := make(chan struct{}), make(chan struct{})
				storage.afterPut = func(ctx context.Context) error {
					close(staged)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				finished := make(chan error, 1)
				go func() {
					_, err := upload(repo)
					finished <- err
				}()
				select {
				case <-staged:
				case err := <-finished:
					t.Fatalf("upload failed before staging: %v", err)
				case <-ctx.Done():
					t.Fatal("staging barrier not reached")
				}
				requireMutation(t, publish(repo))
				close(release)
				if err := <-finished; !errors.Is(err, domain.ErrForbidden) {
					t.Fatalf("upload after publication = %v", err)
				}
			case "publish before delete":
				if err := runProblemRace(t, ctx, db, repo, publish, deletePackage); !errors.Is(err, domain.ErrForbidden) {
					t.Fatalf("delete after publication = %v", err)
				}
			case "concurrent replacements":
				var first, second dto.TestCaseMetadataResponse
				requireMutation(t, runProblemRace(t, ctx, db, repo, func(r outbound.ProblemRepository) error {
					var err error
					first, err = upload(r)
					return err
				}, func(r outbound.ProblemRepository) error {
					var err error
					second, err = upload(r)
					return err
				}))
				if first.Version != 2 || second.Version != 3 {
					t.Fatalf("replacement versions = %d and %d", first.Version, second.Version)
				}
				wantVersion, wantObjects, wantOriginal = 3, 3, false
			case "delete before replacement":
				requireMutation(t, runProblemRace(t, ctx, db, repo, deletePackage, func(r outbound.ProblemRepository) error {
					_, err := upload(r)
					return err
				}))
				wantObjects, wantOriginal = 2, false
			case "failed upload":
				storage.uploadErr = injected
				if _, err := upload(repo); !errors.Is(err, injected) {
					t.Fatalf("failed upload = %v", err)
				}
			case "rollback staged replacement", "rollback cleanup failure":
				if name == "rollback cleanup failure" {
					storage.cleanupErr = injected
					wantObjects = 2
				}
				if _, err := upload(rollback); !errors.Is(err, injected) {
					t.Fatalf("rolled-back upload = %v", err)
				}
			case "uncertain replacement commit":
				if _, err := upload(uncertainMutationRepo{repo}); !errors.Is(err, outbound.ErrMutationCommitUncertain) {
					t.Fatalf("uncertain upload = %v", err)
				}
				wantVersion, wantObjects, wantOriginal = 2, 2, false
			case "rollback logical deletion":
				if err := deletePackage(rollback); !errors.Is(err, injected) {
					t.Fatalf("rolled-back delete = %v", err)
				}
			case "uncertain deletion commit":
				if err := deletePackage(uncertainMutationRepo{repo}); !errors.Is(err, outbound.ErrMutationCommitUncertain) {
					t.Fatalf("uncertain delete = %v", err)
				}
				wantVersion = 0
			}
			keys := storage.keys()
			if len(keys) != wantObjects {
				t.Fatalf("stored objects = %v, want %d", keys, wantObjects)
			}
			current, err := packages.GetByProblemID(ctx, p.ID)
			if wantVersion == 0 {
				if !errors.Is(err, domain.ErrTestCaseNotFound) || keys[0] != original.ZipObjectKey {
					t.Fatalf("after uncertain delete, metadata error=%v, objects=%v", err, keys)
				}
				return
			}
			requireMutation(t, err)
			if current.Version != wantVersion || (current.ZipObjectKey == original.ZipObjectKey) != wantOriginal || !containsObject(storage, current.ZipObjectKey) {
				t.Fatalf("package version=%d, key=%q, stored keys=%v", current.Version, current.ZipObjectKey, keys)
			}
		})
	}
	t.Run("reconciliation retains referenced packages and retries cleanup", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		retiredProblem, retainedProblem := newReconciliationProblem("retired"), newReconciliationProblem("retained")
		requireMutation(t, repo.Create(ctx, retiredProblem))
		requireMutation(t, repo.Create(ctx, retainedProblem))
		retiredKey := fmt.Sprintf("problems/%d/testcases/v1.zip", retiredProblem.ID)
		retainedKey := fmt.Sprintf("problems/%d/testcases/v1.zip", retainedProblem.ID)
		unreviewedKey := fmt.Sprintf("problems/%d/testcases/v2.zip", retiredProblem.ID)
		requireMutation(t, packages.Upsert(ctx, entity.NewTestCase(retiredProblem.ID, retiredKey, 1, 1)))
		requireMutation(t, packages.Upsert(ctx, entity.NewTestCase(retainedProblem.ID, retainedKey, 1, 1)))
		storage := &mutationStorage{objects: map[string][]byte{
			retiredKey: nil, retainedKey: nil, unreviewedKey: nil, "problems/unmanaged.zip": nil,
		}}
		requireMutation(t, testcase.NewDeleteTestCaseUseCase(repo, packages).Execute(ctx, owner, dto.ProblemIDRequest{ID: retiredProblem.ID}))
		requireMutation(t, problem.NewDeleteProblemUseCase(repo).Execute(ctx, owner, dto.ProblemIDRequest{ID: retainedProblem.ID}))

		refs := postgres.NewTestCaseObjectReferences(db)
		drainedAt := time.Unix(1000, 0)
		now := drainedAt.Add(16 * time.Minute)
		reviewed := []string{retiredKey}
		if _, err := testcase.ReconcileObjects(ctx, refs, storage, now.Add(-time.Second), drainedAt, 30*time.Second, reviewed); err == nil {
			t.Fatal("cleanup proceeded within the download retention window")
		}
		candidates, err := testcase.ReconcileObjects(ctx, refs, storage, now, drainedAt, 30*time.Second, nil)
		requireMutation(t, err)
		if !slices.Equal(candidates, []string{retiredKey, unreviewedKey}) || len(storage.keys()) != 4 {
			t.Fatalf("dry run candidates=%v objects=%v", candidates, storage.keys())
		}

		storage.cleanupErr = errors.New("storage unavailable")
		if _, err := testcase.ReconcileObjects(ctx, refs, storage, now, drainedAt, 30*time.Second, reviewed); !errors.Is(err, storage.cleanupErr) {
			t.Fatalf("cleanup failure = %v", err)
		}
		if _, err := packages.GetByProblemID(ctx, retiredProblem.ID); !errors.Is(err, domain.ErrTestCaseNotFound) {
			t.Fatalf("logical deletion changed after cleanup failure: %v", err)
		}
		if !containsObject(storage, retiredKey) {
			t.Fatal("failed cleanup lost the object before retry")
		}
		storage.cleanupErr = nil
		for range 2 {
			_, err := testcase.ReconcileObjects(ctx, refs, storage, now, drainedAt, 30*time.Second, reviewed)
			requireMutation(t, err)
		}
		if containsObject(storage, retiredKey) || !containsObject(storage, retainedKey) || !containsObject(storage, unreviewedKey) || len(storage.keys()) != 3 {
			t.Fatalf("cleanup removed an unreviewed or referenced object: %v", storage.keys())
		}
	})
	t.Run("hiding a published problem restores author package management", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		p := newReconciliationProblem("hide-restores-package-management")
		requireMutation(t, repo.Create(ctx, p))
		params := dto.ProblemIDRequest{ID: p.ID}
		original := entity.NewTestCase(p.ID, "hide-restores-original.zip", 1, 1)
		requireMutation(t, packages.Upsert(ctx, original))
		storage := &mutationStorage{objects: map[string][]byte{original.ZipObjectKey: []byte("original")}}
		upload := func() (dto.TestCaseMetadataResponse, error) {
			return testcase.NewUploadTestCaseUseCase(repo, packages, storage).Execute(ctx, owner, params, uploadRequest)
		}
		deletePackage := func() error {
			return testcase.NewDeleteTestCaseUseCase(repo, packages).Execute(ctx, owner, params)
		}

		_, err := problem.NewPublishProblemUseCase(repo).Execute(ctx, staff, params)
		requireMutation(t, err)
		if _, err := upload(); !errors.Is(err, domain.ErrForbidden) {
			t.Fatalf("author upload to Published problem = %v", err)
		}
		if err := deletePackage(); !errors.Is(err, domain.ErrForbidden) {
			t.Fatalf("author package delete on Published problem = %v", err)
		}
		metadata, err := testcase.NewGetTestCaseUseCase(repo, packages).Execute(ctx, owner, params)
		requireMutation(t, err)
		if metadata.Version != 1 {
			t.Fatalf("author metadata version on Published problem = %d", metadata.Version)
		}

		_, err = problem.NewHiddenProblemUseCase(repo).Execute(ctx, staff, params)
		requireMutation(t, err)
		replaced, err := upload()
		requireMutation(t, err)
		if replaced.Version != 2 {
			t.Fatalf("author replacement version after hide = %d", replaced.Version)
		}
		requireMutation(t, deletePackage())
		if _, err := packages.GetByProblemID(ctx, p.ID); !errors.Is(err, domain.ErrTestCaseNotFound) {
			t.Fatalf("package metadata after author delete = %v", err)
		}
	})
	t.Run("staff deletes a published problem and its package is kept", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		p := newReconciliationProblem("staff-delete-published")
		requireMutation(t, repo.Create(ctx, p))
		params := dto.ProblemIDRequest{ID: p.ID}
		kept := entity.NewTestCase(p.ID, "staff-delete-kept.zip", 1, 1)
		requireMutation(t, packages.Upsert(ctx, kept))

		_, err := problem.NewPublishProblemUseCase(repo).Execute(ctx, staff, params)
		requireMutation(t, err)
		requireMutation(t, problem.NewDeleteProblemUseCase(repo).Execute(ctx, staff, params))

		if _, err := repo.GetByID(ctx, p.ID); !errors.Is(err, domain.ErrProblemNotFound) {
			t.Fatalf("read after staff deletion = %v", err)
		}
		retained, err := packages.GetByProblemID(ctx, p.ID)
		requireMutation(t, err)
		if retained.ZipObjectKey != kept.ZipObjectKey || retained.Version != 1 {
			t.Fatalf("retained package = %+v", retained)
		}
		title := "Late edit"
		if _, err := problem.NewUpdateProblemUseCase(repo, nil).Execute(ctx, owner, params, dto.UpdateProblemRequest{Title: &title}); !errors.Is(err, domain.ErrProblemNotFound) {
			t.Fatalf("author edit after deletion = %v, want not found", err)
		}
	})
}

func newReconciliationProblem(slug string) *entity.Problem {
	p := entity.NewProblem("Reconciliation fixture", slug, "description", "input", "output", entity.Easy, nil, nil, nil, nil, 1000, 256, "owner")
	p.IsHidden = true
	return p
}

func containsObject(storage *mutationStorage, key string) bool {
	storage.mu.Lock()
	defer storage.mu.Unlock()
	_, exists := storage.objects[key]
	return exists
}
