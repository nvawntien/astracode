package migrations

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	"go-judge-system/pkg/schema"
)

func TestRuntimeSchemaGate(t *testing.T) {
	paths := os.Getenv("ASTRACODE_MIGRATION_PARITY_DIR")
	token := os.Getenv("ASTRACODE_MIGRATION_PROOF_TOKEN")
	if paths == "" || token == "" {
		t.Skip("requires three enrolled disposable PostgreSQL 15.6 databases")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for _, owner := range []string{"auth", "problem", "submission"} {
		t.Run(owner, func(t *testing.T) {
			scope, err := targetScope("local", owner)
			check(t, err)
			admin := fixtureDB(t, scope.Database, "postgres")
			defer admin.Close()
			checkDisposableFixture(t, ctx, admin, scope.Database, token)
			var id string
			check(t, admin.QueryRowContext(ctx, "SELECT gen_random_uuid()::text").Scan(&id))
			tgt, err := bootstrapTarget(ctx, admin, scope, id, "proof-migrator", "proof-runtime")
			check(t, err)
			runtime := fixtureDB(t, tgt.Database, tgt.RuntimeRole)
			defer runtime.Close()
			requireRefusal := func(reason string) {
				t.Helper()
				if schema.VerifyStartup(ctx, runtime, owner) == nil {
					t.Fatalf("runtime accepted %s", reason)
				}
			}
			requireRefusal("empty database")
			state, err := schema.Read(ctx, admin)
			check(t, err)
			if state.HasHistory {
				t.Fatal("failed startup initialized migration history")
			}

			migrator := openSingleSession(*fixtureConfig(t, tgt.Database, tgt.MigratorRole))
			defer migrator.Close()
			lockSession(t, ctx, migrator)
			p, err := goose.NewProvider(goose.DialectPostgres, migrator,
				os.DirFS(filepath.Join(paths, owner)), goose.WithTableName("public.goose_db_version"))
			check(t, err)
			_, err = p.ApplyVersion(ctx, 1, true)
			check(t, err)
			requireRefusal("unreadable migration ledger")
			conn, err := migrator.Conn(ctx)
			check(t, err)
			check(t, grantRuntime(ctx, conn, tgt))
			check(t, conn.Close())
			check(t, schema.VerifyStartup(ctx, runtime, owner))
			assertHistory(t, ctx, runtime, 1)
			_, err = admin.ExecContext(ctx, "CREATE TABLE public.startup_drift (id integer)")
			check(t, err)
			requireRefusal("drifted schema")
			_, err = admin.ExecContext(ctx, "DROP TABLE public.startup_drift")
			check(t, err)
			_, err = admin.ExecContext(ctx, "INSERT INTO public.goose_db_version (version_id, is_applied) VALUES (2, true)")
			check(t, err)
			requireRefusal("newer migration version")
			_, err = admin.ExecContext(ctx, "DELETE FROM public.goose_db_version WHERE version_id = 2")
			check(t, err)
			check(t, schema.VerifyStartup(ctx, runtime, owner))

			rpt := schema.Receipt{Run: "live-run", Bundle: "live-bundle", Revision: legacyBase, Instance: id}
			for _, other := range []string{"auth", "problem", "submission"} {
				rpt.Targets = append(rpt.Targets, schema.VerifiedTarget{
					Owner: other, Generation: tgt.GenerationID, OID: tgt.DatabaseOID, Version: 1,
				})
			}
			data, err := json.Marshal(rpt)
			check(t, err)
			path := filepath.Join(t.TempDir(), "receipt.json")
			t.Setenv("ASTRACODE_MIGRATION_RECEIPT", path)
			t.Setenv("ASTRACODE_MIGRATION_RUN", rpt.Run)
			t.Setenv("ASTRACODE_MIGRATION_BUNDLE", rpt.Bundle)
			requireRefusal("missing local receipt")
			check(t, os.WriteFile(path, data, 0600))
			check(t, schema.VerifyStartup(ctx, runtime, owner))
			t.Setenv("ASTRACODE_MIGRATION_RUN", "next-run")
			requireRefusal("stale local receipt")
		})
	}
}
