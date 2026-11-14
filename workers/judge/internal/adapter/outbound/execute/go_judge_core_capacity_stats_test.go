package execute

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// judgeCoreCapacityRecord is deliberately test-only. A record is one complete
// logical submission after compilation has already succeeded.
type judgeCoreCapacityRecord struct {
	RunID               string
	Concurrency         int
	Repetition          int
	Sequence            int
	StartedUTC          time.Time
	FinishedUTC         time.Time
	JudgeCoreWall       time.Duration
	BatchCount          int
	TestcaseResultCount int
	Verdict             string
	Correct             bool
	InMeasurementWindow bool
	TransportError      string
	MalformedResponse   bool
	FileAddCalls        int64
	FileAddBytes        int64
}

type judgeCoreResourceSample struct {
	TimestampUTC time.Time
	CPUPct       float64
	MemoryMiB    float64
	MemoryPct    float64
	PIDs         int
	Error        string
}

type judgeCoreLatencyStats struct {
	Min    float64 `json:"min"`
	Mean   float64 `json:"mean"`
	StdDev float64 `json:"stddev"`
	CV     float64 `json:"cv"`
	P50    float64 `json:"p50"`
	P90    float64 `json:"p90"`
	P95    float64 `json:"p95"`
	P99    float64 `json:"p99"`
	Max    float64 `json:"max"`
}

type judgeCoreThroughputStats struct {
	Values []float64   `json:"repetitions_submissions_per_sec"`
	Mean   float64     `json:"mean"`
	StdDev float64     `json:"stddev"`
	CV     float64     `json:"cv"`
	CI95   *[2]float64 `json:"student_t_95_ci,omitempty"`
}

type judgeCoreCapacityRepetition struct {
	Repetition      int     `json:"repetition"`
	WindowWallMS    float64 `json:"measurement_window_wall_ms"`
	Attempted       int     `json:"attempted_logical_submissions"`
	Completed       int     `json:"completed_successfully"`
	Incorrect       int     `json:"incorrect"`
	TransportErrors int     `json:"transport_errors"`
	Malformed       int     `json:"malformed_responses"`
	HotFileAddCalls int64   `json:"hot_file_add_calls"`
	Throughput      float64 `json:"throughput_submissions_per_sec"`
}

type judgeCoreCapacityLevel struct {
	Concurrency int                             `json:"concurrency"`
	Repetitions []judgeCoreCapacityRepetition   `json:"repetitions"`
	Aggregate   judgeCoreCapacityLevelAggregate `json:"aggregate"`
}

type judgeCoreCapacityLevelAggregate struct {
	Attempted       int                      `json:"attempted_logical_submissions"`
	Completed       int                      `json:"completed_successfully"`
	Incorrect       int                      `json:"incorrect"`
	TransportErrors int                      `json:"transport_errors"`
	Malformed       int                      `json:"malformed_responses"`
	HotFileAddCalls int64                    `json:"hot_file_add_calls"`
	ErrorFree       bool                     `json:"error_free"`
	HotCacheValid   bool                     `json:"hot_cache_valid"`
	Throughput      judgeCoreThroughputStats `json:"throughput_submissions_per_sec"`
	Latency         judgeCoreLatencyStats    `json:"judge_core_wall_ms"`
}

type judgeCoreCapacityResult struct {
	MaximumDemonstratedThroughput float64 `json:"maximum_demonstrated_throughput_submissions_per_sec,omitempty"`
	AtConcurrency                 int     `json:"at_concurrency,omitempty"`
	P95JudgeCoreLatencyMS         float64 `json:"p95_judge_core_latency_ms_at_max,omitempty"`
	P99JudgeCoreLatencyMS         float64 `json:"p99_judge_core_latency_ms_at_max,omitempty"`
	SaturationConcurrency         *int    `json:"saturation_concurrency,omitempty"`
	Classification                string  `json:"classification"`
	Reason                        string  `json:"reason"`
}

