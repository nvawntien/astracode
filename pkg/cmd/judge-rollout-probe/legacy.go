package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/IBM/sarama"
)

const consumerStartMessage = "kafka consumer group initialized"

func verifyLegacyConsumerLog(source io.Reader, broker, group string) error {
	count := 0
	scanner := bufio.NewScanner(source)
	for scanner.Scan() {
		line := scanner.Text()
		var event struct {
			Message string   `json:"msg"`
			Brokers []string `json:"brokers"`
			Group   string   `json:"group"`
		}
		if strings.HasPrefix(line, "{") {
			if json.Unmarshal([]byte(line), &event) != nil || event.Message != consumerStartMessage {
				continue
			}
		} else {
			// Development Zap consoles emit the message followed by JSON fields.
			_, fields, ok := strings.Cut(line, "\t"+consumerStartMessage+"\t")
			if !ok {
				continue
			}
			if err := json.Unmarshal([]byte(fields), &event); err != nil {
				return fmt.Errorf("malformed legacy consumer startup record")
			}
		}
		count++
		if len(event.Brokers) != 1 || event.Brokers[0] != broker || event.Group != group {
			return fmt.Errorf("legacy Worker startup broker or group differs from the plan")
		}
	}
	if scanner.Err() != nil || count != 1 {
		return fmt.Errorf("expected exactly one readable legacy consumer startup record")
	}
	return nil
}

func inspectLegacyMember(broker, group, topic, peer string) error {
	ip := net.ParseIP(peer)
	if !singleIPv4Endpoint(broker) || !kafkaName.MatchString(group) || !kafkaName.MatchString(topic) ||
		ip.To4() == nil || ip.IsLoopback() || ip.IsUnspecified() {
		return fmt.Errorf("invalid private broker, group, topic or legacy Judge peer")
	}
	admin, err := sarama.NewClusterAdmin([]string{broker}, rolloutKafkaConfig())
	if err != nil {
		return fmt.Errorf("could not connect to Kafka to verify legacy consumer")
	}
	defer admin.Close()
	groups, err := admin.DescribeConsumerGroups([]string{group})

	if err != nil || len(groups) != 1 {
		return fmt.Errorf("could not read legacy Kafka group membership")
	}
	id, err := legacyMemberID(groups[0], group, topic, ip)
	if err != nil {
		return err
	}
	fmt.Println(id)
	return nil
}

func legacyMemberID(g *sarama.GroupDescription, group, topic string, ip net.IP) (string, error) {
	if g == nil || g.Err != sarama.ErrNoError || g.GroupId != group || g.State != "Stable" ||
		g.ProtocolType != "consumer" || g.Protocol != "roundrobin" || len(g.Members) != 1 {
		return "", fmt.Errorf("legacy Kafka group must be Stable with exactly one round-robin consumer")
	}
	for id, member := range g.Members {
		if member == nil || member.ClientId != "sarama" || member.GroupInstanceId != nil ||
			!ip.Equal(net.ParseIP(strings.TrimPrefix(member.ClientHost, "/"))) || !kafkaName.MatchString(id) {
			return "", fmt.Errorf("Kafka member does not match the approved legacy Judge peer and client")
		}
		subscription, err := member.GetMemberMetadata()
		if err != nil || subscription == nil || len(subscription.Topics) != 1 || subscription.Topics[0] != topic {
			return "", fmt.Errorf("legacy consumer did not subscribe exclusively to the planned job topic")
		}
		assignment, err := member.GetMemberAssignment()
		if err != nil || assignment == nil || len(assignment.Topics) != 1 || len(assignment.Topics[topic]) == 0 {
			return "", fmt.Errorf("legacy consumer assignment does not match the planned job topic")
		}
		return id, nil
	}
	return "", fmt.Errorf("legacy Kafka group has no member")
}

func rolloutKafkaConfig() *sarama.Config {
	cfg := sarama.NewConfig()
	cfg.Version = sarama.V3_7_0_0
	cfg.Net.DialTimeout = 3 * time.Second
	cfg.Net.ReadTimeout = 3 * time.Second
	cfg.Net.WriteTimeout = 3 * time.Second
	cfg.Metadata.Retry.Max = 0
	return cfg
}

