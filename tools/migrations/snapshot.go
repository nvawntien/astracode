package migrations

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing/fstest"

	"go-judge-system/pkg/schema"
)

type snapshot struct {
	Manifest manifest            `json:"manifest"`
	SQL      map[string][][]byte `json:"sql"`
	Catalogs map[string][][]byte `json:"catalogs"`
}

func writeSnapshot(path string, b *bundle) error {
	data := snapshot{Manifest: b.manifest, SQL: make(map[string][][]byte), Catalogs: b.catalogs}
	for _, seq := range b.manifest.Sequences {
		for _, file := range seq.Files {
			data.SQL[seq.Owner] = append(data.SQL[seq.Owner], b.sources[seq.Owner][file.Filename].Data)
		}
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return durableWrite(path, encoded)
}

func readSnapshot(path, bundleSHA, toolSHA string) (*bundle, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read staged migration bundle")
	}
	var s snapshot
	if err := json.Unmarshal(encoded, &s); err != nil {
		return nil, errors.New("decode staged migration bundle")
	}
	m, err := json.Marshal(s.Manifest)
	if err != nil {
		return nil, err
	}
	if digest(m) != bundleSHA || s.Manifest.ToolSHA256 != toolSHA || !commitHash.MatchString(s.Manifest.Revision) {
		return nil, errors.New("staged bundle checksum, source revision or migrator pin mismatch")
	}
	owners := []string{"auth", "problem", "submission"}
	if len(s.Manifest.Sequences) != len(owners) || len(s.SQL) != len(owners) || len(s.Catalogs) != len(owners) {
		return nil, errors.New("staged bundle requires all three service sequences")
	}
	result := &bundle{manifest: s.Manifest, sources: make(map[string]fstest.MapFS), catalogs: s.Catalogs, digest: bundleSHA}
	for i, owner := range owners {
		seq := s.Manifest.Sequences[i]
		if owner != seq.Owner || seq.Target == 0 || seq.Target != len(seq.Files) ||
			seq.Target != len(s.SQL[owner]) || seq.Target != len(s.Catalogs[owner]) {
			return nil, errors.New("staged bundle sequence is incomplete or out of order")
		}
		files := make(fstest.MapFS, len(seq.Files))
		for i, entry := range seq.Files {
			sql, catalog := s.SQL[owner][i], s.Catalogs[owner][i]
			catalogSHA, err := schema.Digest(catalog)
			if err != nil || entry.Version != i+1 || !migrationFilename.MatchString(entry.Filename) ||
				!strings.HasPrefix(entry.Filename, fmt.Sprintf("%05d_", entry.Version)) ||
				digest(sql) != entry.SQLSHA256 || digest(catalog) != entry.CatalogFileSHA256 ||
				catalogSHA != entry.CatalogSHA256 || validateDirectives(sql) != nil {
				return nil, fmt.Errorf("invalid staged migration %s version %d", owner, i+1)
			}
			files[entry.Filename] = &fstest.MapFile{Data: sql}
		}
		result.sources[owner] = files
	}
	return result, nil
}
