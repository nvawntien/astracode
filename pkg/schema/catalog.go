// Package schema inspects the application catalog and migration ledger without
// granting the service any schema-writing privileges.
package schema

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

//go:embed catalog.sql
var catalogQuery string

//go:embed catalog/*/*.jsonl
var snapshots embed.FS

type beginner interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
}

type State struct {
	CatalogSHA256 string
	HasHistory    bool
	Version       int
	Database      string
	DatabaseOID   uint32
}

func Read(ctx context.Context, db beginner) (State, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "SET LOCAL search_path = pg_catalog"); err != nil {
		return State{}, err
	}
	var result State
	if err := tx.QueryRowContext(ctx, `
SELECT datname, oid, to_regclass('public.goose_db_version') IS NOT NULL
FROM pg_database WHERE datname = current_database()`).Scan(&result.Database, &result.DatabaseOID, &result.HasHistory); err != nil {
		return State{}, err
	}
	if result.HasHistory {
		result.Version, err = historyVersion(ctx, tx)
		if err != nil {
			return State{}, err
		}
	}
	result.CatalogSHA256, err = CatalogDigest(ctx, tx)
	if err != nil {
		return State{}, err
	}
	return result, tx.Commit()
}

func historyVersion(ctx context.Context, tx *sql.Tx) (int, error) {
	var valid bool
	err := tx.QueryRowContext(ctx, `
SELECT c.relkind = 'r' AND c.relowner = n.nspowner AND c.relpersistence = 'p'
   AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
   AND ARRAY(
     SELECT a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
            || ':' || a.attnotnull::text || ':' || a.attidentity::text
     FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum
   ) = ARRAY['id:integer:true:d', 'version_id:bigint:true:', 'is_applied:boolean:true:', 'tstamp:timestamp without time zone:true:']
   AND EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid
               AND p.contype = 'p' AND p.conkey = ARRAY[1]::smallint[] AND p.convalidated)
   AND NOT EXISTS (SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal)
   AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE c.oid IN (i.inhrelid, i.inhparent))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = 'public.goose_db_version'::regclass`).Scan(&valid)
	if err != nil {
		return 0, err
	}
	if !valid {
		return 0, fmt.Errorf("unexpected migration ledger kind or owner")
	}
	rows, err := tx.QueryContext(ctx, "SELECT version_id, is_applied FROM public.goose_db_version ORDER BY id")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	next := 0
	for rows.Next() {
		var version int
		var applied bool
		if err := rows.Scan(&version, &applied); err != nil {
			return 0, err
		}
		if !applied || version != next {
			return 0, fmt.Errorf("unexpected migration ledger entry at position %d", next)
		}
		next++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if next == 0 {
		return 0, fmt.Errorf("migration ledger is missing its bootstrap entry")
	}
	return next - 1, nil
}

// CatalogDigest fingerprints the application schema within the caller's
// transaction. Callers use the pg_catalog search path for stable definitions.
func CatalogDigest(ctx context.Context, tx *sql.Tx) (string, error) {
	rows, err := tx.QueryContext(ctx, catalogQuery)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var catalog bytes.Buffer
	for rows.Next() {
		var row []byte
		if err := rows.Scan(&row); err != nil {
			return "", err
		}
		catalog.Write(row)
		catalog.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return Digest(catalog.Bytes())
}

func Digest(catalog []byte) (string, error) {
	hash := sha256.New()
	decoder := json.NewDecoder(bytes.NewReader(catalog))
	decoder.UseNumber()
	encoder := json.NewEncoder(hash)
	for {
		var row map[string]any
		err := decoder.Decode(&row)
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if len(row) == 0 {
			return "", fmt.Errorf("empty catalog entry")
		}
		if err := encoder.Encode(row); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func Expected(owner string, version int) (string, error) {
	if version == 0 {
		return Digest(nil)
	}
	data, err := snapshots.ReadFile(fmt.Sprintf("catalog/%s/%05d.jsonl", owner, version))
	if err != nil {
		return "", err
	}
	return Digest(data)
}
