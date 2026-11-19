//go:build integration

package execute

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go-judge-system/pkg/config"
	"go-judge-system/pkg/gojudge"
	sharedgrpc "go-judge-system/pkg/grpc"
	"go-judge-system/workers/judge/internal/application/port/outbound"

	judgepb "github.com/criyle/go-judge/pb"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
)

const (
	judgeCoreCapacityBenchmarkName = "judge_core_capacity"
	judgeCoreCapacityWorkload      = "cpp_missing_number_like_14_cases"
)

// TestGoJudgeCoreCapacity is an opt-in, closed-loop saturation benchmark. It
// intentionally compiles just once before every timing window, then measures
// only the production GoJudgeClient.runBatch orchestration for the 14-case
// official-shaped workload. It is not an API, Kafka, or pipeline benchmark.
//
// Build a runnable test binary with:
//
//	cd workers/judge && go test -c -tags=integration -o /tmp/astracode-judge-core-bench.test ./internal/adapter/outbound/execute
func TestGoJudgeCoreCapacity(t *testing.T) {
	benchmarkConfig := judgeCoreCapacityLoadConfig(t)
	runID := judgeCoreCapacityRunID(t)
	resultsDir := filepath.Join(benchmarkConfig.ResultsRoot, runID)
	if err := os.MkdirAll(resultsDir, 0o700); err != nil {
		t.Fatalf("create benchmark results directory: %v", err)
	}

	conn, err := sharedgrpc.NewClientConn(benchmarkConfig.GRPCAddress, sharedgrpc.WithInsecureTransport())
	if err != nil {
		t.Fatalf("create persistent sandbox gRPC connection: %v", err)
	}
	defer func() { _ = conn.Close() }()

	rpc := &judgeCoreCapacityRPC{ExecutorClient: judgepb.NewExecutorClient(conn), ownedFileIDs: make(map[string]struct{})}
	client := NewGoJudgeClient(rpc, zap.NewNop(), judgeCoreCapacityCacheConfig())
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), judgeCoreCapacityOuterTimeout(benchmarkConfig))
	defer cancel()
	resources := newJudgeCoreResourceSampler(benchmarkConfig.SandboxContainer)
	resources.Start(ctx)

	limits := normalizeLimits(outbound.ExecutionLimits{TimeLimitMS: 2_000, MemoryLimitKB: 256 * 1024, OutputLimitBytes: 1024 * 1024})
	langCfg, ok := gojudge.GetLanguageConfig("CPP", gojudge.GetSourceFileName("CPP"), gojudge.GetExeFileName("CPP"))
	if !ok || langCfg.Compile == nil {
		t.Fatal("CPP compiler configuration is unavailable")
	}
	testCases := judgeCoreCapacityTestCases()
	identity := judgeCoreCapacityDatasetIdentity(runID)

	compileStarted := time.Now()
	compileResult, executableFileID, err := client.compile(ctx, "CPP", judgeCoreCapacitySource, langCfg, limits)
	compileDuration := time.Since(compileStarted)
	if err != nil {
		t.Fatalf("compile benchmark source: %v", err)
	}
	if compileResult != nil || executableFileID == "" {
		t.Fatalf("compile benchmark source result/file ID = %#v/%q", compileResult, executableFileID)
	}
	cleanupComplete := false
	defer func() {
		if !cleanupComplete {
			judgeCoreCapacityCleanup(t, rpc, client, executableFileID)
		}
	}()

	cacheStarted := time.Now()
	cacheBefore := rpc.snapshotFileAdds()
	cacheBindings := make([]testcaseCacheBinding, 0, len(testCases))
	for _, testCase := range testCases {
		binding, cached, addErr := client.testcaseCache.getOrAdd(ctx, identity, testCase)
		if addErr != nil || !cached {
			t.Fatalf("populate hot testcase cache for testcase %q: cached=%v err=%v", testCase.ID, cached, addErr)
		}
		cacheBindings = append(cacheBindings, binding)
	}
	client.testcaseCache.release(cacheBindings)
	cachePopulationDuration := time.Since(cacheStarted)
	cacheAfter := rpc.snapshotFileAdds()
	if got, want := cacheAfter.Calls-cacheBefore.Calls, int64(len(testCases)); got != want {
		t.Fatalf("cold cache FileAdd calls=%d, want %d", got, want)
	}

	records := make([]judgeCoreCapacityRecord, 0)
	measurementStarted := false
	defer func() {
		summary := judgeCoreCapacityMakeSummary(benchmarkConfig, runID, compileDuration, cachePopulationDuration, cacheAfter.Calls-cacheBefore.Calls, cacheAfter.Bytes-cacheBefore.Bytes, records, resources.Samples())
		if writeErr := judgeCoreWriteArtifacts(resultsDir, summary, judgeCoreCapacityReport(summary), records, resources.Samples()); writeErr != nil {
			t.Errorf("preserve benchmark artifacts: %v", writeErr)
		}
		if measurementStarted {
			t.Logf("Judge Core artifacts preserved at %s", resultsDir)
		}
	}()
	// Register this after the artifact writer so sampling has stopped before
	// the final resources.csv and summary.json are written.
	defer resources.Stop()

	for _, concurrency := range benchmarkConfig.Concurrency {
		// Warmup is outside all measured intervals. Five full submissions per
		// level warms executor/process state without changing closed-loop load.
		for sequence := 1; sequence <= benchmarkConfig.Warmup; sequence++ {
			warmup, runErr := judgeCoreCapacityRunSubmission(ctx, client, langCfg, limits, executableFileID, identity, testCases, sequence)
			if runErr != nil || !warmup.Correct {
				t.Fatalf("concurrency %d warmup %d: result=%+v err=%v", concurrency, sequence, warmup, runErr)
			}
			if warmup.FileAddCalls != 0 {
				t.Fatalf("concurrency %d warmup %d unexpectedly repopulated testcase cache", concurrency, sequence)
			}
		}

		for repetition := 1; repetition <= benchmarkConfig.Repetitions; repetition++ {
			measurementStarted = true
			repetitionRecords := judgeCoreCapacityMeasureClosedLoop(ctx, client, langCfg, limits, executableFileID, identity, testCases, runID, concurrency, repetition, benchmarkConfig.Duration, rpc)
			records = append(records, repetitionRecords...)
			for _, record := range repetitionRecords {
				if record.FileAddCalls != 0 {
					t.Fatalf("hot cache invalid at concurrency %d repetition %d sequence %d: FileAdd calls=%d", concurrency, repetition, record.Sequence, record.FileAddCalls)
				}
				if record.TransportError != "" || record.MalformedResponse || !record.Correct {
					t.Fatalf("invalid Judge Core execution at concurrency %d repetition %d sequence %d: verdict=%s malformed=%v error=%q", concurrency, repetition, record.Sequence, record.Verdict, record.MalformedResponse, record.TransportError)
				}
			}
			// Persist after every repetition, not only at successful benchmark end.
			summary := judgeCoreCapacityMakeSummary(benchmarkConfig, runID, compileDuration, cachePopulationDuration, cacheAfter.Calls-cacheBefore.Calls, cacheAfter.Bytes-cacheBefore.Bytes, records, resources.Samples())
			if writeErr := judgeCoreWriteArtifacts(resultsDir, summary, judgeCoreCapacityReport(summary), records, resources.Samples()); writeErr != nil {
				t.Fatalf("write repetition artifacts: %v", writeErr)
			}
		}
	}

	// Only the benchmark's own FileAdd responses are removed. The executable
	// is one benchmark-scoped CopyOutCached artifact and is never confused with
	// testcase-cache FileIDs.
	judgeCoreCapacityCleanup(t, rpc, client, executableFileID)
	cleanupComplete = true
}

