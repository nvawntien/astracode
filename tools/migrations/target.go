package migrations

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go-judge-system/pkg/schema"
)

type target struct {
	Environment  string `json:"environment"`
	Owner        string `json:"owner"`
	Database     string `json:"database"`
	Schema       string `json:"schema"`
	MigratorRole string `json:"migrator_role"`
	RuntimeRole  string `json:"runtime_role"`
	InstanceID   string `json:"instance_id"`
	GenerationID string `json:"generation_id"`
	DatabaseOID  uint32 `json:"database_oid"`
}

func targetScope(environment, owner string) (target, error) {
	switch owner {
	case "auth", "problem", "submission":
	default:
		return target{}, errors.New("unknown migration owner")
	}
	t := target{
		Environment: environment, Owner: owner, Database: owner + "_db", Schema: "public",
		MigratorRole: owner + "_migrator", RuntimeRole: owner + "_app",
	}
	switch {
	case environment == "local":
		return t, nil
	case environment == "fixture" && owner == "problem":
		t.Database, t.MigratorRole, t.RuntimeRole = "problem_mutation_test", "problem_fixture_migrator", "problem_fixture"
	case environment == "fixture" && owner == "submission":
		t.Database, t.MigratorRole, t.RuntimeRole = "submission_detail_test", "detail_fixture_migrator", "detail_fixture"
	default:
		return target{}, errors.New("unsupported migration environment and owner")
	}
	return t, nil
}

