package migrations

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type migrationRecord struct {
	PriorVersion int    `json:"prior_version"`
	Version      int    `json:"version"`
	BundleSHA256 string `json:"bundle_sha256"`
	FileSHA256   string `json:"file_sha256"`
}

type journal struct {
	Target  target            `json:"target"`
	Applied []migrationRecord `json:"applied"`
	Pending *migrationRecord  `json:"pending,omitempty"`
}

func journalPath(dir string, t target) string {
	return filepath.Join(dir, digest([]byte(t.InstanceID+":"+t.GenerationID)), "journal.json")
}

func readJournal(dir string, t target, seq sequence) (journal, error) {
	record := journal{Target: t}
	data, err := os.ReadFile(journalPath(dir, t))
	if errors.Is(err, os.ErrNotExist) {
		return record, nil
	}
	if err != nil {
		return journal{}, fmt.Errorf("read migration journal: %w", err)
	}
	if json.Unmarshal(data, &record) != nil || record.Target != t || len(record.Applied) > seq.Target {
		return journal{}, errors.New("invalid migration journal target or history")
	}
	for i, entry := range record.Applied {
		if !matchesRecord(entry, seq, i) || !recordManifestExists(dir, t.Owner, entry, seq.Files[i]) {
			return journal{}, fmt.Errorf("invalid applied journal evidence at version %d", i+1)
		}
	}
	if record.Pending != nil && !matchesRecord(*record.Pending, seq, len(record.Applied)) {
		return journal{}, errors.New("invalid pending migration journal entry")
	}
	return record, nil
}

func matchesRecord(record migrationRecord, seq sequence, prior int) bool {
	return prior < seq.Target && record.PriorVersion == prior && record.Version == prior+1 &&
		record.FileSHA256 == seq.Files[prior].SQLSHA256 && contentHash.MatchString(record.BundleSHA256)
}

func recordManifestExists(dir, owner string, record migrationRecord, file versionFile) bool {
	data, err := os.ReadFile(filepath.Join(dir, "manifests", record.BundleSHA256+".json"))
	var m manifest
	if err != nil || digest(data) != record.BundleSHA256 || json.Unmarshal(data, &m) != nil {
		return false
	}
	seq := sequenceFor(&m, owner)
	return record.Version <= len(seq.Files) && seq.Files[record.Version-1] == file
}

func (j journal) appliedHashes() map[int]string {
	applied := make(map[int]string, len(j.Applied))
	for _, record := range j.Applied {
		applied[record.Version] = record.FileSHA256
	}
	return applied
}

func writeJournal(dir string, j journal) error {
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return durableWrite(journalPath(dir, j.Target), data)
}

func writeManifest(dir string, b *bundle) error {
	data, err := json.Marshal(b.manifest)
	if err != nil {
		return err
	}
	if digest(data) != b.digest {
		return errors.New("unexpected manifest checksum")
	}
	return durableWrite(filepath.Join(dir, "manifests", b.digest+".json"), data)
}

// Sync the directory entry as well as the file before authorizing a DB write.
func durableWrite(path string, data []byte) error {
	return writeStateFile(path, data, 0600)
}

func writeStateFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := privateDirectory(dir); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".migration-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncDirectory(dir)
}

func privateDirectory(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(path, 0700); err != nil {
			return err
		}
		if err := syncDirectory(filepath.Dir(path)); err != nil {
			return err
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("migration state requires an owner-only directory")
	}
	return nil
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
