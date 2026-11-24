package migrations

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"go-judge-system/pkg/schema"
)

func TestRunnerRecovery(t *testing.T) {
	migrationsDir := os.Getenv("ASTRACODE_MIGRATION_PARITY_DIR")
	token := os.Getenv("ASTRACODE_MIGRATION_PROOF_TOKEN")
	if migrationsDir == "" || token == "" {
		t.Skip("requires enrolled disposable PostgreSQL 15.6 databases")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	b := &bundle{manifest: manifest{Revision: legacyBase, ToolSHA256: strings.Repeat("a", 64)},
		sources: make(map[string]fstest.MapFS)}
	var targets []migrationTarget
	admin := fixtureDB(t, "auth_db", "postgres")
	defer admin.Close()
	checkDisposableFixture(t, ctx, admin, "auth_db", token)
	var instance string
	check(t, admin.QueryRowContext(ctx, "SELECT gen_random_uuid()::text").Scan(&instance))
	for _, owner := range []string{"auth", "problem", "submission"} {
		scope, err := targetScope("local", owner)
		check(t, err)
		db := fixtureDB(t, scope.Database, "postgres")
		checkDisposableFixture(t, ctx, db, scope.Database, token)
		tgt, err := bootstrapTarget(ctx, db, scope, instance, "proof-migrator", "proof-runtime")
		db.Close()
		check(t, err)
		targets = append(targets, migrationTarget{tgt, fixtureConfig(t, tgt.Database, tgt.MigratorRole)})
		name := "00001_initial_schema.sql"
		data, err := os.ReadFile(filepath.Join(migrationsDir, owner, name))
		check(t, err)
		catalog, err := schema.Expected(owner, 1)
		check(t, err)
		b.manifest.Sequences = append(b.manifest.Sequences, sequence{Owner: owner, Target: 1, Files: []versionFile{
			{Version: 1, Filename: name, SQLSHA256: digest(data), CatalogSHA256: catalog},
		}})
		b.sources[owner] = fstest.MapFS{name: &fstest.MapFile{Data: data}}
	}
	refreshBundleID(t, b)
	r := runner{bundle: b, stateDir: filepath.Join(t.TempDir(), "state"), lockWait: 4 * time.Second}
	wrong := append([]migrationTarget(nil), targets...)
	wrong[1].identity.GenerationID = targets[0].identity.GenerationID
	outcomes, err := r.run(ctx, wrong)
	if err == nil || outcomes[0].Status != "verified" || outcomes[0].After != 1 ||
		outcomes[1].Status != "refused" || outcomes[2].Status != "unattempted" {
		t.Fatalf("unexpected partial result: %v (%v)", outcomes, err)
	}
	for _, pending := range targets[1:] {
		db := fixtureDB(t, pending.identity.Database, "postgres")
		state, err := schema.Read(ctx, db)
		db.Close()
		check(t, err)
		if state.HasHistory {
			t.Fatalf("failed batch wrote history on %s", pending.identity.Owner)
		}
	}
	result, err := r.runTarget(ctx, targets[0])
	check(t, err)
	if result.Before != 1 || result.After != 1 || result.Status != "verified" {
		t.Fatalf("unexpected repeat result: %v", result)
	}
	_, err = r.run(ctx, targets)
	check(t, err)

	runtime := fixtureDB(t, "auth_db", targets[0].identity.RuntimeRole)
	defer runtime.Close()
	_, err = runtime.ExecContext(ctx, "INSERT INTO public.users (id, username, email, password) VALUES (gen_random_uuid(), 'fixture', 'fixture@example.invalid', 'fixture')")
	check(t, err)
	const upgrade = "00002_upgrade.sql"
	data := []byte("-- +goose Up\nALTER TABLE public.users ADD COLUMN proof text;\nUPDATE public.users SET proof = 'backfilled';\n")

	// Capture the expected upgraded catalog independently from the runner.
	tx, err := admin.BeginTx(ctx, nil)
	check(t, err)
	_, err = tx.ExecContext(ctx, "SET LOCAL search_path = pg_catalog")
	check(t, err)
	_, err = tx.ExecContext(ctx, "ALTER TABLE public.users ADD COLUMN proof text")
	check(t, err)
	nextCatalog, err := schema.CatalogDigest(ctx, tx)
	check(t, err)
	check(t, tx.Rollback())
	seq := &b.manifest.Sequences[0]
	seq.Target = 2
	seq.Files = append(seq.Files, versionFile{Version: 2, Filename: upgrade, SQLSHA256: digest(data), CatalogSHA256: nextCatalog})
	b.sources["auth"][upgrade] = &fstest.MapFile{Data: data}
	refreshBundleID(t, b)

	locker, err := admin.Conn(ctx)
	check(t, err)
	defer locker.Close()
	_, err = locker.ExecContext(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey)
	check(t, err)
	impatient := r
	impatient.lockWait = 150 * time.Millisecond
	if _, err := impatient.runTarget(ctx, targets[0]); err == nil {
		t.Fatal("contending runner did not time out")
	}
	assertHistory(t, ctx, admin, 1)
	waiting := make(chan error, 1)
	go func() {
		_, err := r.runTarget(ctx, targets[0])
		waiting <- err
	}()
	select {
	case err := <-waiting:
		t.Fatalf("waiting runner returned before unlock: %v", err)
	case <-time.After(250 * time.Millisecond):
	}
	_, err = locker.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", migrationLockKey)
	check(t, err)
	check(t, <-waiting)
	assertHistory(t, ctx, admin, 2)
	var backfilled string
	check(t, runtime.QueryRowContext(ctx, "SELECT proof FROM public.users WHERE username = 'fixture'").Scan(&backfilled))
	if backfilled != "backfilled" {
		t.Fatal("upgrade did not preserve and adapt the representative row")
	}

	// Restore the durable pre-commit intent to represent an acknowledgement
	// lost after the database commit. Under lock it must be reconciled once.
	j, err := readJournal(r.stateDir, targets[0].identity, *seq)
	check(t, err)
	pending := j.Applied[1]
	j.Applied, j.Pending = j.Applied[:1], &pending
	check(t, writeJournal(r.stateDir, j))
	if _, err := r.runTarget(ctx, targets[0]); err == nil {
		t.Fatal("runner accepted an uncertain outcome without reconciliation")
	}
	r.reconcile = true
	_, err = r.runTarget(ctx, targets[0])
	check(t, err)
	reconciled, err := readJournal(r.stateDir, targets[0].identity, *seq)
	check(t, err)
	if reconciled.Pending != nil || len(reconciled.Applied) != 2 {
		t.Fatal("reconciliation did not record the committed version")
	}
	assertHistory(t, ctx, admin, 2)
	before, err := os.ReadFile(journalPath(r.stateDir, targets[0].identity))
	check(t, err)
	result, err = r.runTarget(ctx, targets[0])
	check(t, err)
	after, err := os.ReadFile(journalPath(r.stateDir, targets[0].identity))
	check(t, err)
	if result.Before != 2 || result.After != 2 || !bytes.Equal(before, after) {
		t.Fatalf("verified target changed on repeat: %v", result)
	}

	// Allow the first statement to run, then hold a table lock on the second
	// statement. Ending the lock-owning backend must roll back both statements.
	const third = "00003_interruption.sql"
	thirdData := []byte("-- +goose Up\nCREATE TABLE public.proof_atomic (id integer);\nALTER TABLE public.users ADD COLUMN interrupted integer;\n")
	tx, err = admin.BeginTx(ctx, nil)
	check(t, err)
	_, err = tx.ExecContext(ctx, "SET LOCAL search_path = pg_catalog")
	check(t, err)
	_, err = tx.ExecContext(ctx, "CREATE TABLE public.proof_atomic (id integer); ALTER TABLE public.users ADD COLUMN interrupted integer")
	check(t, err)
	thirdCatalog, err := schema.CatalogDigest(ctx, tx)
	check(t, err)
	check(t, tx.Rollback())
	seq.Target = 3
	seq.Files = append(seq.Files, versionFile{Version: 3, Filename: third, SQLSHA256: digest(thirdData), CatalogSHA256: thirdCatalog})
	b.sources["auth"][third] = &fstest.MapFile{Data: thirdData}
	refreshBundleID(t, b)

	hold, err := admin.BeginTx(ctx, nil)
	check(t, err)
	defer hold.Rollback()
	_, err = hold.ExecContext(ctx, "LOCK public.users IN SHARE MODE")
	check(t, err)
	go func() {
		_, err := r.runTarget(ctx, targets[0])
		waiting <- err
	}()
	pid := waitForRunnerDDL(t, ctx, admin)
	var terminated bool
	check(t, admin.QueryRowContext(ctx, "SELECT pg_terminate_backend($1)", pid).Scan(&terminated))
	if !terminated || <-waiting == nil {
		t.Fatal("interrupted migration did not fail")
	}
	check(t, hold.Rollback())
	rolledBack, err := schema.Read(ctx, admin)
	check(t, err)
	if rolledBack.Version != 2 || rolledBack.CatalogSHA256 != nextCatalog {
		t.Fatal("interrupted transaction changed the schema or ledger")
	}
	withoutReconcile := r
	withoutReconcile.reconcile = false
	if _, err := withoutReconcile.runTarget(ctx, targets[0]); err == nil {
		t.Fatal("interrupted transaction authorized a new run without reconciliation")
	}
	_, err = r.runTarget(ctx, targets[0])
	check(t, err)
	assertHistory(t, ctx, admin, 3)
}

func refreshBundleID(t *testing.T, b *bundle) {
	t.Helper()
	data, err := json.Marshal(b.manifest)
	check(t, err)
	b.digest = digest(data)
}

func waitForRunnerDDL(t *testing.T, ctx context.Context, observer *sql.DB) int {
	t.Helper()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int
		check(t, observer.QueryRowContext(ctx, `
SELECT coalesce(max(a.pid), 0) FROM pg_stat_activity a
JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'advisory' AND l.granted
WHERE a.application_name = 'astracode-migrator' AND a.wait_event_type = 'Lock'
  AND a.query LIKE 'ALTER TABLE public.users ADD COLUMN interrupted%'`).Scan(&pid))
		if pid != 0 {
			return pid
		}
		select {
		case <-ctx.Done():
			t.Fatal("runner did not block on the test DDL")
		case <-ticker.C:
		}
	}
}
