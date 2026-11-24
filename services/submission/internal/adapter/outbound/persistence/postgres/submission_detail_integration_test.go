package postgres

import (
	"context"
	"os"
	"reflect"
	"strconv"
	"testing"
	"time"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/config"
	"go-judge-system/pkg/database"
	"go-judge-system/pkg/judge"
	"go-judge-system/pkg/rbac"
	"go-judge-system/pkg/schema"
	"go-judge-system/services/submission/internal/application/dto"
	"go-judge-system/services/submission/internal/application/usecase/result"
	"go-judge-system/services/submission/internal/application/usecase/user"
	"go-judge-system/services/submission/internal/domain/entity"
)

// Requires a fresh disposable database, as specified in the task's verification command.
func TestGetCurrentDetailPostgresSnapshots(t *testing.T) {
	portText := os.Getenv("ASTRACODE_DETAIL_TEST_PGPORT")
	if portText == "" {
		t.Skip("ASTRACODE_DETAIL_TEST_PGPORT is unset (requires disposable PostgreSQL)")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		t.Fatal("ASTRACODE_DETAIL_TEST_PGPORT must be a valid local port")
	}
	db, err := database.ConnectDatabase(config.DatabaseConfig{
		Host: "127.0.0.1", Port: port, User: "detail_fixture", Password: "detail_fixture",
		DBName: "submission_detail_test", SSLMode: "disable", MaxOpenConns: 2, MaxIdleConns: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	guardCtx, guardCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer guardCancel()
	if err := schema.VerifyFixture(guardCtx, sqlDB, "submission"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	submissions := NewSubmissionRepository(db)
	results := NewSubmissionResultRepository(db)
	attempts := NewSubmissionAttemptRepository(db)
	txm := NewTransactionManager(db)
	apply := result.NewApplyJudgeResultUseCase(submissions, results, txm, nil, nil, attempts)
	get := user.NewGetSubmissionUseCase(NewCurrentSubmissionDetailRepository(db))
	claims := auth.Claims{UserID: "fixture-owner", Role: rbac.RoleUser}

	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	create := func(attempt string) *entity.Submission {
		t.Helper()
		s := entity.NewSubmission(42, "Fixture", claims.UserID, "owner", entity.LanguageGo, "package main", attempt)
		check(submissions.Create(ctx, s))
		if attempt != "" {
			check(attempts.Create(ctx, entity.NewSubmissionAttempt(s.ID, attempt, entity.AttemptTriggerSubmission, claims.UserID)))
		}
		return s
	}
	read := func(s *entity.Submission) dto.GetSubmissionResponse {
		t.Helper()
		detail, err := get.Execute(ctx, claims, dto.GetSubmissionRequest{SubmissionID: s.ID})
		check(err)
		return detail
	}
	wantSnapshot := func(got dto.GetSubmissionResponse, attempt *string, status entity.Status, passed, total, runtime *int) {
		t.Helper()
		if !reflect.DeepEqual(got.AttemptID, attempt) || got.Status != string(status) ||
			!reflect.DeepEqual(got.PassedTestCases, passed) || !reflect.DeepEqual(got.TotalTestCases, total) ||
			!reflect.DeepEqual(got.ExecutionTimeMS, runtime) {
			t.Fatalf("detail does not match expected attempt snapshot: %+v", got)
		}
	}

	attemptA, attemptB := "attempt-A", "attempt-B"
	zero, one, two, timeA, timeB := 0, 1, 2, 11, 22
	submission := create(attemptA)
	pending := read(submission)
	wantSnapshot(pending, &attemptA, entity.StatusPending, nil, nil, nil)
	check(apply.Execute(ctx, judge.ResultMessage{
		SubmissionID: submission.ID, AttemptID: attemptA, Status: string(entity.StatusWrongAnswer), ExecutionTime: &timeA,
		TestCases: []judge.TestCaseResultItem{{Index: 1, Status: string(entity.ResultAccepted)}, {Index: 2, Status: string(entity.ResultWrongAnswer)}},
	}))
	a := read(submission)
	wantSnapshot(a, &attemptA, entity.StatusWrongAnswer, &one, &two, &timeA)
	oldMetadata, err := submissions.GetByID(ctx, submission.ID)
	check(err)
	if oldMetadata.CurrentAttemptID != attemptA || oldMetadata.Status != entity.StatusWrongAnswer {
		t.Fatalf("unexpected pre-rejudge metadata: %+v", oldMetadata)
	}

	// Leave B's rejudge writes uncommitted while the ordinary detail read uses
	// the other connection. The writer callback is the barrier, so no sleeps.
	check(txm.ExecuteInTx(ctx, func(txCtx context.Context) error {
		locked, err := submissions.GetByIDForUpdate(txCtx, submission.ID)
		if err != nil {
			return err
		}
		locked.CurrentAttemptID = attemptB
		locked.ResetForRejudge()
		if err := submissions.Update(txCtx, locked); err != nil {
			return err
		}
		if err := attempts.Create(txCtx, entity.NewSubmissionAttempt(submission.ID, attemptB, entity.AttemptTriggerAdminRejudge, "moderator")); err != nil {
			return err
		}
		if got := read(submission); !reflect.DeepEqual(got, a) {
			t.Fatalf("uncommitted rejudge changed detail: %+v", got)
		}
		return nil
	}))
	bPending := read(submission)
	wantSnapshot(bPending, &attemptB, entity.StatusPending, nil, nil, nil)
	summaries, err := submissions.ResultSummaries(ctx, []int64{submission.ID})
	check(err)
	if _, found := summaries[submission.ID]; found {
		t.Fatal("former summary query should see no current results while B is pending")
	}
	check(apply.Execute(ctx, judge.ResultMessage{
		SubmissionID: submission.ID, AttemptID: attemptA, Status: string(entity.StatusAccepted), ExecutionTime: &timeA,
	}))
	if got := read(submission); !reflect.DeepEqual(got, bPending) {
		t.Fatalf("stale result changed current detail: %+v", got)
	}
	check(apply.Execute(ctx, judge.ResultMessage{
		SubmissionID: submission.ID, AttemptID: attemptB, Status: string(entity.StatusAccepted), ExecutionTime: &timeB,
		TestCases: []judge.TestCaseResultItem{{Index: 1, Status: string(entity.ResultAccepted)}},
	}))
	wantSnapshot(read(submission), &attemptB, entity.StatusAccepted, &one, &one, &timeB)
	// The former split read could combine oldMetadata (A) with these counts (B).
	summaries, err = submissions.ResultSummaries(ctx, []int64{submission.ID})
	check(err)
	if summary, found := summaries[submission.ID]; !found || summary.Passed != one || summary.Total != one {
		t.Fatalf("former summary query should now see B's results, got %+v", summaries)
	}

	noResults := create("attempt-zero")
	check(apply.Execute(ctx, judge.ResultMessage{
		SubmissionID: noResults.ID, AttemptID: noResults.CurrentAttemptID, Status: string(entity.StatusCompilationError),
	}))
	wantSnapshot(read(noResults), &noResults.CurrentAttemptID, entity.StatusCompilationError, &zero, &zero, nil)

	legacy := create("")
	check(db.WithContext(ctx).Model(&SubmissionDAO{}).Where("id = ?", legacy.ID).
		UpdateColumn("current_attempt_id", nil).Error)
	wantSnapshot(read(legacy), nil, entity.StatusPending, nil, nil, nil)
}
