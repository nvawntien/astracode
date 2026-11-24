package schema

import (
	"context"
	"database/sql"
	"fmt"
)

// VerifyFixture requires a freshly migrated, data-empty disposable database
// before any integration test writes.
func VerifyFixture(ctx context.Context, db *sql.DB, owner string) error {
	var database, role, dataExists string
	var version int
	switch owner {
	case "problem":
		version = ProblemVersion
		database, role = "problem_mutation_test", "problem_fixture"
		dataExists = `SELECT EXISTS (SELECT 1 FROM public.problems UNION ALL SELECT 1 FROM public.tags
			UNION ALL SELECT 1 FROM public.problem_tags UNION ALL SELECT 1 FROM public.test_cases)`
	case "submission":
		version = SubmissionVersion
		database, role = "submission_detail_test", "detail_fixture"
		dataExists = `SELECT EXISTS (SELECT 1 FROM public.submissions UNION ALL SELECT 1 FROM public.submission_attempts
			UNION ALL SELECT 1 FROM public.submission_results UNION ALL SELECT 1 FROM public.outbox_messages)`
	default:
		return fmt.Errorf("unknown PostgreSQL fixture owner")
	}
	var enrolled bool
	err := db.QueryRowContext(ctx, `
SELECT current_database() = $1 AND current_user = $2 AND session_user = $2
   AND current_setting('server_version_num')::int = 150006
   AND pg_get_userbyid(d.datdba) <> current_user
   AND coalesce(shobj_description(d.oid, 'pg_database') = 'AstraCode disposable integration fixture', false)
FROM pg_database d WHERE datname = current_database()`, database, role).Scan(&enrolled)
	if err != nil || !enrolled {
		return fmt.Errorf("database is not a disposable integration fixture")
	}
	if err := VerifyVersion(ctx, db, database, version); err != nil {
		return err
	}
	var populated bool
	if err := db.QueryRowContext(ctx, dataExists).Scan(&populated); err != nil {
		return fmt.Errorf("read fixture data state: %w", err)
	}
	if populated {
		return fmt.Errorf("disposable fixture contains application data")
	}
	return nil
}
