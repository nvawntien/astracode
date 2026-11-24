package migrations

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"go-judge-system/pkg/schema"
)

func TestBundleProvenance(t *testing.T) {
	ctx := context.Background()
	source, err := filepath.Abs("../..")
	check(t, err)
	root := t.TempDir()
	runGit(t, source, "clone", "--quiet", "--shared", "--no-checkout", source, root)
	runGit(t, root, "checkout", "--quiet", "--detach", legacyBase)

	const initial = "-- +goose Up\nCREATE TABLE public.example (id integer);\n"
	const shape = "{\"kind\":\"table\",\"table\":\"example\"}\n"
	write := func(path, value string) {
		t.Helper()
		path = filepath.Join(root, path)
		check(t, os.MkdirAll(filepath.Dir(path), 0755))
		check(t, os.WriteFile(path, []byte(value), 0644))
	}
	for _, owner := range []string{"auth", "problem", "submission"} {
		write("services/"+owner+"/migrations/00001_initial_schema.sql", initial)
		write("pkg/schema/catalog/"+owner+"/00001.jsonl", shape)
	}
	runGit(t, root, "add", "services", "pkg/schema/catalog")
	runGit(t, root, "commit", "--quiet", "-m", "Migration fixture")
	toolSHA := strings.Repeat("a", 64)
	clean, err := loadBundle(ctx, root, toolSHA, nil)
	check(t, err)
	if clean.manifest.Dirty {
		t.Fatal("committed bundle reported as dirty")
	}
	local, err := targetScope("local", "problem")
	check(t, err)
	fixture, err := targetScope("fixture", "problem")
	check(t, err)

	const path = "services/problem/migrations/00001_initial_schema.sql"
	write(path, initial+"-- an uncommitted change\n")
	dirty, err := loadBundle(ctx, root, toolSHA, nil)
	check(t, err)
	if !dirty.manifest.Dirty || dirty.digest == clean.digest || dirty.manifest.Revision != clean.manifest.Revision {
		t.Fatal("changed bytes did not invalidate the bundle at the same HEAD")
	}
	if dirty.authorize(local, clean.digest) == nil || dirty.authorize(fixture, dirty.digest) == nil {
		t.Fatal("dirty bundle accepted without exact local approval")
	}
	check(t, dirty.authorize(local, dirty.digest))
	if _, err := loadBundle(ctx, root, toolSHA, &clean.manifest); err == nil {
		t.Fatal("edited released migration was accepted")
	}
	for _, directive := range []string{"-- +goose no transaction", "-- +goose  NO TRANSACTION", "-- +goose ENVSUB ON"} {
		write(path, initial+directive+"\n")
		if _, err := loadBundle(ctx, root, toolSHA, nil); err == nil {
			t.Fatalf("unsupported directive was accepted: %s", directive)
		}
	}
	write(path, initial)
	const next = "services/problem/migrations/00002_add_column.sql"
	write(next, "-- +goose Up\nALTER TABLE public.example ADD COLUMN value integer;\n")
	write("pkg/schema/catalog/problem/00002.jsonl", shape)
	extended, err := loadBundle(ctx, root, toolSHA, &clean.manifest)
	check(t, err)
	if !extended.manifest.Dirty || extended.digest == clean.digest || extended.authorize(local, clean.digest) == nil {
		t.Fatal("new version reused a prior bundle approval")
	}
	rpt := schema.Receipt{
		Run: "fixture-run", Bundle: clean.digest, Revision: clean.manifest.Revision, Instance: "instance",
		Targets: []schema.VerifiedTarget{
			{Owner: "auth", OID: 11, Generation: "auth-generation", Version: 1},
			{Owner: "problem", OID: 12, Generation: "problem-generation", Version: 1},
			{Owner: "submission", OID: 13, Generation: "submission-generation", Version: 1},
		},
	}
	check(t, rpt.Verify("fixture-run", clean.digest, "problem", 12, 1))
	if rpt.Verify("fixture-run", extended.digest, "problem", 12, 1) == nil ||
		rpt.Verify("fixture-run", dirty.digest, "problem", 12, 1) == nil {
		t.Fatal("modified source reused an earlier activation receipt")
	}
	pathSnapshot := filepath.Join(t.TempDir(), "staging", "bundle.json")
	check(t, writeSnapshot(pathSnapshot, extended))
	if _, err := readSnapshot(pathSnapshot, clean.digest, toolSHA); err == nil {
		t.Fatal("verified bundle receipt accepted a different staged snapshot")
	}
	_, err = readSnapshot(pathSnapshot, extended.digest, toolSHA)
	check(t, err)
	check(t, os.Rename(filepath.Join(root, next), filepath.Join(root, "services/problem/migrations/00001_duplicate.sql")))
	if _, err := loadBundle(ctx, root, toolSHA, nil); err == nil {
		t.Fatal("duplicate version was accepted")
	}
	check(t, os.Rename(filepath.Join(root, "services/problem/migrations/00001_duplicate.sql"), filepath.Join(root, "services/problem/migrations/00003_gap.sql")))
	if _, err := loadBundle(ctx, root, toolSHA, nil); err == nil {
		t.Fatal("version gap was accepted")
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Migration Fixture",
		"-c", "user.email=fixture@example.invalid", "-c", "core.fsmonitor=false"}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", args[0], err, output)
	}
}
