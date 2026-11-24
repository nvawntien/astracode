package migrations

import (
	"context"
	"io/fs"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
	"go-judge-system/pkg/schema"
)

func TestInitialSchemaParity(t *testing.T) {
	migrationsDir := os.Getenv("ASTRACODE_MIGRATION_PARITY_DIR")
	token := os.Getenv("ASTRACODE_MIGRATION_PROOF_TOKEN")
	if migrationsDir == "" || token == "" {
		t.Skip("requires three enrolled disposable PostgreSQL 15.6 parity databases")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for _, owner := range []string{"auth", "problem", "submission"} {
		t.Run(owner, func(t *testing.T) {
			database := owner + "_db"
			config, err := pgx.ParseConfig("host=/var/run/postgresql port=5432 user=postgres sslmode=disable dbname=" + database)
			check(t, err)
			db := openSingleSession(*config)
			defer db.Close()
			pid := lockSession(t, ctx, db)
			checkDisposableFixture(t, ctx, db, database, token)
			_, err = db.ExecContext(ctx, "ALTER SCHEMA public OWNER TO postgres")
			check(t, err)

			source, err := fs.Sub(os.DirFS(migrationsDir), owner)
			check(t, err)
			sql, err := fs.ReadFile(source, "00001_initial_schema.sql")
			check(t, err)
			catalog, err := schema.Expected(owner, 1)
			check(t, err)
			file := versionFile{Version: 1, SQLSHA256: digest(sql), CatalogSHA256: catalog}
			seq := sequence{Owner: owner, Target: 1, Files: []versionFile{file}}
			state, err := schema.Read(ctx, db)
			check(t, err)
			check(t, verifyAppliedPrefix(state, seq, nil))
			_, err = db.ExecContext(ctx, "CREATE VIEW public.unmanaged_fixture AS SELECT 1 AS id")
			check(t, err)
			unmanaged, err := schema.Read(ctx, db)
			check(t, err)
			if unmanaged.HasHistory || verifyAppliedPrefix(unmanaged, seq, nil) == nil {
				t.Fatal("unmanaged application objects were accepted or initialized history")
			}
			_, err = db.ExecContext(ctx, "DROP VIEW public.unmanaged_fixture")
			check(t, err)

			provider, err := goose.NewProvider(goose.DialectPostgres, db, source)
			check(t, err)
			_, err = provider.ApplyVersion(ctx, 1, true)
			check(t, err)
			assertSession(t, ctx, db, pid)
			assertHistory(t, ctx, db, 1)
			applied := map[int]string{1: file.SQLSHA256}
			state, err = schema.Read(ctx, db)
			check(t, err)
			check(t, verifyAppliedPrefix(state, seq, applied))
			if verifyAppliedPrefix(state, seq, nil) == nil ||
				verifyAppliedPrefix(state, seq, map[int]string{1: "conflict"}) == nil {
				t.Fatal("applied migration with absent or conflicting checksum evidence was accepted")
			}
			forged := seq
			forged.Target = 0
			if verifyAppliedPrefix(state, forged, applied) == nil {
				t.Fatal("newer ledger was accepted")
			}
			_, err = db.ExecContext(ctx, "INSERT INTO public.goose_db_version (version_id, is_applied) VALUES (3, true)")
			check(t, err)
			if _, err := schema.Read(ctx, db); err == nil {
				t.Fatal("incomplete ledger was accepted")
			}
			_, err = db.ExecContext(ctx, "DELETE FROM public.goose_db_version WHERE version_id = 3")
			check(t, err)
			_, err = db.ExecContext(ctx, "CREATE TABLE public.unexpected_fixture (id integer)")
			check(t, err)
			drift, err := schema.Read(ctx, db)
			check(t, err)
			if verifyAppliedPrefix(drift, seq, applied) == nil {
				t.Fatal("catalog drift was accepted")
			}
			_, err = db.ExecContext(ctx, "DROP TABLE public.unexpected_fixture")
			check(t, err)
		})
	}
}