type judgeCoreCapacityConfig struct {
	GRPCAddress      string
	ResultsRoot      string
	Release          string
	Concurrency      []int
	Warmup           int
	Duration         time.Duration
	Repetitions      int
	SandboxContainer string
}

func judgeCoreCapacityLoadConfig(t *testing.T) judgeCoreCapacityConfig {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("ASTRACODE_JUDGE_CORE_GRPC_ADDR"))
	root := strings.TrimSpace(os.Getenv("ASTRACODE_JUDGE_CORE_RESULTS_DIR"))
	if address == "" || root == "" {
		t.Skip("set ASTRACODE_JUDGE_CORE_GRPC_ADDR and ASTRACODE_JUDGE_CORE_RESULTS_DIR to run the opt-in Judge Core capacity benchmark")
	}
	concurrency, err := judgeCoreCapacityParseConcurrency(envOrDefault("ASTRACODE_JUDGE_CORE_CONCURRENCY", "1,2,4,8"))
	if err != nil {
		t.Fatalf("ASTRACODE_JUDGE_CORE_CONCURRENCY: %v", err)
	}
	duration, err := time.ParseDuration(envOrDefault("ASTRACODE_JUDGE_CORE_DURATION", "20s"))
	if err != nil || duration <= 0 || duration > 5*time.Minute {
		t.Fatalf("ASTRACODE_JUDGE_CORE_DURATION must be >0 and <=5m: %v", err)
	}
	warmup, err := judgeCoreCapacityParsePositiveInt("ASTRACODE_JUDGE_CORE_WARMUP", 5, 100)
	if err != nil {
		t.Fatal(err)
	}
	repetitions, err := judgeCoreCapacityParsePositiveInt("ASTRACODE_JUDGE_CORE_REPETITIONS", 2, 20)
	if err != nil {
		t.Fatal(err)
	}
	return judgeCoreCapacityConfig{GRPCAddress: address, ResultsRoot: root, Release: envOrDefault("ASTRACODE_JUDGE_CORE_RELEASE", "v0.1.10"), Concurrency: concurrency, Warmup: warmup, Duration: duration, Repetitions: repetitions, SandboxContainer: strings.TrimSpace(os.Getenv("ASTRACODE_JUDGE_CORE_SANDBOX_CONTAINER"))}
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func judgeCoreCapacityParsePositiveInt(name string, fallback, maximum int) (int, error) {
	value := envOrDefault(name, strconv.Itoa(fallback))
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 || parsed > maximum {
		return 0, fmt.Errorf("%s must be an integer in [1,%d]", name, maximum)
	}
	return parsed, nil
}