// bootstrapTarget is called through the control connection to the selected
// disposable PostgreSQL container. Runtime credentials never call this path.
func bootstrapTarget(ctx context.Context, db *sql.DB, t target, instanceID, migratorPassword, runtimePassword string) (target, error) {
	expected, err := targetScope(t.Environment, t.Owner)
	if err != nil || t != expected || instanceID == "" || migratorPassword == "" || runtimePassword == "" ||
		strings.ContainsRune(migratorPassword, '\x00') || strings.ContainsRune(runtimePassword, '\x00') {
		return target{}, errors.New("invalid database bootstrap inputs")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return target{}, err
	}
	defer tx.Rollback()

	var controlled bool
	err = tx.QueryRowContext(ctx, `
SELECT current_database() = $1
   AND current_user = session_user AND current_user = pg_get_userbyid(d.datdba)
   AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
   AND inet_server_addr() IS NULL AND NOT pg_is_in_recovery()
   AND current_setting('server_version_num')::int = 150006,
   d.oid, gen_random_uuid()::text
FROM pg_database d WHERE d.datname = current_database()`, t.Database).Scan(&controlled, &t.DatabaseOID, &t.GenerationID)
	if err != nil {
		return target{}, err
	}
	if !controlled {
		return target{}, errors.New("database bootstrap requires its disposable control connection")
	}
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLockKey); err != nil {
		return target{}, err
	}
	var empty bool
	err = tx.QueryRowContext(ctx, `
SELECT NOT EXISTS (SELECT 1 FROM pg_namespace
                   WHERE nspname NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast')
                     AND left(nspname, 3) <> 'pg_')
   AND NOT EXISTS (SELECT 1 FROM pg_depend
                   WHERE refclassid = 'pg_namespace'::regclass AND refobjid = 'public'::regnamespace)`).Scan(&empty)
	if err != nil {
		return target{}, err
	}
	if !empty {
		return target{}, errors.New("database bootstrap requires an unenrolled empty schema")
	}
	// The following role statements include local credentials. Suppress
	// PostgreSQL statement text for this bootstrap transaction only.
	if _, err := tx.ExecContext(ctx, "SET LOCAL log_statement = 'none'; SET LOCAL log_min_error_statement = 'panic'"); err != nil {
		return target{}, errors.New("configure credential-safe bootstrap logging")
	}

	for role, password := range map[string]string{t.MigratorRole: migratorPassword, t.RuntimeRole: runtimePassword} {
		if err := bootstrapRole(ctx, tx, t, role, password); err != nil {
			return target{}, err
		}
	}
	database := identifier(t.Database)
	migrator, runtime := identifier(t.MigratorRole), identifier(t.RuntimeRole)
	for _, statement := range []string{
		"REVOKE ALL ON DATABASE " + database + " FROM PUBLIC",
		"GRANT CONNECT ON DATABASE " + database + " TO " + migrator + ", " + runtime,
		"REVOKE ALL ON SCHEMA public FROM PUBLIC",
		"ALTER SCHEMA public OWNER TO " + migrator,
		"GRANT USAGE ON SCHEMA public TO " + runtime,
		"CREATE SCHEMA astracode_bootstrap",
		"REVOKE ALL ON SCHEMA astracode_bootstrap FROM PUBLIC",
		`CREATE TABLE astracode_bootstrap.identity (
			singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
			instance_id uuid NOT NULL, generation_id uuid NOT NULL,
			environment text NOT NULL, owner text NOT NULL
		)`,
		"GRANT USAGE ON SCHEMA astracode_bootstrap TO " + migrator,
		"GRANT SELECT ON astracode_bootstrap.identity TO " + migrator,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return target{}, err
		}
	}
	t.InstanceID = instanceID
	if t.Environment == "fixture" {
		if _, err := tx.ExecContext(ctx, "COMMENT ON DATABASE "+database+" IS "+literal(schema.FixtureMarkerPrefix+t.GenerationID)); err != nil {
			return target{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO astracode_bootstrap.identity (instance_id, generation_id, environment, owner)
VALUES ($1, $2, $3, $4)`, t.InstanceID, t.GenerationID, t.Environment, t.Owner); err != nil {
		return target{}, err
	}
	if err := tx.Commit(); err != nil {
		return target{}, err
	}
	return t, nil
}

func bootstrapRole(ctx context.Context, tx *sql.Tx, t target, role, password string) error {
	marker := "astracode " + t.Environment + " " + t.Owner + " " + role
	var reusable bool
	err := tx.QueryRowContext(ctx, `
SELECT rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
   AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
   AND coalesce(shobj_description(r.oid, 'pg_authid') = $2, false)
FROM pg_roles r WHERE rolname = $1`, role, marker).Scan(&reusable)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := tx.ExecContext(ctx, "CREATE ROLE "+identifier(role)+" LOGIN PASSWORD "+literal(password)); err != nil {
			return roleError(role, err)
		}
		_, err = tx.ExecContext(ctx, "COMMENT ON ROLE "+identifier(role)+" IS "+literal(marker))
		return err
	case err != nil:
		return err
	case t.Environment != "fixture" || !reusable:
		return fmt.Errorf("unexpected existing role %s", role)
	}
	_, err = tx.ExecContext(ctx, "ALTER ROLE "+identifier(role)+" PASSWORD "+literal(password))
	if err != nil {
		return roleError(role, err)
	}
	return nil
}

func verifyTarget(ctx context.Context, conn *sql.Conn, t target) error {
	expected, err := targetScope(t.Environment, t.Owner)
	if err != nil || t.Database != expected.Database || t.Schema != expected.Schema ||
		t.MigratorRole != expected.MigratorRole || t.RuntimeRole != expected.RuntimeRole ||
		t.InstanceID == "" || t.GenerationID == "" || t.DatabaseOID == 0 {
		return errors.New("invalid target identity descriptor")
	}
	var matches bool
	err = conn.QueryRowContext(ctx, `
SELECT current_database() = $1 AND d.oid = $2 AND current_user = $3
   AND session_user = $3 AND pg_get_userbyid(n.nspowner) = $3
   AND i.instance_id::text = $4 AND i.generation_id::text = $5
   AND i.environment = $6 AND i.owner = $7 AND NOT pg_is_in_recovery()
   AND current_setting('transaction_read_only') = 'off'
   AND current_setting('server_version_num')::int = 150006
   AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid))
   AND NOT EXISTS (SELECT 1 FROM pg_namespace
      WHERE nspname NOT IN ('public', 'astracode_bootstrap', 'information_schema', 'pg_catalog', 'pg_toast')
        AND left(nspname, 3) <> 'pg_')
FROM pg_database d, pg_namespace n, astracode_bootstrap.identity i
WHERE d.datname = current_database() AND n.nspname = $8 AND i.singleton`,
		t.Database, t.DatabaseOID, t.MigratorRole, t.InstanceID, t.GenerationID, t.Environment, t.Owner, t.Schema).Scan(&matches)
	if err != nil {
		return fmt.Errorf("read migration target identity: %w", err)
	}
	if !matches {
		return errors.New("migration target identity or ownership mismatch")
	}
	return nil
}

func verifyRuntimeGrants(ctx context.Context, db *sql.DB, t target) error {
	var valid bool
	err := db.QueryRowContext(ctx, `
SELECT r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
   AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
   AND has_database_privilege(r.oid, current_database(), 'CONNECT')
   AND NOT has_database_privilege(r.oid, current_database(), 'CREATE,TEMP')
   AND has_schema_privilege(r.oid, 'public', 'USAGE')
   AND NOT has_schema_privilege(r.oid, 'public', 'CREATE')
   AND NOT has_schema_privilege(r.oid, 'astracode_bootstrap', 'USAGE,CREATE')
   AND NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND (
       c.relowner = r.oid OR CASE
         WHEN c.oid = 'public.goose_db_version'::regclass THEN
           NOT has_table_privilege(r.oid, c.oid, 'SELECT')
           OR has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         WHEN c.relkind IN ('r', 'p') THEN
           EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS required(priv)
                   WHERE NOT has_table_privilege(r.oid, c.oid, required.priv))
           OR has_table_privilege(r.oid, c.oid, 'TRUNCATE,REFERENCES,TRIGGER')
         WHEN c.relkind = 'S' THEN
           CASE WHEN EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                      AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.goose_db_version'::regclass)
                THEN has_sequence_privilege(r.oid, c.oid, 'USAGE,UPDATE,SELECT')
                ELSE NOT has_sequence_privilege(r.oid, c.oid, 'USAGE')
                     OR has_sequence_privilege(r.oid, c.oid, 'UPDATE,SELECT')
           END
         ELSE false
       END
     )
   )