func verifyEmptyGroup(broker, group, topic string) error {
	if !singleIPv4Endpoint(broker) || !kafkaName.MatchString(group) || !kafkaName.MatchString(topic) {
		return fmt.Errorf("invalid private broker, group or topic")
	}
	client, err := sarama.NewClient([]string{broker}, rolloutKafkaConfig())
	if err != nil {
		return fmt.Errorf("could not connect to Kafka")
	}
	admin, err := sarama.NewClusterAdminFromClient(client)
	if err != nil {
		client.Close()
		return fmt.Errorf("could not connect to Kafka")
	}
	defer admin.Close()
	topics, err := admin.DescribeTopics([]string{topic})
	if err != nil || len(topics) != 1 || topics[0].Err != sarama.ErrNoError || topics[0].Name != topic || len(topics[0].Partitions) == 0 {
		return fmt.Errorf("official job topic unavailable")
	}
	groups, err := admin.DescribeConsumerGroups([]string{group})
	// A fresh broker may create/load its offsets coordinator on this first
	// request. Retry only those transient states, within the caller's deadline.
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) && (errors.Is(err, sarama.ErrConsumerCoordinatorNotAvailable) || errors.Is(err, sarama.ErrOffsetsLoadInProgress)) {
		time.Sleep(250 * time.Millisecond)
		groups, err = admin.DescribeConsumerGroups([]string{group})
	}
	if err != nil {
		return fmt.Errorf("Worker group description unavailable: %w", err)
	}
	if len(groups) != 1 || groups[0] == nil || groups[0].GroupId != group || len(groups[0].Members) != 0 {
		return fmt.Errorf("Worker group status ambiguous")
	}
	g := groups[0]
	if g.Err == sarama.ErrNoError && g.State == "Empty" {
		return nil
	}
	// A newly initialized broker has no group until its first consumer.
	// Require an empty official topic for this first deployment case.
	if g.State == "Dead" && (g.Err == sarama.ErrNoError || g.Err == sarama.ErrGroupIDNotFound) {
		for _, partition := range topics[0].Partitions {
			if partition.Err != sarama.ErrNoError {
				return fmt.Errorf("official job partition unavailable")
			}
			end, err := client.GetOffset(topic, partition.ID, sarama.OffsetNewest)
			if err != nil || end != 0 {
				return fmt.Errorf("uninitialized Worker group with unverified official job offsets")
			}
		}
		return nil
	}
	return fmt.Errorf("Worker group is not empty")
}

// retainedWork samples consumer offsets only once the expected groups have
// no running members. It returns aggregate counts and never reads records.
func retainedWork(broker string) error {
	if !singleIPv4Endpoint(broker) {
		return fmt.Errorf("invalid private Kafka endpoint")
	}
	client, err := sarama.NewClient([]string{broker}, rolloutKafkaConfig())
	if err != nil {
		return err
	}
	admin, err := sarama.NewClusterAdminFromClient(client)
	if err != nil {
		client.Close()
		return err
	}
	defer admin.Close()
	counts := map[string]int64{}
	for _, stream := range []struct{ name, topic, group string }{
		{"jobs", "judge.submission.jobs", "judge-worker-v1"},
		{"results", "judge.submission.results", "submission-service-v1"},
		{"dlt", "judge.submission.jobs.dlt", ""},
	} {
		parts, err := client.Partitions(stream.topic)
		if err != nil || len(parts) == 0 {
			return fmt.Errorf("no verified partitions for %s", stream.topic)
		}
		var offsets *sarama.OffsetFetchResponse
		if stream.group != "" {
			groups, err := admin.DescribeConsumerGroups([]string{stream.group})
			if err != nil || len(groups) != 1 || groups[0].GroupId != stream.group || len(groups[0].Members) != 0 ||
				(groups[0].State != "Empty" && groups[0].State != "Dead") ||
				(groups[0].Err != sarama.ErrNoError && groups[0].Err != sarama.ErrGroupIDNotFound) {
				return fmt.Errorf("unconfirmed empty group %s", stream.group)
			}
			offsets, err = admin.ListConsumerGroupOffsets(stream.group, map[string][]int32{stream.topic: parts})
			if err != nil || offsets.Err != sarama.ErrNoError {
				return fmt.Errorf("offsets unavailable for %s", stream.group)
			}
		}
		for _, part := range parts {
			first, e1 := client.GetOffset(stream.topic, part, sarama.OffsetOldest)
			last, e2 := client.GetOffset(stream.topic, part, sarama.OffsetNewest)
			if e1 != nil || e2 != nil || first < 0 || last < first {
				return fmt.Errorf("partition bounds unknown for %s", stream.topic)
			}
			if offsets != nil {
				block := offsets.GetBlock(stream.topic, part)
				if block == nil || block.Err != sarama.ErrNoError || block.Offset > last {
					return fmt.Errorf("committed offset unknown for %s", stream.topic)
				}
				if block.Offset > first {
					first = block.Offset
				}
			}
			counts[stream.name] += last - first
		}
	}
	return json.NewEncoder(os.Stdout).Encode(counts)
}
