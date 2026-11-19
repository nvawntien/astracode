package postgres

import (
	"context"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"go-judge-system/services/submission/internal/domain"
	"go-judge-system/services/submission/internal/domain/entity"
)

func TestGetCurrentDetailSingleStatement(t *testing.T) {
	owner := "owner' OR true --"
	createdAt := time.Date(2026, 7, 23, 14, 0, 0, 0, time.UTC)
	updatedAt := createdAt.Add(time.Minute)
	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "detail-request")

	for _, tc := range []struct {
		name        string
		ownerFilter *string
		attempt     driver.Value
		wantAttempt string
		status      entity.Status
		passed      int64
		total       int64
	}{
		{"owner with current results", &owner, "attempt-A", "attempt-A", entity.StatusWrongAnswer, 2, 3},
		{"admin with terminal zero results", nil, "attempt-B", "attempt-B", entity.StatusCompilationError, 0, 0},
		{"owner with pending zero results", &owner, "attempt-C", "attempt-C", entity.StatusPending, 0, 0},
		{"legacy SQL null attempt", &owner, nil, "", entity.StatusAccepted, 0, 0},
		{"legacy empty attempt with results", &owner, "", "", entity.StatusAccepted, 1, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			db := newRepositoryReadGormDB(t, func(
				queryCtx context.Context, query string, args []driver.NamedValue,
			) (driver.Rows, error) {
				calls++
				if queryCtx.Value(contextKey{}) != "detail-request" {
					t.Fatal("missing request context")
				}
				q := strings.ToUpper(strings.Join(strings.Fields(query), " "))
				for _, part := range []string{
					"SELECT S.*, SUMMARY.PASSED_COUNT, SUMMARY.TOTAL_COUNT",
					"FROM SUBMISSIONS AS S", "LEFT JOIN LATERAL",
					"COUNT(*) FILTER (WHERE R.STATUS =", "COUNT(*) AS TOTAL_COUNT",
					"FROM SUBMISSION_RESULTS AS R", "R.SUBMISSION_ID = S.ID",
					"R.ATTEMPT_ID = S.CURRENT_ATTEMPT_ID", "WHERE S.ID =",
				} {
					if !strings.Contains(q, part) {
						t.Fatalf("query missing %q: %s", part, query)
					}
				}
				if strings.Contains(q, "FOR UPDATE") || strings.Contains(q, ";") ||
					strings.Contains(q, "EXPECTED_OUTPUT") || strings.Contains(query, owner) {
					t.Fatalf("unexpected query projection, locking or interpolated value: %s", query)
				}
				if strings.Contains(q, "S.USER_ID =") != (tc.ownerFilter != nil) {
					t.Fatalf("incorrect owner predicate: %s", query)
				}
				wantArgs := []any{string(entity.ResultAccepted), int64(77)}
				if tc.ownerFilter != nil {
					wantArgs = append(wantArgs, owner)
				}
				var gotArgs []any
				for _, arg := range args {
					gotArgs = append(gotArgs, arg.Value)
				}
				if !reflect.DeepEqual(gotArgs, wantArgs) {
					t.Fatalf("query args = %v, want %v", gotArgs, wantArgs)
				}
				rows := submissionRows([]driver.Value{
					int64(77), int64(42), "Two Sum", owner, "owner-name", "GO", "package main\n",
					tc.attempt, string(tc.status), int64(12), int64(4300),
					"compile output", "judge message", createdAt, updatedAt, tc.passed, tc.total,
				}).(*repositoryReadRows)
				rows.columns = append(rows.columns, "passed_count", "total_count")
				return rows, nil
			})

			got, summary, err := NewCurrentSubmissionDetailRepository(db).GetCurrentDetail(ctx, 77, tc.ownerFilter)
			if err != nil {
				t.Fatal(err)
			}
			runtime, memory := 12, 4300
			compileOutput, errorMessage := "compile output", "judge message"
			want := &entity.Submission{
				ID: 77, ProblemID: 42, ProblemName: "Two Sum", UserID: owner, Username: "owner-name",
				Language: entity.LanguageGo, SourceCode: "package main\n", CurrentAttemptID: tc.wantAttempt,
				Status: tc.status, ExecutionTime: &runtime, MemoryUsed: &memory, CompileOutput: &compileOutput,
				ErrorMessage: &errorMessage, CreatedAt: createdAt, UpdatedAt: updatedAt,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("submission = %+v, want %+v", got, want)
			}
			if summary.SubmissionID != 77 || summary.Passed != int(tc.passed) || summary.Total != int(tc.total) {
				t.Fatalf("unexpected summary: %+v", summary)
			}
			if calls != 1 {
				t.Fatalf("query calls = %d, want 1", calls)
			}
		})
	}
}

func TestGetCurrentDetailErrors(t *testing.T) {
	dbErr := errors.New("database unavailable")
	for _, tc := range []struct {
		name     string
		queryErr error
		want     error
	}{
		{"missing or inaccessible", nil, domain.ErrSubmissionNotFound},
		{"database failure", dbErr, dbErr},
		{"deadline exceeded", context.DeadlineExceeded, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := newRepositoryReadGormDB(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
				if tc.queryErr != nil {
					return nil, tc.queryErr
				}
				rows := submissionRows().(*repositoryReadRows)
				rows.columns = append(rows.columns, "passed_count", "total_count")
				return rows, nil
			})
			got, _, err := NewCurrentSubmissionDetailRepository(db).GetCurrentDetail(context.Background(), 77, nil)
			if got != nil || !errors.Is(err, tc.want) {
				t.Fatalf("submission/error = %+v/%v, want nil/%v", got, err, tc.want)
			}
		})
	}
}

func TestGetCurrentDetailPreservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	db := newRepositoryReadGormDB(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
		t.Fatal("query ran after cancellation")
		return nil, nil
	})
	_, _, err := NewCurrentSubmissionDetailRepository(db).GetCurrentDetail(ctx, 77, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context canceled", err)
	}
}
