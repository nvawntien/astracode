package migrations

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"go-judge-system/pkg/schema"
)

func Execute(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: astracode-migrate bootstrap | stage | apply")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	switch args[0] {
	case "bootstrap":
		environment := flags.String("environment", "local", "local or fixture")
		owner := flags.String("owner", "", "service owner")
		instance := flags.String("instance", "", "trusted disposable instance UUID")
		admin := flags.String("admin", "postgres", "disposable database owner")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		return bootstrapCommand(ctx, *environment, *owner, *instance, *admin, in, out)
	case "stage":
		root := flags.String("root", ".", "source checkout")
		artifact := flags.String("tool-sha256", "", "expected SHA-256 of pinned executable")
		snapshot := flags.String("snapshot", "", "private snapshot file to create")
		released := flags.String("released-manifest", "", "approved manifest from protected release records")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if err := verifyArtifact(*artifact); err != nil {
			return err
		}
		var prior *manifest
		if *released != "" {
			prior = new(manifest)
			if err := readJSONFile(*released, prior); err != nil {
				return errors.New("read trusted released manifest")
			}
		}
		b, err := loadBundle(ctx, *root, *artifact, prior)
		if err != nil {
			return err
		}
		if err := writeSnapshot(*snapshot, b); err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(struct {
			Digest string `json:"digest"`
			Dirty  bool   `json:"dirty"`
		}{b.digest, b.manifest.Dirty})
	case "apply":
		return applyCommand(ctx, flags, args[1:], in, out)
	default:
		return errors.New("unknown migration subcommand")
	}
}

func bootstrapCommand(ctx context.Context, environment, owner, instance, admin string, in io.Reader, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	scope, err := targetScope(environment, owner)
	if err != nil {
		return err
	}
	var passwords struct {
		Migrator string `json:"migrator"`
		Runtime  string `json:"runtime"`
	}
	if err := json.NewDecoder(in).Decode(&passwords); err != nil {
		return errors.New("read disposable role credentials")
	}
	config, err := pgx.ParseConfig("host=/var/run/postgresql port=5432 sslmode=disable")
	if err != nil {
		return errors.New("initialize PostgreSQL control connection")
	}
	config.User, config.Database = admin, scope.Database
	config.RuntimeParams = map[string]string{"search_path": "pg_catalog", "application_name": "astracode-bootstrap"}
	db := stdlib.OpenDB(*config)
	defer db.Close()
	t, err := bootstrapTarget(ctx, db, scope, instance, passwords.Migrator, passwords.Runtime)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(t)
}

