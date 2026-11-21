package testcase

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"go-judge-system/workers/judge/internal/application/port/outbound"
	workerdomain "go-judge-system/workers/judge/internal/domain"

	"go.uber.org/zap"
)

func TestOfficialLoaderLoadsZeroPaddedPairsDeterministically(t *testing.T) {
	t.Parallel()

	zipBytes := buildZip(t, map[string]string{
		"002.in":  "2\n",
		"002.out": "2\n",
		"001.in":  "1\n",
		"001.out": "1\n",
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(zipBytes)
	}))
	t.Cleanup(server.Close)

	loader := NewOfficialLoader(zap.NewNop())
	loader.cacheBaseDir = t.TempDir()

	got, err := loader.Load(context.Background(), outbound.ProblemTestCaseMetadata{
		ProblemID:      42,
		ZipDownloadURL: server.URL,
		TestCount:      2,
		Version:        1,
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.TestCount != 2 {
		t.Fatalf("TestCount = %d, want 2", got.TestCount)
	}
	if got.Version != 1 {
		t.Fatalf("Version = %d, want 1", got.Version)
	}
	if got.DatasetChecksum == "" {
		t.Fatal("DatasetChecksum is empty")
	}
	if len(got.TestCases) != 2 {
		t.Fatalf("len(testCases) = %d, want 2", len(got.TestCases))
	}
	if got.TestCases[0].Index != 1 || got.TestCases[0].ID != "1" || got.TestCases[0].Stdin != "1\n" || *got.TestCases[0].ExpectedOutput != "1\n" {
		t.Fatalf("first testcase = %#v", got.TestCases[0])
	}
	if got.TestCases[1].Index != 2 || got.TestCases[1].ID != "2" || got.TestCases[1].Stdin != "2\n" || *got.TestCases[1].ExpectedOutput != "2\n" {
		t.Fatalf("second testcase = %#v", got.TestCases[1])
	}
}

func TestOfficialLoaderCacheHitMissProvenance(t *testing.T) {
	t.Parallel()

	zipBytes := buildZip(t, map[string]string{
		"001.in":  "1\n",
		"001.out": "1\n",
	})
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write(zipBytes)
	}))
	t.Cleanup(server.Close)

	loader := NewOfficialLoader(zap.NewNop())
	loader.cacheBaseDir = t.TempDir()
	metadata := outbound.ProblemTestCaseMetadata{
		ProblemID:      42,
		ZipDownloadURL: server.URL,
		TestCount:      1,
		Version:        1,
	}

	miss, err := loader.Load(context.Background(), metadata)
	if err != nil {
		t.Fatalf("cache miss Load() error = %v", err)
	}
	hit, err := loader.Load(context.Background(), metadata)
	if err != nil {
		t.Fatalf("cache hit Load() error = %v", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("HTTP requests = %d, want 1 cache miss only", requests.Load())
	}
	if miss.DatasetChecksum == "" || miss.DatasetChecksum != hit.DatasetChecksum {
		t.Fatalf("cache miss/hit checksums = %q/%q, want matching non-empty", miss.DatasetChecksum, hit.DatasetChecksum)
	}

	changedZipBytes := buildZip(t, map[string]string{
		"001.in":  "2\n",
		"001.out": "2\n",
	})
	changedServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(changedZipBytes)
	}))
	t.Cleanup(changedServer.Close)

	changed, err := loader.Load(context.Background(), outbound.ProblemTestCaseMetadata{
		ProblemID:      42,
		ZipDownloadURL: changedServer.URL,
		TestCount:      1,
		Version:        2,
	})
	if err != nil {
		t.Fatalf("changed artifact Load() error = %v", err)
	}
	if changed.DatasetChecksum == miss.DatasetChecksum {
		t.Fatalf("changed artifact checksum = %q, want different from %q", changed.DatasetChecksum, miss.DatasetChecksum)
	}
}

