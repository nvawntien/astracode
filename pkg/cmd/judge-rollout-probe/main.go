// judge-rollout-probe is a private deployment client. It never prints the
// GetTestCase response body, which contains a presigned testcase URL.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	case len(os.Args) == 6 && os.Args[1] == "legacy-metadata":
		err = checkMetadata(os.Args[2], os.Args[3:], true)
	case len(os.Args) == 4 && os.Args[1] == "legacy-consumer":
		err = verifyLegacyConsumerLog(os.Stdin, os.Args[2], os.Args[3])
	case len(os.Args) == 6 && os.Args[1] == "kafka-member":
		err = inspectLegacyMember(os.Args[2], os.Args[3], os.Args[4], os.Args[5])
	case len(os.Args) == 5 && os.Args[1] == "kafka-empty":
		err = verifyEmptyGroup(os.Args[2], os.Args[3], os.Args[4])
	case len(os.Args) == 3 && os.Args[1] == "retained-work":
		err = retainedWork(os.Args[2])
	case len(os.Args) == 4 && os.Args[1] == "worker-settings":
		err = workerSettings(os.Args[2], os.Args[3])
	default:
		err = fmt.Errorf("usage: judge-rollout-probe <metadata|legacy-metadata> <address> <problem-id> <ms> <KiB> | " +
			"kafka-empty <broker> <group> <topic> | worker-settings <config.yaml> <running|planned> | legacy-consumer <broker> <group> | kafka-member <broker> <group> <topic> <peer>")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func verifyMetadata(address string, values []string) error {
	return checkMetadata(address, values, false)
}

func checkMetadata(address string, values []string, legacy bool) error {
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
	timeMS, memoryKiB := expected[1], expected[2]
	if legacy {
		timeMS, memoryKiB = 0, 0
	}
	if reply.GetTimeLimitMs() != timeMS || reply.GetMemoryLimitKb() != memoryKiB ||
		reply.GetTestCount() <= 0 || reply.GetVersion() <= 0 || reply.GetZipDownloadUrl() == "" {
		return fmt.Errorf("GetTestCase capability mismatch for fixture %d: got %d ms / %d KiB, expected %d ms / %d KiB with usable dataset metadata",
			expected[0], reply.GetTimeLimitMs(), reply.GetMemoryLimitKb(), timeMS, memoryKiB)
	}
	if legacy {
		fmt.Printf("Verified legacy GetTestCase fixture %d has no execution limits\n", expected[0])
		return nil
	}
	fmt.Printf("Verified GetTestCase fixture %d: %d ms / %d KiB\n", expected[0], expected[1], expected[2])
	return nil
}

func workerSettings(configPath, mode string) error {
	switch mode {
	case "running":
		identity, err := readWorkerRuntime(os.Stdin)
		if err != nil {
			return err
		}
		return printWorkerSettings(identity)
	case "planned":
		return plannedWorkerSettings(configPath)
	default:
		return fmt.Errorf("unknown Worker settings mode")
	}
}

func readWorkerRuntime(source io.Reader) (config.JudgeWorkerRuntime, error) {
	var identity config.JudgeWorkerRuntime
	reader := bufio.NewReader(io.LimitReader(source, 16<<10))
	bootID, err := reader.ReadString('\n')
	if err != nil {
		return identity, fmt.Errorf("could not read the Worker's boot identity")
	}
	stat, err := reader.ReadString('\n')
	if err != nil {
		return identity, fmt.Errorf("could not read the Worker's process identity")
	}
	instance, err := config.JudgeWorkerInstance(bootID, stat)
	if err != nil {
		return identity, err
	}
	if err := json.NewDecoder(reader).Decode(&identity); err != nil || identity.Instance != instance {
		return identity, fmt.Errorf("missing or stale Worker startup settings")
	}
	if identity.ConfigDir != "/app/config" {
		return identity, fmt.Errorf("running Worker must load its configuration from /app/config")
	}
	return identity, nil
}

func plannedWorkerSettings(configPath string) error {
	var model struct {
		Services map[string]struct {
			Environment map[string]string
			Scale       *int
			Deploy      struct{ Replicas *int }
			Volumes     []mount
		}
	}
	if err := json.NewDecoder(os.Stdin).Decode(&model); err != nil {
		return fmt.Errorf("could not read the planned Judge Compose model")
	}
	worker, ok := model.Services["judge-worker"]
	if !ok || (worker.Scale != nil && *worker.Scale != 1) || (worker.Deploy.Replicas != nil && *worker.Deploy.Replicas != 1) {
		return fmt.Errorf("the protected rollout requires one configured Judge Worker")
	}
	environment := worker.Environment
	if environment["WORKER_POOL_SIZE"] != "1" {
		return fmt.Errorf("the protected rollout requires WORKER_POOL_SIZE=1")
	}
	if !usesWorkerConfig(worker.Volumes, configPath) {
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
	topic := strings.TrimSpace(cfg.Kafka.JobTopic)
	if topic == "" {
		topic = "judge.submission.jobs"
	}
	return printWorkerSettings(config.JudgeWorkerRuntime{
		ProblemAddress: cfg.ProblemGRPC.Address, KafkaBroker: cfg.Kafka.Brokers, KafkaGroup: cfg.Kafka.ConsumerGroup,
		KafkaTopic: topic, WorkerPoolSize: 1,
	})
}

func printWorkerSettings(settings config.JudgeWorkerRuntime) error {
	if settings.WorkerPoolSize != 1 {
		return fmt.Errorf("the protected rollout requires WORKER_POOL_SIZE=1")
	}
	problem := strings.TrimSpace(settings.ProblemAddress)
	broker := strings.TrimSpace(settings.KafkaBroker)
	group := strings.TrimSpace(settings.KafkaGroup)
	topic := settings.KafkaTopic
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
