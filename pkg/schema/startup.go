package schema

import (
	"context"
	"database/sql"
	"fmt"
)

const (
	AuthVersion       = 1
	ProblemVersion    = 1
	SubmissionVersion = 1
)

// VerifyVersion reads the latest Goose ledger row without creating a ledger.
func VerifyVersion(ctx context.Context, db *sql.DB, database string, expected int) error {
	var actualDatabase string
	var version int
	var applied bool
	err := db.QueryRowContext(ctx, `
SELECT current_database(), version_id, is_applied
FROM public.goose_db_version ORDER BY id DESC LIMIT 1`).Scan(&actualDatabase, &version, &applied)
	if err != nil || actualDatabase != database || version != expected || !applied {
		return fmt.Errorf("expected schema version %d in %s; apply that service's migrations before startup", expected, database)
	}
	return nil
}
