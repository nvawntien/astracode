package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"go-judge-system/pkg/config"
)

func writeRuntimeSettings(cfg *config.Config, configDir, topic string, poolSize int) error {
	bootID, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return err
	}
	stat, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return err
	}
	instance, err := config.JudgeWorkerInstance(string(bootID), string(stat))
	if err != nil {
		return err
	}
	configDir, err = filepath.Abs(configDir)
	if err != nil {
		return err
	}
	runtime := config.JudgeWorkerRuntime{
		Instance: instance, ConfigDir: configDir, ProblemAddress: cfg.ProblemGRPC.Address,
		KafkaBroker: cfg.Kafka.Brokers, KafkaGroup: cfg.Kafka.ConsumerGroup,
		KafkaTopic: topic, WorkerPoolSize: poolSize,
	}
	file, err := os.CreateTemp(filepath.Dir(config.JudgeWorkerRuntimeFile), ".judge-runtime-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	writeErr := json.NewEncoder(file).Encode(runtime)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), config.JudgeWorkerRuntimeFile)
}
