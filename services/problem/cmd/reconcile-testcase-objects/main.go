package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net"
	"os"
	"time"

	"go-judge-system/pkg/config"
	"go-judge-system/pkg/database"
	pkgminio "go-judge-system/pkg/minio"
	"go-judge-system/pkg/schema"
	"go-judge-system/services/problem/internal/adapter/outbound/persistence/postgres"
	"go-judge-system/services/problem/internal/adapter/outbound/storage/minio"
	"go-judge-system/services/problem/internal/application/usecase/admin/testcase"
)

func main() {
	configPath := flag.String("config", "./config", "directory containing local config.yaml")
	quiescedAt := flag.String("quiesced-at", "", "RFC3339 time when all testcase writers and URL issuers finished draining")
	maxClockSkew := flag.Duration("max-clock-skew", -1, "verified maximum issuer-to-storage clock skew")
	applyReviewed := flag.String("apply-reviewed", "", "JSON array of reviewed object keys from a dry run")
	flag.Parse()
	if err := run(*configPath, *quiescedAt, *maxClockSkew, *applyReviewed); err != nil {
		log.Fatal(err)
	}
}

func run(configPath, quiescedAt string, maxClockSkew time.Duration, applyReviewed string) error {
	drainedAt, err := time.Parse(time.RFC3339, quiescedAt)
	if err != nil || maxClockSkew < 0 {
		return errors.New("supply the verified quiescence time and a nonnegative clock skew bound")
	}
	var reviewed []string
	if applyReviewed != "" {
		data, err := os.ReadFile(applyReviewed)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(data, &reviewed); err != nil || reviewed == nil {
			return errors.New("reviewed keys must be a JSON array")
		}
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		return err
	}
	storageHost, _, err := net.SplitHostPort(cfg.MinIO.Endpoint)
	if err != nil {
		storageHost = cfg.MinIO.Endpoint
	}
	if !loopback(cfg.Database.Host) || !loopback(storageHost) {
		return errors.New("reconciliation requires loopback PostgreSQL and MinIO endpoints")
	}
	db, err := database.ConnectServiceDatabase(cfg.Database, "problem", schema.ProblemVersion)
	if err != nil {
		return err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	client, err := pkgminio.NewMinioClient(&cfg.MinIO)
	if err != nil {
		return err
	}
	storage, err := minio.NewExistingTestCaseStorage(client, cfg.MinIO)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	candidates, err := testcase.ReconcileObjects(ctx, postgres.NewTestCaseObjectReferences(db), storage, time.Now(), drainedAt, maxClockSkew, reviewed)
	if err != nil {
		return err
	}
	if reviewed == nil {
		return json.NewEncoder(os.Stdout).Encode(candidates)
	}
	return nil
}

func loopback(host string) bool {
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}
