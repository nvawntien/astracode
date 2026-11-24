package schema

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
)

// VerifyStartup checks the schema expected by this build before starting work.
// It uses the supplied runtime connection and never initializes the ledger.
func VerifyStartup(ctx context.Context, db beginner, owner string) error {
	const expectedVersion = 1
	expected, err := Expected(owner, expectedVersion)
	if err != nil {
		return fmt.Errorf("%s has no expected database schema for this build", owner)
	}
	actual, err := Read(ctx, db)
	if err != nil {
		return fmt.Errorf("%s database schema cannot be inspected with runtime credentials", owner)
	}
	if actual.Database != owner+"_db" || !actual.HasHistory ||
		actual.Version != expectedVersion || actual.CatalogSHA256 != expected {
		return fmt.Errorf("%s database schema is incompatible with version %d; run the guarded migrations", owner, expectedVersion)
	}
	return verifyLocalReceipt(owner, actual)
}

func verifyLocalReceipt(owner string, actual State) error {
	run := os.Getenv("ASTRACODE_MIGRATION_RUN")
	bundle := os.Getenv("ASTRACODE_MIGRATION_BUNDLE")
	path := os.Getenv("ASTRACODE_MIGRATION_RECEIPT")
	if run == "" && bundle == "" && path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read local migration receipt for %s", owner)
	}
	var receipt Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return fmt.Errorf("decode local migration receipt for %s", owner)
	}
	return receipt.Verify(run, bundle, owner, actual.DatabaseOID, actual.Version)
}
