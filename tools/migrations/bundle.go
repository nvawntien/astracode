package migrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing/fstest"

	"go-judge-system/pkg/schema"
)

const legacyBase = "7d518406bcb5acdd2be1d22b74dd199e8d065d7f"

var (
	migrationFilename = regexp.MustCompile(`^[0-9]{5}_[a-z0-9_]+\.sql$`)
	commitHash        = regexp.MustCompile(`^[0-9a-f]{40}$`)
	contentHash       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type versionFile struct {
	Version           int    `json:"version"`
	Filename          string `json:"filename"`
	SQLSHA256         string `json:"sql_sha256"`
	CatalogFileSHA256 string `json:"catalog_file_sha256"`
	CatalogSHA256     string `json:"catalog_sha256"`
}

type sequence struct {
	Owner  string        `json:"owner"`
	Target int           `json:"target"`
	Files  []versionFile `json:"files"`
}

type manifest struct {
	Revision   string     `json:"revision"`
	ToolSHA256 string     `json:"tool_sha256"`
	Dirty      bool       `json:"dirty"`
	Sequences  []sequence `json:"sequences"`
}

type bundle struct {
	manifest manifest
	sources  map[string]fstest.MapFS
	catalogs map[string][][]byte
	digest   string
}

func loadBundle(ctx context.Context, root, toolHash string, released *manifest) (*bundle, error) {
	revision, err := gitOutput(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	head := strings.TrimSpace(string(revision))
	if !commitHash.MatchString(head) || !contentHash.MatchString(toolHash) {
		return nil, errors.New("bundle requires a complete source commit and migrator checksum")
	}
	result := &bundle{
		manifest: manifest{Revision: head, ToolSHA256: toolHash},
		sources:  make(map[string]fstest.MapFS),
		catalogs: make(map[string][][]byte),
	}
	for _, owner := range []string{"auth", "problem", "submission"} {
		migrationDir := "services/" + owner + "/migrations"
		catalogDir := "pkg/schema/catalog/" + owner
		files, err := os.ReadDir(filepath.Join(root, migrationDir))
		if err != nil {
			return nil, err
		}
		if len(files) == 0 {
			return nil, fmt.Errorf("%s has no initial migration", owner)
		}
		catalogFiles, err := os.ReadDir(filepath.Join(root, catalogDir))
		if err != nil || len(catalogFiles) != len(files) {
			return nil, fmt.Errorf("%s needs exactly one catalog snapshot per version", owner)
		}
		prior := sequenceFor(released, owner)
		if released == nil {
			legacy, err := gitOutput(ctx, root, "ls-tree", "-r", "--name-only", legacyBase, "--", migrationDir)
			if err != nil || len(legacy) != 0 {
				return nil, fmt.Errorf("%s empty release baseline could not be established", owner)
			}
		} else if prior.Owner == "" || !commitHash.MatchString(released.Revision) || !contentHash.MatchString(released.ToolSHA256) {
			return nil, fmt.Errorf("%s protected release evidence is incomplete", owner)
		}
		seq := sequence{Owner: owner, Target: len(files)}
		sqlFiles := make(fstest.MapFS)
		for i, file := range files {
			version := i + 1
			name := file.Name()
			if !file.Type().IsRegular() || !migrationFilename.MatchString(name) ||
				!strings.HasPrefix(name, fmt.Sprintf("%05d_", version)) {
				return nil, fmt.Errorf("%s has an unexpected migration name or sequence at version %d", owner, version)
			}
			sqlPath := migrationDir + "/" + name
			catalogPath := fmt.Sprintf("%s/%05d.jsonl", catalogDir, version)
			sqlBytes, err := readRegular(root, sqlPath)
			if err != nil {
				return nil, err
			}
			if err := validateDirectives(sqlBytes); err != nil {
				return nil, fmt.Errorf("%s: %w", sqlPath, err)
			}
			catalogBytes, err := readRegular(root, catalogPath)
			if err != nil {
				return nil, err
			}
			catalogHash, err := schema.Digest(catalogBytes)
			if err != nil {
				return nil, fmt.Errorf("invalid catalog snapshot %s: %w", catalogPath, err)
			}
			entry := versionFile{
				Version: version, Filename: name, SQLSHA256: digest(sqlBytes),
				CatalogFileSHA256: digest(catalogBytes), CatalogSHA256: catalogHash,
			}
			seq.Files = append(seq.Files, entry)
			sqlFiles[name] = &fstest.MapFile{Data: sqlBytes}
			result.catalogs[owner] = append(result.catalogs[owner], catalogBytes)
			committedSQL, sqlErr := gitOutput(ctx, root, "show", head+":"+sqlPath)
			committedCatalog, catalogErr := gitOutput(ctx, root, "show", head+":"+catalogPath)
			if sqlErr != nil || catalogErr != nil || !bytes.Equal(committedSQL, sqlBytes) ||
				!bytes.Equal(committedCatalog, catalogBytes) {
				result.manifest.Dirty = true
			}
		}
		tree, err := gitOutput(ctx, root, "ls-tree", "-r", "-z", "--name-only", head, "--", migrationDir, catalogDir)
		if err != nil {
			return nil, err
		}
		if bytes.Count(tree, []byte{0}) != len(files)*2 {
			result.manifest.Dirty = true
		}
		if err := verifyReleasedPrefix(ctx, root, seq, prior, released); err != nil {
			return nil, err
		}
		result.manifest.Sequences = append(result.manifest.Sequences, seq)
		result.sources[owner] = sqlFiles
	}
	encoded, err := json.Marshal(result.manifest)
	if err != nil {
		return nil, err
	}
	result.digest = digest(encoded)
	return result, nil
}

func validateDirectives(sqlBytes []byte) error {
	up := 0
	for _, line := range bytes.Split(sqlBytes, []byte{'\n'}) {
		line := strings.TrimSpace(string(line))
		if !strings.HasPrefix(line, "--") || !strings.Contains(line, "+goose") {
			continue
		}
		switch line {
		case "-- +goose Up":
			up++
		case "-- +goose Down", "-- +goose StatementBegin", "-- +goose StatementEnd":
		default:
			return errors.New("unexpected Goose directive in transactional migration")
		}
	}
	if up != 1 {
		return errors.New("migration requires one Goose Up directive")
	}
	return nil
}

func (b *bundle) authorize(t target, approvedDirtyDigest string) error {
	if b.manifest.Dirty && (t.Environment != "local" || b.digest != approvedDirtyDigest) {
		return fmt.Errorf("dirty migration bundle requires explicit local approval for %s", b.digest)
	}
	return nil
}

func sequenceFor(m *manifest, owner string) sequence {
	if m != nil {
		for _, seq := range m.Sequences {
			if seq.Owner == owner {
				return seq
			}
		}
	}
	return sequence{}
}

func verifyReleasedPrefix(ctx context.Context, root string, candidate, prior sequence, released *manifest) error {
	if released == nil {
		return nil
	}
	if prior.Target != len(prior.Files) || prior.Target > candidate.Target {
		return fmt.Errorf("%s released migration history is incomplete", candidate.Owner)
	}
	for i, file := range prior.Files {
		if candidate.Files[i] != file {
			return fmt.Errorf("%s released migration version %d was modified", candidate.Owner, i+1)
		}
		path := "services/" + prior.Owner + "/migrations/" + file.Filename
		catalog := fmt.Sprintf("pkg/schema/catalog/%s/%05d.jsonl", prior.Owner, file.Version)
		content, sqlErr := gitOutput(ctx, root, "show", released.Revision+":"+path)
		catalogBytes, catalogErr := gitOutput(ctx, root, "show", released.Revision+":"+catalog)
		if sqlErr != nil || catalogErr != nil || digest(content) != file.SQLSHA256 ||
			digest(catalogBytes) != file.CatalogFileSHA256 {
			return fmt.Errorf("%s release evidence does not match version %d", candidate.Owner, i+1)
		}
	}
	return nil
}

func verifyAppliedPrefix(state schema.State, seq sequence, applied map[int]string) error {
	if state.Version < 0 || state.Version > seq.Target || len(applied) != state.Version ||
		(!state.HasHistory && state.Version != 0) {
		return errors.New("migration history does not match an approved prefix")
	}
	expected, _ := schema.Digest(nil)
	for i := 0; i < state.Version; i++ {
		file := seq.Files[i]
		if applied[file.Version] != file.SQLSHA256 {
			return fmt.Errorf("missing or conflicting checksum at version %d", file.Version)
		}
		expected = file.CatalogSHA256
	}
	if state.CatalogSHA256 != expected {
		return fmt.Errorf("unexpected application schema at version %d", state.Version)
	}
	return nil
}

func readRegular(root, relative string) ([]byte, error) {
	path := filepath.Join(root, relative)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular migration input", relative)
	}
	return os.ReadFile(path)
}

func gitOutput(ctx context.Context, root string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
	return cmd.Output()
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
