package migrations

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func TestProviderSingleSession(t *testing.T) {
	token := os.Getenv("ASTRACODE_MIGRATION_PROOF_TOKEN")
	if token == "" {
		t.Skip("requires the disposable PostgreSQL 15.6 proof fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	config, err := pgx.ParseConfig("host=/var/run/postgresql port=5432 dbname=m102_feasibility user=postgres sslmode=disable")
	check(t, err)
	config.RuntimeParams["application_name"] = "astracode-m102-proof"
	observerConfig := config.Copy()
	observerConfig.RuntimeParams["application_name"] = "astracode-m102-observer"
	observer := stdlib.OpenDB(*observerConfig)
	defer observer.Close()
	checkDisposableFixture(t, ctx, observer, "m102_feasibility", token)

	db := openSingleSession(*config)
	defer db.Close()
	pid := lockSession(t, ctx, db)

	provider, err := goose.NewProvider(goose.DialectPostgres, db, fstest.MapFS{
		"00001_initial.sql": {Data: []byte("-- +goose Up\nCREATE TABLE public.proof_baseline (id bigint PRIMARY KEY);\n")},
		"00002_change.sql":  {Data: []byte("-- +goose Up\nALTER TABLE public.proof_baseline ADD COLUMN ready boolean;\n")},
		"00003_blocked.sql": {Data: []byte(`-- +goose Up
CREATE TABLE public.proof_interrupted (id bigint);
ALTER TABLE public.proof_baseline ADD COLUMN interrupted boolean;
CREATE TABLE public.proof_unexpected_continuation (id bigint);
`)},
	})
	check(t, err)

	assertSession(t, ctx, db, pid)
	for _, version := range []int64{1, 2} {
		_, err := provider.ApplyVersion(ctx, version, true)
		check(t, err)
		assertSession(t, ctx, db, pid)
		assertHistory(t, ctx, db, version)
	}
	t.Logf("backend %d held the lock across preflight, both migrations and the history post-check", pid)

	blocker, err := observer.BeginTx(ctx, nil)
	check(t, err)
	defer blocker.Rollback()
	_, err = blocker.ExecContext(ctx, "LOCK TABLE public.proof_baseline IN ACCESS EXCLUSIVE MODE")
	check(t, err)

	var available bool
	competitor := openSingleSession(*observerConfig)
	defer competitor.Close()
	check(t, competitor.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", migrationLockKey).Scan(&available))
	if available {
		t.Fatal("competitor acquired the lock while the writer was active")
	}

	migrationResult := make(chan error, 1)
	go func() {
		_, err := provider.ApplyVersion(ctx, 3, true)
		migrationResult <- err
	}()
	waitForBlockedDDL(t, ctx, observer, pid)

	var terminated bool
	check(t, observer.QueryRowContext(ctx, `
SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity
WHERE pid = $1 AND datname = current_database() AND application_name = 'astracode-m102-proof'`, pid).Scan(&terminated))
	if !terminated {
		t.Fatal("fixture could not terminate the lock-owning backend")
	}
	if err := <-migrationResult; err == nil {
		t.Fatal("interrupted migration returned success")
	}
	if err := db.PingContext(ctx); !errors.Is(err, errSessionSpent) {
		t.Fatalf("expected replacement connection to be refused, got %v", err)
	}
	check(t, blocker.Rollback())

	check(t, competitor.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", migrationLockKey).Scan(&available))
	if !available {
		t.Fatal("competitor could not acquire the released lock")
	}
	assertHistory(t, ctx, competitor, 2)
	var rolledBack bool
	check(t, competitor.QueryRowContext(ctx, `
SELECT to_regclass('public.proof_interrupted') IS NULL
   AND to_regclass('public.proof_unexpected_continuation') IS NULL
   AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.proof_baseline'::regclass
                   AND attname = 'interrupted' AND NOT attisdropped)`).Scan(&rolledBack))
	if !rolledBack {
		t.Fatal("interrupted migration left application DDL")
	}
	t.Log("interrupted migration failed, reconnect was refused and the competing session verified the prior committed version")
}

func checkDisposableFixture(t *testing.T, ctx context.Context, db *sql.DB, database, token string) {
	t.Helper()
	var disposable bool
	check(t, db.QueryRowContext(ctx, `
SELECT current_database() = $2
   AND current_setting('server_version_num')::int = 150006
   AND inet_server_addr() IS NULL
   AND coalesce(current_setting('astracode.proof_token', true) = $1, false)
   AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public')`, token, database).Scan(&disposable))
	if !disposable {
		t.Fatal("expected an enrolled, empty PostgreSQL 15.6 proof fixture")
	}
}

func lockSession(t *testing.T, ctx context.Context, db *sql.DB) int {
	t.Helper()
	conn, err := db.Conn(ctx)
	check(t, err)
	defer conn.Close()
	var pid int
	check(t, conn.QueryRowContext(ctx, "SELECT pg_backend_pid() FROM pg_advisory_lock($1)", migrationLockKey).Scan(&pid))
	return pid
}

func assertSession(t *testing.T, ctx context.Context, db *sql.DB, pid int) {
	t.Helper()
	var held bool
	check(t, db.QueryRowContext(ctx, `
SELECT pg_backend_pid() = $1
   AND EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted)`, pid).Scan(&held))
	if !held {
		t.Fatalf("backend %d no longer holds the advisory lock", pid)
	}
}

func assertHistory(t *testing.T, ctx context.Context, db *sql.DB, version int64) {
	t.Helper()
	var valid bool
	check(t, db.QueryRowContext(ctx, `
SELECT coalesce(max(version_id) = $1 AND count(*) = $1 + 1 AND bool_and(is_applied), false)
FROM goose_db_version`, version).Scan(&valid))
	if !valid {
		t.Fatalf("expected ledger prefix through %d", version)
	}
}

func waitForBlockedDDL(t *testing.T, ctx context.Context, observer *sql.DB, pid int) {
	t.Helper()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		check(t, observer.QueryRowContext(ctx, `
SELECT EXISTS (SELECT 1 FROM pg_stat_activity
               WHERE pid = $1 AND wait_event_type = 'Lock'
                 AND query LIKE 'ALTER TABLE public.proof_baseline ADD COLUMN interrupted%')`, pid).Scan(&blocked))
		if blocked {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("timed out waiting for the fixture DDL to block")
		case <-ticker.C:
		}
	}
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
