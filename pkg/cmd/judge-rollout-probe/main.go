// judge-rollout-probe is a private deployment client. It never prints the
// GetTestCase response body, which contains a presigned testcase URL.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go-judge-system/pkg/config"
	problemv1 "go-judge-system/pkg/pb/problem/v1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

var kafkaName = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

func main() {
	var err error
	switch {
	case len(os.Args) == 6 && os.Args[1] == "metadata":
		err = verifyMetadata(os.Args[2], os.Args[3:])
	case len(os.Args) == 4 && os.Args[1] == "worker-settings":
		err = workerSettings(os.Args[2], os.Args[3])
	default:
		err = fmt.Errorf("usage: judge-rollout-probe metadata <address> <problem-id> <ms> <KiB> | worker-settings <config.yaml> <running|planned>")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func verifyMetadata(address string, values []string) error {
	expected := make([]int64, len(values))
	for i, value := range values {
		number, err := strconv.ParseInt(value, 10, 64)
		if err != nil || number <= 0 {
			return fmt.Errorf("probe problem ID and expected limits must be positive")
		}
		expected[i] = number
	}
	conn, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("could not initialize the private Problem gRPC probe")
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reply, err := problemv1.NewProblemServiceClient(conn).GetTestCase(ctx, &problemv1.GetTestCaseRequest{ProblemId: expected[0]})
	if err != nil {
		return fmt.Errorf("GetTestCase capability probe failed: gRPC %s", status.Code(err))
	}
	if reply.GetTimeLimitMs() != expected[1] || reply.GetMemoryLimitKb() != expected[2] ||
		reply.GetTestCount() <= 0 || reply.GetVersion() <= 0 || reply.GetZipDownloadUrl() == "" {
		return fmt.Errorf("GetTestCase capability mismatch for fixture %d: got %d ms / %d KiB, expected %d ms / %d KiB with usable dataset metadata",
			expected[0], reply.GetTimeLimitMs(), reply.GetMemoryLimitKb(), expected[1], expected[2])
	}
	fmt.Printf("Verified GetTestCase fixture %d: %d ms / %d KiB\n", expected[0], expected[1], expected[2])
	return nil
}

func workerSettings(configPath, mode string) error {
	var environment map[string]string
	var volumes []mount
	decoder := json.NewDecoder(os.Stdin)
	switch mode {
	case "running":
		var container struct {
			Config struct{ Env []string }
			Mounts []mount
		}
		if err := decoder.Decode(&container); err != nil {
			return fmt.Errorf("could not read the Worker container environment")
		}
		volumes = container.Mounts
		environment = make(map[string]string, len(container.Config.Env))
		for _, item := range container.Config.Env {
			key, value, _ := strings.Cut(item, "=")
			environment[key] = value
		}
	case "planned":
		var model struct {
			Services map[string]struct {
				Environment map[string]string
				Scale       *int
				Deploy      struct{ Replicas *int }
				Volumes     []mount
			}
		}
		if err := decoder.Decode(&model); err != nil {
			return fmt.Errorf("could not read the planned Judge Compose model")
		}
		worker, ok := model.Services["judge-worker"]
		if !ok || (worker.Scale != nil && *worker.Scale != 1) || (worker.Deploy.Replicas != nil && *worker.Deploy.Replicas != 1) {
			return fmt.Errorf("the protected rollout requires one configured Judge Worker")
		}
		environment = worker.Environment
		volumes = worker.Volumes
	default:
		return fmt.Errorf("unknown Worker settings mode")
	}
	if environment["WORKER_POOL_SIZE"] != "1" {
		return fmt.Errorf("WORKER_POOL_SIZE must be 1 to interrupt jobs without committing past a cancelled offset")
	}
	if !usesWorkerConfig(volumes, configPath) {
		return fmt.Errorf("Worker must mount the node-owned config at /app/config or /app/config/config.yaml")
	}
	for _, key := range []string{"KAFKA_BROKERS", "KAFKA_CONSUMER_GROUP", "KAFKA_JOB_TOPIC", "PROBLEM_GRPC_ADDRESS"} {
		if err := os.Unsetenv(key); err != nil {
			return err
		}
		if value, ok := environment[key]; ok {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	if filepath.Base(configPath) != "config.yaml" {
		return fmt.Errorf("expected the mounted Worker config.yaml")
	}
	cfg, err := config.LoadConfig(filepath.Dir(configPath))
	if err != nil {
		return fmt.Errorf("could not load the mounted Worker configuration")
	}
	problem := strings.TrimSpace(cfg.ProblemGRPC.Address)
	broker := strings.TrimSpace(cfg.Kafka.Brokers)
	group := strings.TrimSpace(cfg.Kafka.ConsumerGroup)
	topic := strings.TrimSpace(cfg.Kafka.JobTopic)
	if topic == "" {
		topic = "judge.submission.jobs"
	}
	if !singleIPv4Endpoint(problem) || !singleIPv4Endpoint(broker) || !kafkaName.MatchString(group) || !kafkaName.MatchString(topic) {
		return fmt.Errorf("expected one explicit private IPv4 endpoint each for Problem gRPC and Kafka, plus the Worker group and topic")
	}
	fmt.Println(problem, broker, group, topic)
	return nil
}

type mount struct {
	Type        string
	Source      string
	Target      string // compose config
	Destination string // docker inspect
}

func usesWorkerConfig(volumes []mount, configPath string) bool {
	// A file mount takes precedence over a directory mount in the container.
	source := ""
	for _, volume := range volumes {
		target := volume.Target
		if target == "" {
			target = volume.Destination
		}
		switch target {
		case "/app/config/config.yaml":
			return volume.Type == "bind" && sameConfigPath(volume.Source, configPath)
		case "/app/config":
			if volume.Type == "bind" {
				source = filepath.Join(volume.Source, "config.yaml")
			}
		}
	}
	return sameConfigPath(source, configPath)
}

func sameConfigPath(source, expected string) bool {
	path, err := filepath.EvalSymlinks(source)
	want, wantErr := filepath.EvalSymlinks(expected)
	return err == nil && wantErr == nil && path == want
}

func singleIPv4Endpoint(address string) bool {
	host, port, err := net.SplitHostPort(address)
	ip := net.ParseIP(host)
	number, portErr := strconv.ParseUint(port, 10, 16)
	return err == nil && ip.To4() != nil && !ip.IsUnspecified() && !ip.IsLoopback() && portErr == nil && number > 0
}
