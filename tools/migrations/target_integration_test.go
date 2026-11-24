package migrations

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"go-judge-system/pkg/schema"
)

func TestTargetRoles(t *testing.T) {
	migrationsDir := os.Getenv("ASTRACODE_MIGRATION_PARITY_DIR")
	token := os.Getenv("ASTRACODE_MIGRATION_PROOF_TOKEN")
	if migrationsDir == "" || token == "" {
		t.Skip("requires enrolled disposable PostgreSQL 15.6 databases")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	type roleCase struct {
		environment string
		owner       string
		insert      string
	}
	authInsert := "INSERT INTO public.users (id, username, email, password) VALUES (gen_random_uuid(), 'fixture', 'fixture@example.invalid', 'fixture')"
	problemInsert := "INSERT INTO public.tags (name, slug) VALUES ('fixture', 'fixture')"
	submissionInsert := "INSERT INTO public.outbox_messages (aggregate_id, topic, payload, created_at) VALUES (1, 'fixture', '{}', now())"
	cases := []roleCase{
		{"local", "auth", authInsert},
		{"local", "problem", problemInsert},
		{"local", "submission", submissionInsert},
		{"fixture", "problem", problemInsert},
		{"fixture", "submission", submissionInsert},
	}

	admin := fixtureDB(t, "auth_db", "postgres")
	defer admin.Close()
	checkDisposableFixture(t, ctx, admin, "auth_db", token)
	var instanceID string
	check(t, admin.QueryRowContext(ctx, "SELECT gen_random_uuid()::text").Scan(&instanceID))
	enrolled := make([]target, 0, len(cases))
	for _, tc := range cases {
		scope, err := targetScope(tc.environment, tc.owner)
		check(t, err)
		admin := fixtureDB(t, scope.Database, "postgres")
		defer admin.Close()
		checkDisposableFixture(t, ctx, admin, scope.Database, token)
		tgt, err := bootstrapTarget(ctx, admin, scope, instanceID, "fixture-migrator", "fixture-runtime")
		check(t, err)
		enrolled = append(enrolled, tgt)
	}

	for i, tc := range cases {
		tgt := enrolled[i]
		t.Run(tgt.Database, func(t *testing.T) {
			db := openSingleSession(*fixtureConfig(t, tgt.Database, tgt.MigratorRole))
			defer db.Close()
			conn, err := db.Conn(ctx)
			check(t, err)
			check(t, verifyTarget(ctx, conn, tgt))
			for field, change := range map[string]func(*target){
				"environment": func(other *target) { other.Environment = "managed" },
				"owner":       func(other *target) { other.Owner = enrolled[(i+1)%len(enrolled)].Owner },
				"database":    func(other *target) { other.Database = "postgres" },
				"schema":      func(other *target) { other.Schema = "other" },
				"role":        func(other *target) { other.MigratorRole = tgt.RuntimeRole },
				"instance":    func(other *target) { other.InstanceID = "5369348b-8492-46ce-9859-dec51254df45" },
				"generation":  func(other *target) { other.GenerationID = enrolled[(i+1)%len(enrolled)].GenerationID },
				"oid":         func(other *target) { other.DatabaseOID++ },
			} {
				wrong := tgt
				change(&wrong)
				if err := verifyTarget(ctx, conn, wrong); err == nil {
					t.Fatalf("target with wrong %s accepted", field)
				}
			}
			_, err = conn.ExecContext(ctx, "UPDATE astracode_bootstrap.identity SET owner = 'other'")
			requireDenied(t, err)
			_, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey)
			check(t, err)
			check(t, conn.Close())

			source, err := fs.Sub(os.DirFS(migrationsDir), tc.owner)
			check(t, err)
			provider, err := goose.NewProvider(goose.DialectPostgres, db, source)
			check(t, err)
			_, err = provider.ApplyVersion(ctx, 1, true)
			check(t, err)
			conn, err = db.Conn(ctx)
			check(t, err)
			check(t, grantRuntime(ctx, conn, tgt))
			check(t, conn.Close())

			runtime := fixtureDB(t, tgt.Database, tgt.RuntimeRole)
			defer runtime.Close()
			if tc.environment == "fixture" {
				rpt := schema.FixtureReceipt{Owner: tgt.Owner, Database: tgt.Database,
					Generation: tgt.GenerationID, OID: tgt.DatabaseOID, Version: 1}
				data, err := json.Marshal(rpt)
				check(t, err)
				path := filepath.Join(t.TempDir(), "receipt.json")
				check(t, os.WriteFile(path, data, 0600))
				check(t, schema.VerifyFixture(ctx, runtime, tgt.Owner, path))
				_, err = runtime.ExecContext(ctx, tc.insert)
				check(t, err)
				if err := schema.VerifyFixture(ctx, runtime, tgt.Owner, path); err == nil {
					t.Fatal("populated fixture was accepted for test writes")
				}
				if tc.owner == "problem" {
					_, err = runtime.ExecContext(ctx, "DELETE FROM public.tags")
				} else {
					_, err = runtime.ExecContext(ctx, "DELETE FROM public.outbox_messages")
				}
				check(t, err)
				rpt.Generation = enrolled[(i+1)%len(enrolled)].GenerationID
				data, err = json.Marshal(rpt)
				check(t, err)
				check(t, os.WriteFile(path, data, 0600))
				if err := schema.VerifyFixture(ctx, runtime, tgt.Owner, path); err == nil {
					t.Fatal("runtime accepted evidence from another fixture generation")
				}
			}
			tx, err := runtime.BeginTx(ctx, nil)
			check(t, err)
			_, err = tx.ExecContext(ctx, tc.insert)
			check(t, err)
			check(t, tx.Rollback())
			assertHistory(t, ctx, runtime, 1)
			for _, statement := range []string{
				"CREATE TABLE public.forbidden (id integer)",
				"UPDATE public.goose_db_version SET version_id = 99",
				"SELECT * FROM astracode_bootstrap.identity",
				"SET ROLE " + identifier(tgt.MigratorRole),
			} {
				_, err := runtime.ExecContext(ctx, statement)
				requireDenied(t, err)
			}
			for _, other := range enrolled {
				if other.Database == tgt.Database {
					continue
				}
				var canConnect bool
				check(t, runtime.QueryRowContext(ctx, "SELECT has_database_privilege(current_user, $1, 'CONNECT')", other.Database).Scan(&canConnect))
				if canConnect {
					t.Fatalf("runtime role could connect to %s", other.Database)
				}
			}
		})
	}
}

func fixtureConfig(t *testing.T, database, user string) *pgx.ConnConfig {
	t.Helper()
	config, err := pgx.ParseConfig("host=/var/run/postgresql port=5432 sslmode=disable")
	check(t, err)
	config.Database = database
	config.User = user
	return config
}

func fixtureDB(t *testing.T, database, user string) *sql.DB {
	t.Helper()
	return stdlib.OpenDB(*fixtureConfig(t, database, user))
}

func requireDenied(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("expected insufficient privilege, got %v", err)
	}
}