func judgeCoreCapacityParseConcurrency(value string) ([]int, error) {
	seen := map[int]struct{}{}
	var parsed []int
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		concurrency, err := strconv.Atoi(item)
		if err != nil || concurrency <= 0 || concurrency > 64 {
			return nil, fmt.Errorf("invalid concurrency %q; each level must be in [1,64]", item)
		}
		if _, duplicate := seen[concurrency]; duplicate {
			return nil, fmt.Errorf("duplicate concurrency %d", concurrency)
		}
		seen[concurrency] = struct{}{}
		parsed = append(parsed, concurrency)
	}
	if len(parsed) == 0 {
		return nil, fmt.Errorf("no concurrency levels")
	}
	sort.Ints(parsed)
	return parsed, nil
}

func judgeCoreCapacityOuterTimeout(cfg judgeCoreCapacityConfig) time.Duration {
	// Bounded protection for a manually invoked test binary. It leaves two
	// minutes for compile, cache setup, cleanup, and last in-flight batches.
	return cfg.Duration*time.Duration(len(cfg.Concurrency)*cfg.Repetitions) + 2*time.Minute
}

func judgeCoreCapacityRunID(t *testing.T) string {
	t.Helper()
	var nonce [8]byte
	if _, err := cryptorand.Read(nonce[:]); err != nil {
		t.Fatalf("create benchmark run ID: %v", err)
	}
	return fmt.Sprintf("judge-core-capacity-%s-%s", time.Now().UTC().Format("20060102T150405Z"), hex.EncodeToString(nonce[:]))
}

func judgeCoreCapacityCacheConfig() config.TestcaseCacheConfig {
	return config.TestcaseCacheConfig{Enabled: true, MaxBytes: 25_165_824, MaxEntries: 256, IdleTTL: 10 * time.Minute, CleanupInterval: 30 * time.Second}
}

type judgeCoreFileAddSnapshot struct{ Calls, Bytes int64 }

