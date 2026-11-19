package worker

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/domain"
)

type testCaseMetadataRepository struct {
	metadata outbound.OfficialTestCaseMetadata
	seenID   int64
}

func (r *testCaseMetadataRepository) GetOfficialTestCaseMetadata(
	_ context.Context, problemID int64,
) (outbound.OfficialTestCaseMetadata, error) {
	r.seenID = problemID
	return r.metadata, nil
}

type presignedTestCaseStorage struct {
	outbound.TestCaseStorage
	key    string
	expiry time.Duration
}

func (s *presignedTestCaseStorage) GetPresignedURL(_ context.Context, key string, expiry time.Duration) (string, error) {
	s.key, s.expiry = key, expiry
	return "https://storage.internal/official.zip", nil
}

func TestGetTestCaseNormalizesCanonicalExecutionLimits(t *testing.T) {
	for _, tt := range []struct {
		name   string
		time   float64
		memory int
		wantMS int64
		wantKB int64
	}{
		{"fractional seconds", 0.5, 128, 500, 131_072},
		{"one second", 1, 512, 1_000, 524_288},
		{"two seconds", 2, 256, 2_000, 262_144},
		{"legacy one second", 1000, 1024, 1_000, 1_048_576},
		{"legacy two seconds", 2000, 512, 2_000, 524_288},
	} {
		t.Run(tt.name, func(t *testing.T) {
			repo := &testCaseMetadataRepository{metadata: outbound.OfficialTestCaseMetadata{
				ZipObjectKey: "dataset.zip", TestCount: 14, Version: 3, TimeLimit: tt.time, MemoryLimit: tt.memory,
			}}
			storage := &presignedTestCaseStorage{}
			response, err := NewGetTestCaseUseCase(repo, storage).Execute(context.Background(), 42)
			if err != nil {
				t.Fatal(err)
			}
			if response.TimeLimitMS != tt.wantMS || response.MemoryLimitKB != tt.wantKB {
				t.Errorf("limits = %d ms / %d KiB, want %d / %d", response.TimeLimitMS, response.MemoryLimitKB, tt.wantMS, tt.wantKB)
			}
			if response.TestCount != 14 || response.Version != 3 || response.ZipDownloadURL != "https://storage.internal/official.zip" {
				t.Errorf("testcase metadata = %+v", response)
			}
			if repo.seenID != 42 || storage.key != "dataset.zip" || storage.expiry != 15*time.Minute {
				t.Errorf("lookup = %d, signed key = %q, expiry = %s", repo.seenID, storage.key, storage.expiry)
			}
		})
	}
}

func TestGetTestCaseRejectsUnusableExecutionLimitsBeforePresigning(t *testing.T) {
	for _, tt := range []struct {
		name   string
		time   float64
		memory int
		want   error
	}{
		{"missing time", 0, 512, domain.ErrInvalidTimeLimit},
		{"negative time", -1, 512, domain.ErrInvalidTimeLimit},
		{"submillisecond time", 0.0005, 512, domain.ErrInvalidTimeLimit},
		{"nonfinite time", math.NaN(), 512, domain.ErrInvalidTimeLimit},
		{"overflowing clock time", 1e15, 512, domain.ErrInvalidTimeLimit},
		{"missing memory", 1, 0, domain.ErrInvalidMemoryLimit},
		{"negative memory", 1, -512, domain.ErrInvalidMemoryLimit},
		{"overflowing memory bytes", 1, math.MaxInt, domain.ErrInvalidMemoryLimit},
	} {
		t.Run(tt.name, func(t *testing.T) {
			repo := &testCaseMetadataRepository{metadata: outbound.OfficialTestCaseMetadata{
				ZipObjectKey: "dataset.zip", TestCount: 14, Version: 3, TimeLimit: tt.time, MemoryLimit: tt.memory,
			}}
			storage := &presignedTestCaseStorage{}
			response, err := NewGetTestCaseUseCase(repo, storage).Execute(context.Background(), 42)
			if response != nil || !errors.Is(err, tt.want) {
				t.Fatalf("Execute() response = %+v, error = %v, want only %v", response, err, tt.want)
			}
			if storage.key != "" {
				t.Error("signed a download URL for invalid problem limits")
			}
		})
	}
}
