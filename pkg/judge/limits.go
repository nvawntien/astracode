package judge

import (
	"math"
	"time"
)

// Object reconciliation retains retired packages through both download windows.
const (
	TestcaseDownloadURLLifetime = 15 * time.Minute
	TestcaseDownloadTimeout     = 30 * time.Second
)

// The executor converts milliseconds to nanoseconds (with a doubled clock
// limit) and KiB to bytes using signed arithmetic.
const (
	maxExecutionTimeMS   = math.MaxInt64 / int64(2*time.Millisecond)
	maxExecutionMemoryKB = math.MaxInt64 / 1024
)

// ProblemTimeLimitMS normalizes seconds and legacy millisecond values.
// Zero indicates that the configured value cannot be used.
func ProblemTimeLimitMS(value float64) int64 {
	if value < 50 {
		value *= 1_000
	}
	if !(value >= 1 && value <= float64(maxExecutionTimeMS)) {
		return 0
	}
	return int64(value)
}

// ProblemMemoryLimitKB converts configured MiB to KiB.
// Zero indicates that the configured value cannot be used.
func ProblemMemoryLimitKB(value int) int64 {
	if value <= 0 || int64(value) > maxExecutionMemoryKB/1024 {
		return 0
	}
	return int64(value) * 1024
}

func ValidExecutionLimits(timeLimitMS, memoryLimitKB int64) bool {
	return timeLimitMS > 0 && timeLimitMS <= maxExecutionTimeMS &&
		memoryLimitKB > 0 && memoryLimitKB <= maxExecutionMemoryKB
}
