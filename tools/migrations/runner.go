package migrations

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
	"go-judge-system/pkg/schema"
)

type migrationTarget struct {
	identity target
	config   *pgx.ConnConfig
}

type outcome struct {
	Owner  string `json:"owner"`
	Before int    `json:"before"`
	After  int    `json:"after"`
	Status string `json:"status"`
}

type runner struct {
	bundle        *bundle
	stateDir      string
	dirtyApproval string
	reconcile     bool
	lockWait      time.Duration
}

func (r runner) run(ctx context.Context, targets []migrationTarget) ([]outcome, error) {
	results := make([]outcome, 0, len(targets))
	for i, t := range targets {
		result, err := r.runTarget(ctx, t)
		results = append(results, result)
		if err != nil {
			for _, remaining := range targets[i+1:] {
				results = append(results, outcome{Owner: remaining.identity.Owner, Status: "unattempted"})
			}
			return results, fmt.Errorf("%s migration: %w", t.identity.Owner, err)
		}
	}
	return results, nil
}

func (r runner) runTarget(ctx context.Context, t migrationTarget) (outcome, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result := outcome{Owner: t.identity.Owner, Status: "refused"}
	if err := r.bundle.authorize(t.identity, r.dirtyApproval); err != nil {
		return result, err
	}
	seq := sequenceFor(&r.bundle.manifest, t.identity.Owner)
	if seq.Owner == "" || seq.Target != len(seq.Files) || t.config == nil {
		return result, errors.New("missing target sequence or connection")
	}
	if err := privateDirectory(r.stateDir); err != nil {
		return result, err
	}
	config := t.config.Copy()
	config.RuntimeParams = map[string]string{
		"application_name":  "astracode-migrator",
		"search_path":       "pg_catalog, public",
		"statement_timeout": "30000",
		"lock_timeout":      "10000",
	}
	db := openSingleSession(*config)
	defer db.Close()
	if err := r.lockTarget(ctx, db, t.identity); err != nil {
		return result, err
	}
	if err := verifySession(ctx, db); err != nil {
		return result, err
	}
	live, err := schema.Read(ctx, db)
	if err != nil {
		return result, fmt.Errorf("read target catalog: %w", err)
	}
	result.Before, result.After = live.Version, live.Version
	j, err := readJournal(r.stateDir, t.identity, seq)
	if err != nil {
		return result, err
	}
	if j.Pending != nil {
		result.Status = "uncertain"
		if err := r.reconcilePending(ctx, db, seq, live, &j); err != nil {
			return result, err
		}
	} else {
		if live.HasHistory && live.Version == 0 {
			return result, errors.New("unproven ledger initialization")
		}
		if err := verifyAppliedPrefix(live, seq, j.appliedHashes()); err != nil {
			return result, err
		}
	}
	if live.Version == seq.Target {
		if err := verifyRuntimeGrants(ctx, db, t.identity); err != nil {
			return result, err
		}
		if err := verifySession(ctx, db); err != nil {
			return result, err
		}
		result.Status = "verified"
		return result, nil
	}
	if err := writeManifest(r.stateDir, r.bundle); err != nil {
		return result, err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, r.bundle.sources[seq.Owner],
		goose.WithTableName("public.goose_db_version"))
	if err != nil {
		return result, errors.New("initialize pinned Goose Provider")
	}
	for _, file := range seq.Files[live.Version:] {
		entry := migrationRecord{
			PriorVersion: file.Version - 1, Version: file.Version,
			BundleSHA256: r.bundle.digest, FileSHA256: file.SQLSHA256,
		}
		j.Pending = &entry
		if err := writeJournal(r.stateDir, j); err != nil {
			return result, err
		}
		result.Status = "uncertain"
		if err := verifySession(ctx, db); err != nil {
			return result, err
		}
		if _, err := provider.ApplyVersion(ctx, int64(file.Version), true); err != nil {
			// Goose SQL errors can include statement text. Keep them out of logs.
			return result, fmt.Errorf("version %d failed; reconcile the recorded bundle", file.Version)
		}
		if err := r.complete(ctx, db, seq, &j); err != nil {
			return result, err
		}
		result.After = file.Version
	}
	result.Status = "verified"
	return result, nil
}

func (r runner) reconcilePending(ctx context.Context, db *sql.DB, seq sequence, live schema.State, j *journal) error {
	entry := *j.Pending
	if !r.reconcile || entry.BundleSHA256 != r.bundle.digest ||
		!recordManifestExists(r.stateDir, j.Target.Owner, entry, seq.Files[entry.Version-1]) {
		return errors.New("an unresolved migration requires reconciliation with the recorded bundle")
	}
	switch live.Version {
	case entry.PriorVersion:
		return verifyAppliedPrefix(live, seq, j.appliedHashes())
	case entry.Version:
		return r.complete(ctx, db, seq, j)
	default:
		return errors.New("unexpected target version during reconciliation")
	}
}

func (r runner) complete(ctx context.Context, db *sql.DB, seq sequence, j *journal) error {
	live, err := schema.Read(ctx, db)
	if err != nil {
		return fmt.Errorf("read catalog before completion: %w", err)
	}
	entry := *j.Pending
	applied := j.appliedHashes()
	applied[entry.Version] = entry.FileSHA256
	if err := verifyAppliedPrefix(live, seq, applied); err != nil {
		return err
	}
	if err := verifySession(ctx, db); err != nil {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	err = grantRuntime(ctx, conn, j.Target)
	conn.Close()
	if err != nil {
		return fmt.Errorf("apply runtime grants: %w", err)
	}
	if err := verifyRuntimeGrants(ctx, db, j.Target); err != nil {
		return err
	}
	if err := verifySession(ctx, db); err != nil {
		return err
	}
	j.Applied = append(j.Applied, entry)
	j.Pending = nil
	return writeJournal(r.stateDir, *j)
}

func (r runner) lockTarget(ctx context.Context, db *sql.DB, t target) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return errors.New("connect with migration role")
	}
	defer conn.Close()
	if err := verifyTarget(ctx, conn, t); err != nil {
		return err
	}
	lockCtx, cancel := context.WithTimeout(ctx, r.lockWait)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		var locked bool
		if err := conn.QueryRowContext(lockCtx, "SELECT pg_try_advisory_lock($1)", migrationLockKey).Scan(&locked); err != nil {
			return fmt.Errorf("acquire migration lock: %w", err)
		}
		if locked {
			return verifyTarget(ctx, conn, t)
		}
		select {
		case <-lockCtx.Done():
			return errors.New("migration lock wait exceeded")
		case <-ticker.C:
		}
	}
}

func verifySession(ctx context.Context, db *sql.DB) error {
	var locked bool
	err := db.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
    AND granted AND mode = 'ExclusiveLock' AND objsubid = 1
    AND classid::bigint = ($1::bigint >> 32) AND objid::bigint = ($1::bigint & 4294967295)
)`, migrationLockKey).Scan(&locked)
	if err != nil || !locked {
		return errors.New("migration session lost its advisory lock")
	}
	return nil
}
