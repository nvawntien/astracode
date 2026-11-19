package config

import (
	"fmt"
	"strconv"
	"strings"
)

// JudgeWorkerRuntimeFile contains the non-secret settings captured at startup.
// Its instance ID binds it to the running process even across container restarts.
const JudgeWorkerRuntimeFile = "/tmp/astracode-judge-worker-runtime.json"

type JudgeWorkerRuntime struct {
	Instance       string `json:"instance"`
	ConfigDir      string `json:"config_dir"`
	ProblemAddress string `json:"problem_address"`
	KafkaBroker    string `json:"kafka_broker"`
	KafkaGroup     string `json:"kafka_group"`
	KafkaTopic     string `json:"kafka_topic"`
	WorkerPoolSize int    `json:"worker_pool_size"`
}

// JudgeWorkerInstance reads the process start time (field 22 of /proc/PID/stat).
// The command in parentheses can contain spaces and closing parentheses.
func JudgeWorkerInstance(bootID, stat string) (string, error) {
	bootID = strings.TrimSpace(bootID)
	pid, _, hasPID := strings.Cut(stat, " (")
	end := strings.LastIndex(stat, ") ")
	if bootID != "" && hasPID && end >= 0 {
		fields := strings.Fields(stat[end+2:])
		if len(fields) > 19 {
			pidNumber, pidErr := strconv.ParseUint(pid, 10, 64)
			_, startErr := strconv.ParseUint(fields[19], 10, 64)
			if pidErr == nil && pidNumber > 0 && startErr == nil {
				return bootID + ":" + pid + ":" + fields[19], nil
			}
		}
	}
	return "", fmt.Errorf("could not identify the running Worker process")
}
