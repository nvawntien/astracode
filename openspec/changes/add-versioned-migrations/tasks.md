## 1. Scope and retained schema

- [x] 1.1 Record the maintainer correction in ADR-0007 and the Gate 1 history. Validate the revised change strictly.
- [x] 1.2 Preserve the initial SQL and parity captures. Verify the official Goose v3.30.0 pin and compare fresh PostgreSQL 15.6 schemas against the retained dumps.

## 2. CLI and startup

- [x] 2.1 Replace the custom runner and launcher with the official CLI in the base Compose startup path. Test a fresh start, a no-op repeat, an independent version advance, and failure blocking application activation after the migration inputs change.
- [x] 2.2 Keep runtime DDL removed and simplify startup to read-only checks for independently expected versions. Check missing and incompatible schemas are refused before serving.

## 3. Regression verification

- [x] 3.1 Run the three existing PostgreSQL integration suites without skips using disposable CLI-migrated fixtures.
- [x] 3.2 Rehearse submission, judging and rejudge on the migrated Compose stack. Run the full repository verifier and both strict OpenSpec validations.

## 4. Instructions and future deployment

- [x] 4.1 Update startup, explicit seeds, fresh local data and narrowly approved reset guidance. Verify the documented Compose startup and migration commands.
- [x] 4.2 Require successful migration of all owning databases before future deployment activation. Record the prerequisite in the deployment guide, verify it matches the read-only runtime startup gate, and preserve the existing protected workflow and settings.