func judgeCoreCapacityBuildLevel(concurrency int, duration time.Duration, records []judgeCoreCapacityRecord) judgeCoreCapacityLevel {
	byRep := map[int][]judgeCoreCapacityRecord{}
	for _, record := range records {
		if record.Concurrency == concurrency {
			byRep[record.Repetition] = append(byRep[record.Repetition], record)
		}
	}
	repetitions := make([]int, 0, len(byRep))
	for repetition := range byRep {
		repetitions = append(repetitions, repetition)
	}
	sort.Ints(repetitions)
	level := judgeCoreCapacityLevel{Concurrency: concurrency}
	latencies := make([]float64, 0)
	throughputs := make([]float64, 0, len(repetitions))
	for _, repetition := range repetitions {
		rep := judgeCoreCapacityRepetition{Repetition: repetition, WindowWallMS: float64(duration) / float64(time.Millisecond)}
		for _, record := range byRep[repetition] {
			if !record.InMeasurementWindow {
				continue
			}
			rep.Attempted++
			rep.HotFileAddCalls += record.FileAddCalls
			if record.TransportError != "" {
				rep.TransportErrors++
				continue
			}
			if record.MalformedResponse {
				rep.Malformed++
				continue
			}
			if !record.Correct || record.Verdict != "ACCEPTED" {
				rep.Incorrect++
				continue
			}
			rep.Completed++
			latencies = append(latencies, float64(record.JudgeCoreWall)/float64(time.Millisecond))
		}
		if duration > 0 {
			rep.Throughput = float64(rep.Completed) / duration.Seconds()
		}
		level.Repetitions = append(level.Repetitions, rep)
		throughputs = append(throughputs, rep.Throughput)
		level.Aggregate.Attempted += rep.Attempted
		level.Aggregate.Completed += rep.Completed
		level.Aggregate.Incorrect += rep.Incorrect
		level.Aggregate.TransportErrors += rep.TransportErrors
		level.Aggregate.Malformed += rep.Malformed
		level.Aggregate.HotFileAddCalls += rep.HotFileAddCalls
	}
	level.Aggregate.ErrorFree = level.Aggregate.Incorrect == 0 && level.Aggregate.TransportErrors == 0 && level.Aggregate.Malformed == 0
	level.Aggregate.HotCacheValid = level.Aggregate.HotFileAddCalls == 0
	level.Aggregate.Throughput = judgeCoreThroughputSummary(throughputs)
	level.Aggregate.Latency = judgeCoreLatencySummary(latencies)
	return level
}

func judgeCoreCapacitySelect(levels []judgeCoreCapacityLevel) judgeCoreCapacityResult {
	if len(levels) == 0 {
		return judgeCoreCapacityResult{Classification: "INVALID", Reason: "no concurrency levels were measured"}
	}
	valid := make([]judgeCoreCapacityLevel, 0, len(levels))
	for _, level := range levels {
		if level.Aggregate.ErrorFree && level.Aggregate.HotCacheValid && level.Aggregate.Completed > 0 {
			valid = append(valid, level)
		}
	}
	if len(valid) == 0 {
		return judgeCoreCapacityResult{Classification: "INVALID", Reason: "no error-free hot-cache level completed a logical submission"}
	}
	best := valid[0]
	for _, level := range valid[1:] {
		if level.Aggregate.Throughput.Mean > best.Aggregate.Throughput.Mean {
			best = level
		}
	}
	result := judgeCoreCapacityResult{MaximumDemonstratedThroughput: best.Aggregate.Throughput.Mean, AtConcurrency: best.Concurrency, P95JudgeCoreLatencyMS: best.Aggregate.Latency.P95, P99JudgeCoreLatencyMS: best.Aggregate.Latency.P99, Classification: "MAX_TESTED_NO_SATURATION", Reason: "highest error-free hot-cache observed throughput among tested levels; no qualifying plateau/degradation was observed"}
	// A saturation claim needs a plateau/decrease plus a material queueing
	// signal. This deliberately does not claim a hardware maximum from merely
	// testing a high concurrency level.
	ordered := append([]judgeCoreCapacityLevel(nil), valid...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Concurrency < ordered[j].Concurrency })
	for index := 1; index < len(ordered); index++ {
		previous, current := ordered[index-1], ordered[index]
		if previous.Aggregate.Throughput.Mean == 0 {
			continue
		}
		improvement := (current.Aggregate.Throughput.Mean - previous.Aggregate.Throughput.Mean) / previous.Aggregate.Throughput.Mean
		latencyRaised := current.Aggregate.Latency.P95 >= previous.Aggregate.Latency.P95*1.20
		if improvement <= 0 || (improvement < 0.05 && latencyRaised) {
			concurrency := previous.Concurrency
			result.SaturationConcurrency = &concurrency
			result.Classification = "SATURATION_DEMONSTRATED"
			result.Reason = fmt.Sprintf("concurrency %d to %d changed throughput by %.2f%% while p95 latency moved from %.3f ms to %.3f ms", previous.Concurrency, current.Concurrency, improvement*100, previous.Aggregate.Latency.P95, current.Aggregate.Latency.P95)
			break
		}
	}
	return result
}

