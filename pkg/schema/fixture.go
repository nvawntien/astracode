package schema

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

const FixtureMarkerPrefix = "astracode disposable fixture "

type FixtureReceipt struct {
	Owner      string `json:"owner"`
	Database   string `json:"database"`
	Generation string `json:"generation"`
	OID        uint32 `json:"database_oid"`
	Version    int    `json:"version"`
}

// VerifyFixture requires a freshly migrated, data-empty disposable database
// before any integration test writes.
func VerifyFixture(ctx context.Context, db *sql.DB, owner, receiptPath string) error {
	var database, role, dataExists string
	switch owner {
	case "problem":
		database, role = "problem_mutation_test", "problem_fixture"
		dataExists = `SELECT EXISTS (SELECT 1 FROM public.problems UNION ALL SELECT 1 FROM public.tags
			UNION ALL SELECT 1 FROM public.problem_tags UNION ALL SELECT 1 FROM public.test_cases)`
	case "submission":
		database, role = "submission_detail_test", "detail_fixture"
		dataExists = `SELECT EXISTS (SELECT 1 FROM public.submissions UNION ALL SELECT 1 FROM public.submission_attempts
			UNION ALL SELECT 1 FROM public.submission_results UNION ALL SELECT 1 FROM public.outbox_messages)`
	default:
		return errors.New("unknown PostgreSQL fixture owner")
	}
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		return errors.New("expected a disposable migration fixture receipt")
	}
	var receipt FixtureReceipt
	if json.Unmarshal(data, &receipt) != nil || receipt.Owner != owner || receipt.Database != database ||
		receipt.OID == 0 || receipt.Generation == "" || receipt.Version != 1 {
		return errors.New("invalid disposable migration fixture receipt")
	}
	var enrolled bool
	err = db.QueryRowContext(ctx, `
SELECT current_database() = $1 AND current_user = $2 AND session_user = $2
   AND current_setting('server_version_num')::int = 150006
   AND pg_get_userbyid(d.datdba) <> current_user
   AND coalesce(shobj_description(d.oid, 'pg_database') = $3, false)
FROM pg_database d WHERE datname = current_database()`, database, role, FixtureMarkerPrefix+receipt.Generation).Scan(&enrolled)
	if err != nil || !enrolled {
		return errors.New("database is outside the disposable fixture enrollment")
	}
	state, err := Read(ctx, db)
	if err != nil {
		return fmt.Errorf("read fixture schema: %w", err)
	}
	expected, err := Expected(owner, receipt.Version)
	if err != nil || state.DatabaseOID != receipt.OID || !state.HasHistory ||
		state.Version != receipt.Version || state.CatalogSHA256 != expected {
		return errors.New("disposable fixture does not contain the verified schema")
	}
	var populated bool
	if err := db.QueryRowContext(ctx, dataExists).Scan(&populated); err != nil {
		return fmt.Errorf("read fixture data state: %w", err)
	}
	if populated {
		return errors.New("disposable fixture contains application data")
	}
	return nil
}
