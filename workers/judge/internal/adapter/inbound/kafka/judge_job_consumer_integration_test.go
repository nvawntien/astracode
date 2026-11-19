package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"go-judge-system/pkg/config"
	"go-judge-system/pkg/judge"
	sharedkafka "go-judge-system/pkg/kafka"

	"github.com/IBM/sarama"
	"go.uber.org/zap"
)

// Use a fresh disposable broker with auto.create.topics.enable=false. Each
// scenario uses unique topics and a group. The initially absent DLT gives a
// real broker produce error without changing broker state or existing offsets.
func TestJudgeJobKafkaDLTCommitAndRedelivery(t *testing.T) {
	broker := os.Getenv("ASTRACODE_JUDGE_DISPOSABLE_KAFKA")
	if broker == "" {
		t.Skip("set ASTRACODE_JUDGE_DISPOSABLE_KAFKA to a disposable Kafka broker with topic auto-creation disabled")
	}
	t.Setenv("WORKER_POOL_SIZE", "4")
	logger := zap.NewNop()
	brokers := []string{broker}
	kafkaConfig := func() *sarama.Config {
		cfg := sarama.NewConfig()
		cfg.Version = sarama.V3_7_0_0
		cfg.Metadata.AllowAutoTopicCreation = false
		cfg.Metadata.Retry.Max = 1
		cfg.Producer.RequiredAcks = sarama.WaitForAll
		cfg.Producer.Return.Successes = true
		cfg.Producer.Partitioner = sarama.NewManualPartitioner
		cfg.Producer.Retry.Max = 1
		cfg.Net.DialTimeout = 3 * time.Second
		cfg.Net.ReadTimeout = 3 * time.Second
		cfg.Net.WriteTimeout = 3 * time.Second
		return cfg
	}
	admin, err := sarama.NewClusterAdmin(brokers, kafkaConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	originalProducer, err := sarama.NewSyncProducer(brokers, kafkaConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer originalProducer.Close()
	reader, err := sarama.NewConsumer(brokers, kafkaConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	for _, tc := range []struct {
		name, value string
		retries     int
	}{
		{"exhausted", `{"submission_id":7}`, defaultMaxRetries},
		{"invalid_json", "{broken", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := fmt.Sprintf("astracode-dlt-test-%d", time.Now().UnixNano())
			cfg := config.KafkaConfig{Brokers: broker, JobTopic: base + "-jobs", DLTTopic: base + "-dlt", ConsumerGroup: base + "-group"}
			createTopic := func(topic string, partitions int32) {
				t.Helper()
				if err := admin.CreateTopic(topic, &sarama.TopicDetail{NumPartitions: partitions, ReplicationFactor: 1}, false); err != nil {
					t.Fatal(err)
				}
			}
			createTopic(cfg.JobTopic, 2)
			send := func(partition int32, value string, wantOffset int64) {
				t.Helper()
				_, offset, err := originalProducer.SendMessage(&sarama.ProducerMessage{
					Topic: cfg.JobTopic, Partition: partition, Value: sarama.StringEncoder(value), Key: sarama.StringEncoder("fixture"),
				})
				if err != nil || offset != wantOffset {
					t.Fatalf("produce partition %d: offset=%d want=%d err=%v", partition, offset, wantOffset, err)
				}
			}
			committed := func(partition int32) *sarama.OffsetFetchResponseBlock {
				t.Helper()
				resp, err := admin.ListConsumerGroupOffsets(cfg.ConsumerGroup, map[string][]int32{cfg.JobTopic: {partition}})
				if err != nil {
					t.Fatal(err)
				}
				block := resp.GetBlock(cfg.JobTopic, partition)
				if block == nil || block.Err != sarama.ErrNoError {
					t.Fatalf("offset fetch: %+v", block)
				}
				return block
			}
			waitCommitted := func(partition int32, want int64) {
				t.Helper()
				ticker := time.NewTicker(50 * time.Millisecond)
				defer ticker.Stop()
				deadline := time.After(15 * time.Second)
				for {
					if block := committed(partition); block.Offset == want {
						return
					}
					select {
					case <-ticker.C:
					case <-deadline:
						t.Fatalf("partition %d committed %+v, want %d", partition, committed(partition), want)
					}
				}
			}
			seen := make(chan int64, 32)
			useCase := processJudgeJobFunc(func(_ context.Context, job *judge.JobMessage) error {
				seen <- job.SubmissionID
				if job.SubmissionID == 7 {
					return errors.New("synthetic retryable execution failure")
				}
				return nil
			})
			start := func(dlt *DLTPublisher) func() {
				t.Helper()
				group, err := sharedkafka.NewConsumerGroup(cfg, logger)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				done := make(chan error, 1)
				consumer := NewJudgeJobConsumer(group, cfg, useCase, dlt, logger)
				go func() { done <- consumer.Run(ctx) }()
				stopped := false
				stop := func() {
					if stopped {
						return
					}
					stopped = true
					cancel()
					select {
					case err := <-done:
						if err != nil {
							t.Errorf("stop consumer: %v", err)
						}
					case <-time.After(15 * time.Second):
						t.Error("consumer did not stop")
					}
					if err := consumer.Close(); err != nil {
						t.Errorf("close consumer: %v", err)
					}
				}
				t.Cleanup(stop)
				return stop
			}

			dltProducer, err := sharedkafka.NewSyncProducer(cfg, logger)
			if err != nil {
				t.Fatal(err)
			}
			defer dltProducer.Close()
			dltOutcome := make(chan error, 1)
			observedProducer := syncProducerFunc{send: func(msg *sarama.ProducerMessage) (int32, int64, error) {
				partition, offset, err := dltProducer.SendMessage(msg)
				dltOutcome <- err
				return partition, offset, err
			}}
			send(0, `{"submission_id":1}`, 0)
			stop := start(NewDLTPublisher(observedProducer, cfg, logger))
			waitCommitted(0, 1)
			send(0, tc.value, 1)
			send(0, `{"submission_id":8}`, 2)
			if tc.retries != 0 {
				select {
				case err := <-dltOutcome:
					if err == nil {
						t.Fatal("broker unexpectedly acknowledged nonexistent DLT")
					}
					t.Logf("broker DLT produce failed: %v", err)
				case <-time.After(15 * time.Second):
					t.Fatal("no DLT publish outcome")
				}
			} else {
				// Before the fix the invalid record cannot be encoded and is
				// falsely marked without ever reaching the producer.
				select {
				case err := <-dltOutcome:
					if err == nil {
						t.Fatal("broker unexpectedly acknowledged nonexistent DLT")
					}
					t.Logf("broker DLT produce failed: %v", err)
				case <-time.After(2 * time.Second):
					t.Error("invalid JSON never reached the DLT producer")
				}
			}
			send(1, `{"submission_id":2}`, 0)
			waitCommitted(1, 1)
			stop()
			block := committed(0)
			t.Logf("after failed DLT and shutdown: committed partition 0 offset=%d (%s), partition 1 offset=%d",
				block.Offset, block.Metadata, committed(1).Offset)
			if block.Offset != 1 || block.Metadata != "processed" {
				t.Fatal("commit advanced beyond the last successful job")
			}
			for len(seen) > 0 {
				if <-seen == 8 {
					t.Fatal("later job on the failed partition was processed before recovery")
				}
			}
			createTopic(cfg.DLTTopic, 1)
			stop = start(NewDLTPublisher(dltProducer, cfg, logger))
			waitCommitted(0, 3)
			stop()
			if tc.retries != 0 {
				var attempts int
				for len(seen) > 0 {
					if <-seen == 7 {
						attempts++
					}
				}
				if attempts != tc.retries {
					t.Fatalf("redelivery attempted %d times, want %d", attempts, tc.retries)
				}
			}
			dlt, err := reader.ConsumePartition(cfg.DLTTopic, 0, sarama.OffsetOldest)
			if err != nil {
				t.Fatal(err)
			}
			defer dlt.Close()
			select {
			case msg := <-dlt.Messages():
				var record DLTMessage
				if err := json.Unmarshal(msg.Value, &record); err != nil {
					t.Fatal(err)
				}
				if record.OriginalTopic != cfg.JobTopic || record.OriginalPartition != 0 || record.OriginalOffset != 1 ||
					record.OriginalKey != "fixture" || record.RetryCount != tc.retries || record.ErrorMessage == "" {
					t.Fatalf("incorrect DLT origin or reason: %+v", record)
				}
				raw := string(record.OriginalValue)
				if record.OriginalEncoding == "base64" {
					var decoded []byte
					if err := json.Unmarshal(record.OriginalValue, &decoded); err != nil {
						t.Fatal(err)
					}
					raw = string(decoded)
				}
				if raw != tc.value {
					t.Fatalf("DLT original was changed: %q", raw)
				}
				t.Logf("after recovery: committed partition 0 offset=%d, DLT offset=%d contains original offset=%d",
					committed(0).Offset, msg.Offset, record.OriginalOffset)
			case <-time.After(10 * time.Second):
				t.Fatal("no retained DLT record")
			}
		})
	}
}