func judgeCoreThroughputSummary(values []float64) judgeCoreThroughputStats {
	stats := judgeCoreThroughputStats{Values: append([]float64(nil), values...)}
	stats.Mean, stats.StdDev, stats.CV = judgeCoreMeanStdCV(values)
	if len(values) >= 2 {
		critical := judgeCoreStudentT95(len(values) - 1)
		margin := critical * stats.StdDev / math.Sqrt(float64(len(values)))
		stats.CI95 = &[2]float64{stats.Mean - margin, stats.Mean + margin}
	}
	return stats
}

func judgeCoreLatencySummary(values []float64) judgeCoreLatencyStats {
	if len(values) == 0 {
		return judgeCoreLatencyStats{}
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mean, stddev, cv := judgeCoreMeanStdCV(sorted)
	return judgeCoreLatencyStats{Min: sorted[0], Mean: mean, StdDev: stddev, CV: cv, P50: judgeCoreQuantile(sorted, .50), P90: judgeCoreQuantile(sorted, .90), P95: judgeCoreQuantile(sorted, .95), P99: judgeCoreQuantile(sorted, .99), Max: sorted[len(sorted)-1]}
}

func judgeCoreMeanStdCV(values []float64) (float64, float64, float64) {
	if len(values) == 0 {
		return 0, 0, 0
	}
	mean := 0.0
	for _, value := range values {
		mean += value
	}
	mean /= float64(len(values))
	if len(values) == 1 {
		return mean, 0, 0
	}
	variance := 0.0
	for _, value := range values {
		delta := value - mean
		variance += delta * delta
	}
	stddev := math.Sqrt(variance / float64(len(values)-1))
	if mean == 0 {
		return mean, stddev, 0
	}
	return mean, stddev, stddev / mean
}

func judgeCoreQuantile(sorted []float64, percentile float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	if len(sorted) == 1 {
		return sorted[0]
	}
	position := percentile * float64(len(sorted)-1)
	lower := int(math.Floor(position))
	upper := int(math.Ceil(position))
	if lower == upper {
		return sorted[lower]
	}
	return sorted[lower] + (sorted[upper]-sorted[lower])*(position-float64(lower))
}

func judgeCoreStudentT95(df int) float64 {
	values := []float64{0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045}
	if df > 0 && df < len(values) {
		return values[df]
	}
	return 1.960
}

func judgeCoreWriteArtifacts(dir string, summary any, report string, records []judgeCoreCapacityRecord, resources []judgeCoreResourceSample) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := judgeCoreWriteRawCSV(filepath.Join(dir, "raw.csv"), records); err != nil {
		return err
	}
	if err := judgeCoreWriteResourcesCSV(filepath.Join(dir, "resources.csv"), resources); err != nil {
		return err
	}
	body, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "summary.json"), append(body, '\n'), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "report.md"), []byte(report), 0o600)
}