func TestOfficialLoaderSeparatesObjectsWithReusedVersion(t *testing.T) {
	firstZip := buildZip(t, map[string]string{"1.in": "old", "1.out": "old"})
	secondZip := buildZip(t, map[string]string{"1.in": "new", "1.out": "new"})
	var downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		downloads.Add(1)
		if req.URL.Path == "/old.zip" {
			_, _ = w.Write(firstZip)
			return
		}
		_, _ = w.Write(secondZip)
	}))
	defer server.Close()
	loader := NewOfficialLoader(zap.NewNop())
	loader.cacheBaseDir = t.TempDir()
	metadata := outbound.ProblemTestCaseMetadata{ProblemID: 42, Version: 1, TestCount: 1}
	load := func(path string) outbound.OfficialTestCaseBundle {
		t.Helper()
		metadata.ZipDownloadURL = server.URL + path
		bundle, err := loader.Load(context.Background(), metadata)
		if err != nil {
			t.Fatal(err)
		}
		return bundle
	}
	old := load("/old.zip?signature=one")
	newBundle := load("/new.zip?signature=two")
	hit := load("/new.zip?signature=three")
	if downloads.Load() != 2 || old.DatasetChecksum == newBundle.DatasetChecksum ||
		newBundle.TestCases[0].SandboxInputPath != hit.TestCases[0].SandboxInputPath {
		t.Fatalf("cache did not distinguish objects and reuse the refreshed URL: downloads=%d", downloads.Load())
	}
	requireGenerationInput(t, old, "old")
	requireGenerationInput(t, newBundle, "new")
}

func TestOfficialLoaderConcurrentRepairPreservesActiveGeneration(t *testing.T) {
	zipBytes := buildZip(t, map[string]string{"1.in": "held input", "1.out": "expected"})
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var repair atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if repair.Load() {
			entered <- struct{}{}
			select {
			case <-release:
			case <-req.Context().Done():
				return
			}
		}
		_, _ = w.Write(zipBytes)
	}))
	defer server.Close()
	loader := NewOfficialLoader(zap.NewNop())
	loader.cacheBaseDir = t.TempDir()
	metadata := outbound.ProblemTestCaseMetadata{ProblemID: 42, Version: 1, TestCount: 1, ZipDownloadURL: server.URL + "/immutable.zip"}
	held, err := loader.Load(context.Background(), metadata)
	if err != nil {
		t.Fatal(err)
	}
	heldPath := held.TestCases[0].SandboxInputPath
	if err := os.Remove(filepath.Join(filepath.Dir(heldPath), cacheSHA256File)); err != nil {
		t.Fatal(err)
	}
	repair.Store(true)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type loadResult struct {
		bundle outbound.OfficialTestCaseBundle
		err    error
	}
	results := make(chan loadResult, 2)
	for range 2 {
		go func() {
			bundle, err := loader.Load(ctx, metadata)
			results <- loadResult{bundle, err}
		}()
	}
	for range 2 {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("both repairs did not reach the download barrier")
		}
	}
	requireGenerationInput(t, held, "held input")
	close(release)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent repairs returned %v and %v", first.err, second.err)
	}
	for _, bundle := range []outbound.OfficialTestCaseBundle{held, first.bundle, second.bundle} {
		requireGenerationInput(t, bundle, "held input")
	}
	if first.bundle.TestCases[0].SandboxInputPath == second.bundle.TestCases[0].SandboxInputPath {
		t.Fatal("concurrent cache fills shared a generation directory")
	}
}

func requireGenerationInput(t *testing.T, bundle outbound.OfficialTestCaseBundle, want string) {
	t.Helper()
	got, err := os.ReadFile(bundle.TestCases[0].SandboxInputPath)
	if err != nil || string(got) != want {
		t.Fatalf("generation input = %q, %v, want %q", got, err, want)
	}
}

func TestOfficialLoaderRejectsMismatchedPairsAsNonRetryable(t *testing.T) {
	t.Parallel()

	zipBytes := buildZip(t, map[string]string{
		"001.in": "1\n",
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(zipBytes)
	}))
	t.Cleanup(server.Close)

	loader := NewOfficialLoader(zap.NewNop())
	loader.cacheBaseDir = t.TempDir()

	_, err := loader.Load(context.Background(), outbound.ProblemTestCaseMetadata{
		ProblemID:      42,
		ZipDownloadURL: server.URL,
		TestCount:      1,
		Version:        1,
	})
	if err == nil {
		t.Fatal("Load() error = nil")
	}
	if !workerdomain.IsNonRetryable(err) {
		t.Fatalf("IsNonRetryable(%v) = false, want true", err)
	}
}

func buildZip(t *testing.T, files map[string]string) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry: %v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("write zip entry: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}