type judgeCoreCapacityRPC struct {
	judgepb.ExecutorClient
	fileAddCalls atomic.Int64
	fileAddBytes atomic.Int64
	mu           sync.Mutex
	ownedFileIDs map[string]struct{}
}

func (r *judgeCoreCapacityRPC) FileAdd(ctx context.Context, file *judgepb.FileContent, opts ...grpc.CallOption) (*judgepb.FileID, error) {
	r.fileAddCalls.Add(1)
	r.fileAddBytes.Add(int64(len(file.GetContent())))
	response, err := r.ExecutorClient.FileAdd(ctx, file, opts...)
	if err == nil && response != nil && response.GetFileID() != "" {
		r.mu.Lock()
		r.ownedFileIDs[response.GetFileID()] = struct{}{}
		r.mu.Unlock()
	}
	return response, err
}

func (r *judgeCoreCapacityRPC) snapshotFileAdds() judgeCoreFileAddSnapshot {
	return judgeCoreFileAddSnapshot{Calls: r.fileAddCalls.Load(), Bytes: r.fileAddBytes.Load()}
}

func (r *judgeCoreCapacityRPC) ownedFiles() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.ownedFileIDs))
	for id := range r.ownedFileIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func judgeCoreCapacityDatasetIdentity(runID string) *outbound.TestcaseDatasetIdentity {
	checksum := sha256.Sum256([]byte("astracode-judge-core-capacity-v1:" + runID))
	return &outbound.TestcaseDatasetIdentity{ProblemID: 9_000_000_001, Version: 1, DatasetChecksum: hex.EncodeToString(checksum[:])}
}

func judgeCoreCapacityMeasureClosedLoop(ctx context.Context, client *GoJudgeClient, langCfg *gojudge.LanguageConfig, limits outbound.ExecutionLimits, executableFileID string, identity *outbound.TestcaseDatasetIdentity, testCases []outbound.ExecutionTestCase, runID string, concurrency, repetition int, duration time.Duration, rpc *judgeCoreCapacityRPC) []judgeCoreCapacityRecord {
	start := make(chan struct{})
	var deadline time.Time
	var ready sync.WaitGroup
	ready.Add(concurrency)
	var sequence atomic.Int64
	var workers sync.WaitGroup
	workerRecords := make(chan []judgeCoreCapacityRecord, concurrency)
	for worker := 0; worker < concurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ready.Done()
			<-start
			local := make([]judgeCoreCapacityRecord, 0)
			for time.Now().Before(deadline) {
				current := int(sequence.Add(1))
				before := rpc.snapshotFileAdds()
				record, err := judgeCoreCapacityRunSubmission(ctx, client, langCfg, limits, executableFileID, identity, testCases, current)
				after := rpc.snapshotFileAdds()
				record.RunID, record.Concurrency, record.Repetition, record.Sequence = runID, concurrency, repetition, current
				record.FileAddCalls, record.FileAddBytes = after.Calls-before.Calls, after.Bytes-before.Bytes
				record.InMeasurementWindow = !record.FinishedUTC.After(deadline)
				if err != nil {
					record.TransportError = err.Error()
				}
				local = append(local, record)
				if err != nil || !record.Correct {
					break
				}
			}
			workerRecords <- local
		}()
	}
	ready.Wait()
	deadline = time.Now().Add(duration)
	close(start)
	workers.Wait()
	close(workerRecords)
	var records []judgeCoreCapacityRecord
	for worker := range workerRecords {
		records = append(records, worker...)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Sequence < records[j].Sequence })
	return records
}