func judgeCoreWriteRawCSV(path string, records []judgeCoreCapacityRecord) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	writer := csv.NewWriter(file)
	if err := writer.Write([]string{"run_id", "concurrency", "repetition", "sequence", "started_utc", "finished_utc", "judge_core_wall_ns", "batch_count", "testcase_result_count", "verdict", "correct", "in_measurement_window", "transport_error", "malformed_response", "file_add_calls", "file_add_bytes"}); err != nil {
		return err
	}
	for _, record := range records {
		if err := writer.Write([]string{record.RunID, strconv.Itoa(record.Concurrency), strconv.Itoa(record.Repetition), strconv.Itoa(record.Sequence), record.StartedUTC.Format(time.RFC3339Nano), record.FinishedUTC.Format(time.RFC3339Nano), strconv.FormatInt(record.JudgeCoreWall.Nanoseconds(), 10), strconv.Itoa(record.BatchCount), strconv.Itoa(record.TestcaseResultCount), record.Verdict, strconv.FormatBool(record.Correct), strconv.FormatBool(record.InMeasurementWindow), record.TransportError, strconv.FormatBool(record.MalformedResponse), strconv.FormatInt(record.FileAddCalls, 10), strconv.FormatInt(record.FileAddBytes, 10)}); err != nil {
			return err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	return file.Sync()
}

func judgeCoreWriteResourcesCSV(path string, resources []judgeCoreResourceSample) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	writer := csv.NewWriter(file)
	if err := writer.Write([]string{"timestamp_utc", "cpu_percent", "memory_mib", "memory_percent", "pids", "error"}); err != nil {
		return err
	}
	for _, sample := range resources {
		if err := writer.Write([]string{sample.TimestampUTC.Format(time.RFC3339Nano), fmt.Sprintf("%.3f", sample.CPUPct), fmt.Sprintf("%.3f", sample.MemoryMiB), fmt.Sprintf("%.3f", sample.MemoryPct), strconv.Itoa(sample.PIDs), sample.Error}); err != nil {
			return err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	return file.Sync()
}

func TestJudgeCoreCapacityStatsCompileIsExcludedAndThroughputIsObserved(t *testing.T) {
	records := []judgeCoreCapacityRecord{
		{Concurrency: 2, Repetition: 1, InMeasurementWindow: true, Correct: true, Verdict: "ACCEPTED", JudgeCoreWall: 100 * time.Millisecond},
		{Concurrency: 2, Repetition: 1, InMeasurementWindow: true, Correct: true, Verdict: "ACCEPTED", JudgeCoreWall: 200 * time.Millisecond},
		{Concurrency: 2, Repetition: 2, InMeasurementWindow: true, Correct: true, Verdict: "ACCEPTED", JudgeCoreWall: 300 * time.Millisecond},
	}
	level := judgeCoreCapacityBuildLevel(2, time.Second, records)
	if got, want := level.Aggregate.Throughput.Mean, 1.5; got != want {
		t.Fatalf("observed throughput mean=%v, want %v", got, want)
	}
	if got, want := level.Aggregate.Latency.P50, 200.0; got != want {
		t.Fatalf("p50=%v, want %v", got, want)
	}
	if level.Aggregate.Throughput.CI95 == nil {
		t.Fatal("two repetitions must produce a Student-t confidence interval")
	}
}

func TestJudgeCoreCapacitySaturationRequiresPlateauOrDegradation(t *testing.T) {
	makeLevel := func(concurrency int, throughput, p95 float64) judgeCoreCapacityLevel {
		return judgeCoreCapacityLevel{Concurrency: concurrency, Aggregate: judgeCoreCapacityLevelAggregate{Completed: 1, ErrorFree: true, HotCacheValid: true, Throughput: judgeCoreThroughputStats{Mean: throughput}, Latency: judgeCoreLatencyStats{P95: p95}}}
	}
	result := judgeCoreCapacitySelect([]judgeCoreCapacityLevel{makeLevel(1, 10, 10), makeLevel(2, 19, 12), makeLevel(4, 19.4, 20)})
	if result.Classification != "SATURATION_DEMONSTRATED" || result.SaturationConcurrency == nil || *result.SaturationConcurrency != 2 {
		t.Fatalf("saturation result=%+v", result)
	}
	result = judgeCoreCapacitySelect([]judgeCoreCapacityLevel{makeLevel(1, 10, 10), makeLevel(2, 20, 12), makeLevel(4, 30, 14)})
	if result.Classification != "MAX_TESTED_NO_SATURATION" {
		t.Fatalf("unexpected classification=%+v", result)
	}
}

func TestJudgeCoreCapacityArtifacts(t *testing.T) {
	dir := t.TempDir()
	records := []judgeCoreCapacityRecord{{RunID: "test", Concurrency: 1, Repetition: 1, Sequence: 1, StartedUTC: time.Now().UTC(), FinishedUTC: time.Now().UTC(), JudgeCoreWall: time.Millisecond, BatchCount: 4, TestcaseResultCount: 14, Verdict: "ACCEPTED", Correct: true, InMeasurementWindow: true}}
	if err := judgeCoreWriteArtifacts(dir, map[string]any{"compile": map[string]any{"included_in_judge_core": false}}, "# report\n", records, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"raw.csv", "summary.json", "report.md", "resources.csv"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if strings.Contains("# report\n", "compile included") {
		t.Fatal("invalid report fixture")
	}
}
