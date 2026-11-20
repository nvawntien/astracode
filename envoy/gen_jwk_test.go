package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareJWK(t *testing.T) {
	key := JWK{Kty: "oct", K: "dGVzdC1zaWduaW5nLWtleQ", Alg: "HS256", Use: "sig"}
	stale := key
	stale.K = "c3RhbGUtdGVzdC1rZXk"

	validJSON := jwkFixture(t, key)
	staleJSON := jwkFixture(t, stale)

	for _, tc := range []struct {
		name      string
		existing  []byte
		mode      os.FileMode
		replace   bool
		wantWrite bool
		wantError string
	}{
		{name: "generate missing key", wantWrite: true},
		{name: "reuse matching key", existing: validJSON, mode: 0600},
		{name: "reject permissive mode", existing: validJSON, mode: 0644, wantError: "must have mode 0600"},
		{name: "reject stale key", existing: staleJSON, mode: 0600, wantError: "does not match JWT_ACCESS_SECRET"},
		{name: "reject malformed key", existing: []byte("{"), mode: 0600, wantError: "is invalid"},
		{name: "replace regular file", existing: staleJSON, mode: 0644, replace: true, wantWrite: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "symmetric.json")
			var before os.FileInfo
			if tc.existing != nil {
				before = writeJWKFixture(t, path, tc.existing, tc.mode)
			}

			written, err := prepareJWK(path, key, tc.replace)
			if tc.wantError == "" && err != nil {
				t.Fatalf("prepare JWK: %v", err)
			}
			if tc.wantError != "" && (err == nil || !strings.Contains(err.Error(), tc.wantError)) {
				t.Fatalf("expected JWK error containing %q, got %v", tc.wantError, err)
			}
			if written != tc.wantWrite {
				t.Fatalf("written = %v, want %v", written, tc.wantWrite)
			}
			if !written {
				assertJWKUnchanged(t, path, tc.existing, before)
				return
			}

			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode() != 0600 {
				t.Fatalf("written JWK mode = %v, want regular file with mode 0600", info.Mode())
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var jwks JWKS
			if json.Unmarshal(data, &jwks) != nil || len(jwks.Keys) != 1 || jwks.Keys[0] != key {
				t.Fatal("written JWK does not match the expected key")
			}
		})
	}
}

func TestPrepareJWKRejectsSymlink(t *testing.T) {
	key := JWK{Kty: "oct", K: "dGVzdC1zaWduaW5nLWtleQ", Alg: "HS256", Use: "sig"}
	data := jwkFixture(t, key)
	dir := t.TempDir()
	target := filepath.Join(dir, "target.json")
	before := writeJWKFixture(t, target, data, 0600)
	path := filepath.Join(dir, "symmetric.json")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name    string
		replace bool
	}{
		{name: "validate"},
		{name: "replace", replace: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			written, err := prepareJWK(path, key, tc.replace)
			if written || err == nil || !strings.Contains(err.Error(), "must be a regular file") {
				t.Fatalf("expected symlink rejection, got written = %v, error = %v", written, err)
			}
			if link, err := os.Readlink(path); err != nil || link != target {
				t.Fatal("the JWK symlink was changed")
			}
			assertJWKUnchanged(t, target, data, before)
		})
	}
}

func TestPrepareJWKRejectsDirectory(t *testing.T) {
	path := t.TempDir()
	if written, err := prepareJWK(path, JWK{}, false); written || err == nil || !strings.Contains(err.Error(), "must be a regular file") {
		t.Fatalf("expected directory rejection, got written = %v, error = %v", written, err)
	}
}

func jwkFixture(t *testing.T, key JWK) []byte {
	t.Helper()
	data, err := json.Marshal(JWKS{Keys: []JWK{key}})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeJWKFixture(t *testing.T, path string, data []byte, mode os.FileMode) os.FileInfo {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func assertJWKUnchanged(t *testing.T, path string, data []byte, before os.FileInfo) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(info, before) || info.Mode() != before.Mode() || !info.ModTime().Equal(before.ModTime()) {
		t.Fatal("the existing JWK file or its metadata was changed")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("the existing JWK contents were changed")
	}
}