func judgeCoreCapacityRunSubmission(ctx context.Context, client *GoJudgeClient, langCfg *gojudge.LanguageConfig, limits outbound.ExecutionLimits, executableFileID string, identity *outbound.TestcaseDatasetIdentity, testCases []outbound.ExecutionTestCase, sequence int) (judgeCoreCapacityRecord, error) {
	started := time.Now()
	record := judgeCoreCapacityRecord{StartedUTC: started.UTC(), Verdict: "ACCEPTED"}
	for start, batchIndex := 0, 0; start < len(testCases); start, batchIndex = start+officialBatchSize, batchIndex+1 {
		end := min(start+officialBatchSize, len(testCases))
		batch := testCases[start:end]
		results, err := client.runBatch(ctx, "CPP", judgeCoreCapacitySource, langCfg, limits, true, executableFileID, identity, batch, sequence*10+batchIndex)
		record.BatchCount++
		record.TestcaseResultCount += len(results)
		if err != nil {
			record.FinishedUTC, record.JudgeCoreWall = time.Now().UTC(), time.Since(started)
			return record, err
		}
		if len(results) != len(batch) {
			record.MalformedResponse = true
			record.FinishedUTC, record.JudgeCoreWall = time.Now().UTC(), time.Since(started)
			return record, fmt.Errorf("batch %d returned %d results, want %d", batchIndex, len(results), len(batch))
		}
		for index, raw := range results {
			if raw == nil {
				record.MalformedResponse = true
				record.FinishedUTC, record.JudgeCoreWall = time.Now().UTC(), time.Since(started)
				return record, fmt.Errorf("batch %d result %d is nil", batchIndex, index)
			}
			mapped := mapTestCaseResult("CPP", batch[index], raw, true)
			if mapped.Status != "ACCEPTED" || mapped.ActualOutput == nil || batch[index].ExpectedOutput == nil || *mapped.ActualOutput != *batch[index].ExpectedOutput {
				record.Verdict = mapped.Status
				record.FinishedUTC, record.JudgeCoreWall = time.Now().UTC(), time.Since(started)
				return record, nil
			}
		}
	}
	record.Correct = record.BatchCount == 4 && record.TestcaseResultCount == len(testCases)
	record.FinishedUTC, record.JudgeCoreWall = time.Now().UTC(), time.Since(started)
	return record, nil
}

func judgeCoreCapacityCleanup(t *testing.T, rpc *judgeCoreCapacityRPC, client *GoJudgeClient, executableFileID string) {
	t.Helper()
	client.cleanupExecutableFile(executableFileID)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, fileID := range rpc.ownedFiles() {
		if _, err := rpc.FileDelete(ctx, &judgepb.FileID{FileID: fileID}); err != nil {
			t.Errorf("delete benchmark-owned testcase FileID %q: %v", fileID, err)
		}
	}
	files, err := rpc.FileList(ctx, &emptypb.Empty{})
	if err != nil {
		t.Errorf("verify benchmark cleanup with FileList: %v", err)
		return
	}
	if _, present := files.GetFileIDs()[executableFileID]; present {
		t.Errorf("benchmark executable FileID %q remained after cleanup", executableFileID)
	}
	for _, fileID := range rpc.ownedFiles() {
		if _, present := files.GetFileIDs()[fileID]; present {
			t.Errorf("benchmark-owned testcase FileID %q remained after cleanup", fileID)
		}
	}
}