FROM pg_roles r WHERE r.rolname = $1`, t.RuntimeRole).Scan(&valid)
	if err != nil {
		return fmt.Errorf("read runtime privileges: %w", err)
	}
	if !valid {
		return errors.New("runtime privileges do not match the migration contract")
	}
	return nil
}

func grantRuntime(ctx context.Context, conn *sql.Conn, t target) error {
	runtime := identifier(t.RuntimeRole)
	rows, err := conn.QueryContext(ctx, `
SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.relkind::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S')
  AND c.oid <> 'public.goose_db_version'::regclass
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep WHERE c.relkind = 'S'
      AND dep.classid = 'pg_class'::regclass AND dep.objid = c.oid
      AND dep.refclassid = 'pg_class'::regclass AND dep.refobjid = 'public.goose_db_version'::regclass
  )
ORDER BY c.relname`, t.Schema)
	if err != nil {
		return err
	}
	defer rows.Close()
	statements := []string{"GRANT SELECT ON TABLE public.goose_db_version TO " + runtime}
	for rows.Next() {
		var name, kind string
		if err := rows.Scan(&name, &kind); err != nil {
			return err
		}
		if kind == "S" {
			statements = append(statements, "GRANT USAGE ON SEQUENCE "+name+" TO "+runtime)
		} else {
			statements = append(statements, "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "+name+" TO "+runtime)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func identifier(name string) string {
	return pgx.Identifier{name}.Sanitize()
}

func literal(value string) string {
	return "E'" + strings.ReplaceAll(strings.ReplaceAll(value, "\\", "\\\\"), "'", "''") + "'"
}

func roleError(role string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Errorf("provision role %s: PostgreSQL error %s", role, pgErr.Code)
	}
	return fmt.Errorf("provision role %s failed", role)
}