func applyCommand(ctx context.Context, flags *flag.FlagSet, args []string, in io.Reader, out io.Writer) error {
	state := flags.String("state-dir", "", "owner-only migration state directory")
	snapshot := flags.String("snapshot", "", "staged migration snapshot file")
	digest := flags.String("bundle", "", "approved bundle SHA-256")
	toolSHA := flags.String("tool-sha256", "", "expected SHA-256 of pinned executable")
	enrollment := flags.String("enrollment", "", "trusted enrollment descriptor")
	host := flags.String("host", "127.0.0.1", "local loopback or Compose postgres")
	port := flags.Uint("port", 5432, "PostgreSQL TCP port")
	dirty := flags.String("approve-dirty", "", "exact local dirty bundle digest")
	reconcile := flags.Bool("reconcile", false, "reconcile recorded outcomes for the same bundle")
	run := flags.String("run", "", "fresh local run identifier")
	receipt := flags.String("receipt", "", "new local receipt path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if (*host != "127.0.0.1" && *host != "postgres") || *port == 0 || *port > 65535 ||
		*state == "" || !contentHash.MatchString(*digest) {
		return errors.New("apply requires local PostgreSQL, private state and an approved bundle digest")
	}
	if err := verifyArtifact(*toolSHA); err != nil {
		return err
	}
	b, err := readSnapshot(*snapshot, *digest, *toolSHA)
	if err != nil {
		return err
	}
	targets, err := readTargets(*enrollment, *host, *port, in)
	if err != nil {
		return err
	}
	local := targets[0].identity.Environment == "local"
	if *receipt == "" || (local && *run == "") {
		return errors.New("migration requires a fresh receipt path and a run ID for local activation")
	}
	info, err := os.Lstat(*receipt)
	if !errors.Is(err, os.ErrNotExist) && (err != nil || !info.Mode().IsRegular() || info.Size() != 0) {
		return errors.New("migration receipt must belong to a new run")
	}
	r := runner{b, *state, *dirty, *reconcile, 15 * time.Second}
	results, err := r.run(ctx, targets)
	outputErr := json.NewEncoder(out).Encode(struct {
		Bundle   string    `json:"bundle"`
		Revision string    `json:"revision"`
		Tool     string    `json:"tool_sha256"`
		Results  []outcome `json:"results"`
	}{b.digest, b.manifest.Revision, b.manifest.ToolSHA256, results})
	if err != nil {
		return err
	}
	if outputErr != nil {
		return outputErr
	}
	if !local {
		t := targets[0].identity
		data, err := json.Marshal(schema.FixtureReceipt{
			Owner: t.Owner, Database: t.Database, Generation: t.GenerationID, OID: t.DatabaseOID, Version: results[0].After,
		})
		if err != nil {
			return err
		}
		return durableWrite(*receipt, data)
	}
	rpt := schema.Receipt{Run: *run, Bundle: b.digest, Revision: b.manifest.Revision,
		Instance: targets[0].identity.InstanceID}
	for i, result := range results {
		t := targets[i].identity
		rpt.Targets = append(rpt.Targets, schema.VerifiedTarget{
			Owner: t.Owner, Generation: t.GenerationID, OID: t.DatabaseOID, Version: result.After,
		})
	}
	data, err := json.Marshal(rpt)
	if err != nil {
		return err
	}
	return writeStateFile(*receipt, data, 0444)
}

func readTargets(enrollment, host string, port uint, in io.Reader) ([]migrationTarget, error) {
	var descriptors []target
	if err := readJSONFile(enrollment, &descriptors); err != nil || len(descriptors) == 0 {
		return nil, errors.New("read independently provisioned migration enrollment")
	}
	first := descriptors[0]
	switch first.Environment {
	case "local":
		if len(descriptors) != 3 || descriptors[0].Owner != "auth" ||
			descriptors[1].Owner != "problem" || descriptors[2].Owner != "submission" {
			return nil, errors.New("local activation requires enrollment of Auth, Problem and Submission")
		}
	case "fixture":
		if len(descriptors) != 1 || host != "127.0.0.1" {
			return nil, errors.New("fixture migration requires a single enrolled loopback target")
		}
	default:
		return nil, errors.New("unsupported migration environment")
	}
	var passwords map[string]string
	if err := json.NewDecoder(in).Decode(&passwords); err != nil {
		return nil, errors.New("read migration credentials")
	}
	targets := make([]migrationTarget, 0, len(descriptors))
	for _, t := range descriptors {
		if t.Environment != first.Environment || t.InstanceID != first.InstanceID || passwords[t.Owner] == "" {
			return nil, errors.New("missing trusted instance or migration credentials")
		}
		config, err := pgx.ParseConfig("host=" + host + " port=" + strconv.FormatUint(uint64(port), 10) + " sslmode=disable connect_timeout=5")
		if err != nil {
			return nil, errors.New("initialize PostgreSQL migration connection")
		}
		config.Database, config.User, config.Password = t.Database, t.MigratorRole, passwords[t.Owner]
		targets = append(targets, migrationTarget{t, config})
	}
	return targets, nil
}

func readJSONFile(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func verifyArtifact(expected string) error {
	info, ok := debug.ReadBuildInfo()
	if !ok || info.GoVersion != "go1.26.11" || runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return errors.New("expected Linux amd64 or arm64 migration tooling built with Go 1.26.11")
	}
	hasGoose, hasPGX := false, false
	for _, dep := range info.Deps {
		hasGoose = hasGoose || (dep.Path == "github.com/pressly/goose/v3" && dep.Version == "v3.30.0" && dep.Replace == nil)
		hasPGX = hasPGX || (dep.Path == "github.com/jackc/pgx/v5" && dep.Version == "v5.12.0" && dep.Replace == nil)
	}
	self, err := os.Executable()
	if err != nil {
		return errors.New("identify running migrator artifact")
	}
	data, err := os.ReadFile(self)
	if err != nil || !hasGoose || !hasPGX || digest(data) != expected {
		return errors.New("migration executable checksum or linked dependencies do not match the pin")
	}
	return nil
}