const judgeCoreCapacitySource = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n;
    if (!(cin >> n)) return 1;
    long long missing = 0;
    for (int i = 0; i <= n; ++i) missing ^= i;
    for (int i = 0, value; i < n && cin >> value; ++i) missing ^= value;
    cout << missing << '\n';
}`

func judgeCoreCapacityTestCases() []outbound.ExecutionTestCase {
	pairs := []struct{ n, missing int }{{1, 0}, {1, 1}, {2, 1}, {3, 0}, {3, 3}, {5, 2}, {8, 7}, {10, 0}, {16, 8}, {25, 17}, {32, 31}, {64, 13}, {100, 99}, {127, 42}}
	testCases := make([]outbound.ExecutionTestCase, 0, len(pairs))
	for index, pair := range pairs {
		values := make([]string, 0, pair.n)
		for value := 0; value <= pair.n; value++ {
			if value != pair.missing {
				values = append(values, strconv.Itoa(value))
			}
		}
		stdin := fmt.Sprintf("%d\n%s\n", pair.n, strings.Join(values, " "))
		expected := strconv.Itoa(pair.missing) + "\n"
		testCases = append(testCases, outbound.ExecutionTestCase{Index: index + 1, ID: fmt.Sprintf("missing-%02d", index+1), Kind: "official", Stdin: stdin, ExpectedOutput: &expected})
	}
	return testCases
}

type judgeCoreResourceSampler struct {
	container string
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	mu        sync.Mutex
	samples   []judgeCoreResourceSample
}

func newJudgeCoreResourceSampler(container string) *judgeCoreResourceSampler {
	return &judgeCoreResourceSampler{container: strings.TrimSpace(container)}
}
func (s *judgeCoreResourceSampler) Start(parent context.Context) {
	if s.container == "" {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			s.capture(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
func (s *judgeCoreResourceSampler) Stop() {
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.wg.Wait()
}
func (s *judgeCoreResourceSampler) Samples() []judgeCoreResourceSample {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]judgeCoreResourceSample(nil), s.samples...)
}
func (s *judgeCoreResourceSampler) capture(ctx context.Context) {
	sample := judgeCoreResourceSample{TimestampUTC: time.Now().UTC()}
	output, err := exec.CommandContext(ctx, "docker", "stats", "--no-stream", "--format", "{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.PIDs}}", s.container).Output()
	if err != nil && ctx.Err() != nil {
		return
	}
	if err != nil {
		sample.Error = err.Error()
	} else {
		sample.CPUPct, sample.MemoryMiB, sample.MemoryPct, sample.PIDs, sample.Error = judgeCoreParseDockerStats(strings.TrimSpace(string(output)))
	}
	s.mu.Lock()
	s.samples = append(s.samples, sample)
	s.mu.Unlock()
}
func judgeCoreParseDockerStats(value string) (float64, float64, float64, int, string) {
	parts := strings.Split(value, ",")
	if len(parts) != 4 {
		return 0, 0, 0, 0, "unexpected docker stats format"
	}
	cpu, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(parts[0]), "%"), 64)
	if err != nil {
		return 0, 0, 0, 0, err.Error()
	}
	memoryParts := strings.Fields(strings.TrimSpace(parts[1]))
	if len(memoryParts) == 0 {
		return 0, 0, 0, 0, "missing memory usage"
	}
	memory, err := testcaseCacheABParseMemoryMiB(memoryParts[0])
	if err != nil {
		return 0, 0, 0, 0, err.Error()
	}
	memoryPct, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(parts[2]), "%"), 64)
	if err != nil {
		return 0, 0, 0, 0, err.Error()
	}
	pids, err := strconv.Atoi(strings.TrimSpace(parts[3]))
	if err != nil {
		return 0, 0, 0, 0, err.Error()
	}
	return cpu, memory, memoryPct, pids, ""
}

type judgeCoreCapacitySummary struct {
	SchemaVersion         string                   `json:"schema_version"`
	RunID                 string                   `json:"run_id"`
	Benchmark             string                   `json:"benchmark"`
	Release               string                   `json:"release"`
	Hardware              map[string]any           `json:"hardware"`
	Workload              map[string]any           `json:"workload"`
	Setup                 map[string]any           `json:"setup"`
	Levels                []judgeCoreCapacityLevel `json:"levels"`
	Capacity              judgeCoreCapacityResult  `json:"capacity"`
	ProductionConfigured  map[string]any           `json:"production_configured_concurrency"`
	IdealLinearProjection []map[string]any         `json:"ideal_linear_projection_not_demonstrated"`
	Resources             map[string]any           `json:"resource_observation"`
}

func judgeCoreCapacityMakeSummary(cfg judgeCoreCapacityConfig, runID string, compileDuration, cacheDuration time.Duration, fileAdds, bytesUploaded int64, records []judgeCoreCapacityRecord, resources []judgeCoreResourceSample) judgeCoreCapacitySummary {
	levels := make([]judgeCoreCapacityLevel, 0, len(cfg.Concurrency))
	for _, concurrency := range cfg.Concurrency {
		levels = append(levels, judgeCoreCapacityBuildLevel(concurrency, cfg.Duration, records))
	}
	capacity := judgeCoreCapacitySelect(levels)
	productionThroughput := any("N/A — concurrency 2 was not tested")
	for _, level := range levels {
		if level.Concurrency == 2 {
			productionThroughput = level.Aggregate.Throughput.Mean
		}
	}
	projection := make([]map[string]any, 0, 5)
	if capacity.MaximumDemonstratedThroughput > 0 {
		for _, nodes := range []int{1, 2, 4, 8, 16} {
			projection = append(projection, map[string]any{"nodes": nodes, "ideal_linear_projection_submissions_per_sec": float64(nodes) * capacity.MaximumDemonstratedThroughput, "demonstrated": false})
		}
	}
	return judgeCoreCapacitySummary{SchemaVersion: "judge_core_capacity/v1", RunID: runID, Benchmark: judgeCoreCapacityBenchmarkName, Release: cfg.Release,
		Hardware: map[string]any{"declared_judge_node_vcpu": 2, "declared_judge_node_ram_mib": 6945, "worker_pool_size": 2, "sandbox_parallelism": 2, "sandbox_memory_limit_mib": 3072, "sandbox_shm_mib": 64, "go_runtime_num_cpu": runtime.NumCPU()},
		Workload: map[string]any{"name": judgeCoreCapacityWorkload, "language": "CPP", "logical_testcases": 14, "official_batch_size": officialBatchSize, "batch_command_counts": []int{4, 4, 4, 2}, "stop_on_first_failure": true, "transport": "grpc", "testcase_cache": "hot", "compile_excluded": true, "synthetic": true},
		Setup:    map[string]any{"compile_wall_ms": float64(compileDuration) / float64(time.Millisecond), "compile_included_in_judge_core": false, "cache_population_wall_ms": float64(cacheDuration) / float64(time.Millisecond), "cache_population_file_add_calls": fileAdds, "cache_population_bytes_uploaded": bytesUploaded},
		Levels:   levels, Capacity: capacity, ProductionConfigured: map[string]any{"concurrency": 2, "throughput_submissions_per_sec": productionThroughput}, IdealLinearProjection: projection, Resources: judgeCoreResourceSummary(resources, cfg.SandboxContainer)}
}

func judgeCoreResourceSummary(samples []judgeCoreResourceSample, container string) map[string]any {
	if strings.TrimSpace(container) == "" {
		return map[string]any{"available": false, "reason": "ASTRACODE_JUDGE_CORE_SANDBOX_CONTAINER was not set"}
	}
	if len(samples) == 0 {
		return map[string]any{"available": false, "reason": "no docker stats samples were captured"}
	}
	peakCPU, peakMemory, peakMemoryPct := 0.0, 0.0, 0.0
	failures := 0
	for _, sample := range samples {
		peakCPU = math.Max(peakCPU, sample.CPUPct)
		peakMemory = math.Max(peakMemory, sample.MemoryMiB)
		peakMemoryPct = math.Max(peakMemoryPct, sample.MemoryPct)
		if sample.Error != "" {
			failures++
		}
	}
	return map[string]any{"available": failures < len(samples), "container": container, "samples": len(samples), "sample_errors": failures, "peak_cpu_percent": peakCPU, "peak_memory_mib": peakMemory, "peak_memory_percent": peakMemoryPct}
}

func judgeCoreCapacityReport(summary judgeCoreCapacitySummary) string {
	lines := []string{"# AstraCode Judge Core Capacity", "", "This is a closed-loop, compile-excluded Judge Core benchmark. It measures complete logical submissions only from the first production-style testcase batch through completion of the fourth batch; it does not benchmark Submission API, Kafka, databases, SSE, or pipeline terminal observation.", "", "## Tested system", "", fmt.Sprintf("- Release: %s", summary.Release), "- Transport: gRPC via the production GoJudgeClient and persistent ClientConn", "- Workload: synthetic `cpp_missing_number_like_14_cases` (14 accepted C++ cases; official batches 4 + 4 + 4 + 2)", "- Testcase inputs: hot production-style CachedFile path", fmt.Sprintf("- Declared node baseline: %v vCPU, %v MiB RAM; Worker pool %v; sandbox parallelism %v", summary.Hardware["declared_judge_node_vcpu"], summary.Hardware["declared_judge_node_ram_mib"], summary.Hardware["worker_pool_size"], summary.Hardware["sandbox_parallelism"]), "", "## Compile diagnostic", "", fmt.Sprintf("Compile wall: %.3f ms. **NOT INCLUDED IN JUDGE CORE latency or throughput.**", summary.Setup["compile_wall_ms"]), fmt.Sprintf("Cold testcase-cache population: %.3f ms, %v FileAdd calls, %v bytes. This setup is also excluded.", summary.Setup["cache_population_wall_ms"], summary.Setup["cache_population_file_add_calls"], summary.Setup["cache_population_bytes_uploaded"]), "", "## Capacity curve", "", "| Concurrency | Throughput sub/s (mean) | p50 | p95 | p99 | Errors | Hot FileAdd |", "|---:|---:|---:|---:|---:|---:|---:|"}
	for _, level := range summary.Levels {
		lines = append(lines, fmt.Sprintf("| %d | %.3f | %.3f ms | %.3f ms | %.3f ms | %d | %d |", level.Concurrency, level.Aggregate.Throughput.Mean, level.Aggregate.Latency.P50, level.Aggregate.Latency.P95, level.Aggregate.Latency.P99, level.Aggregate.Incorrect+level.Aggregate.TransportErrors+level.Aggregate.Malformed, level.Aggregate.HotFileAddCalls))
	}
	lines = append(lines, "", "## Maximum demonstrated", "", fmt.Sprintf("Maximum demonstrated Judge Core throughput: %.3f submissions/s at concurrency %d.", summary.Capacity.MaximumDemonstratedThroughput, summary.Capacity.AtConcurrency), fmt.Sprintf("Judge Core latency at that point: p95 %.3f ms; p99 %.3f ms.", summary.Capacity.P95JudgeCoreLatencyMS, summary.Capacity.P99JudgeCoreLatencyMS), fmt.Sprintf("Classification: `%s` — %s", summary.Capacity.Classification, summary.Capacity.Reason), fmt.Sprintf("Production configured concurrency=2 throughput: %v submissions/s.", summary.ProductionConfigured["throughput_submissions_per_sec"]), "", "## Ideal scale projection", "", "**IDEAL LINEAR PROJECTION — NOT DEMONSTRATED.** Actual multi-node capacity can be lower because of Kafka partitions/brokers, networking, scheduling, shared services, CPU topology, testcase distribution, cache behavior, and coordination.", "", "| Nodes | Ideal linear projection sub/s |", "|---:|---:|")
	for _, row := range summary.IdealLinearProjection {
		lines = append(lines, fmt.Sprintf("| %v | %.3f |", row["nodes"], row["ideal_linear_projection_submissions_per_sec"]))
	}
	lines = append(lines, "", "## Correctness / quality", "", "Only complete 14-result ACCEPTED submissions inside each measured wall-clock window contribute to throughput. Any transport error, malformed response, incorrect result, or unexpected hot FileAdd invalidates that level as sustainable capacity evidence. Benchmark-owned executable and testcase-cache FileIDs are explicitly cleaned; unrelated executorserver files are never deleted.", "", "## CV-safe wording", "")
	if summary.Capacity.MaximumDemonstratedThroughput > 0 {
		best := judgeCoreCapacityFindLevel(summary.Levels, summary.Capacity.AtConcurrency)
		lines = append(lines, fmt.Sprintf("Benchmarked AstraCode's compile-excluded Judge Core at %.3f submissions/s on a single declared 2-vCPU Judge node for a synthetic 14-testcase C++ workload, with %.3f ms p95 execution latency.", summary.Capacity.MaximumDemonstratedThroughput, best.Aggregate.Latency.P95), fmt.Sprintf("Ideal horizontal scaling projection is approximately N× %.3f submissions/s single-node Judge Core capacity before shared-system bottlenecks; multi-node capacity was not directly benchmarked.", summary.Capacity.MaximumDemonstratedThroughput))
	} else {
		lines = append(lines, "No capacity wording is populated until a valid benchmark run completes.")
	}
	return strings.Join(lines, "\n") + "\n"
}

func judgeCoreCapacityFindLevel(levels []judgeCoreCapacityLevel, concurrency int) judgeCoreCapacityLevel {
	for _, level := range levels {
		if level.Concurrency == concurrency {
			return level
		}
	}
	return judgeCoreCapacityLevel{}
}
