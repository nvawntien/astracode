package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
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
	cfg := sarama.NewConfig()
	cfg.Version = sarama.V3_7_0_0
	cfg.Net.DialTimeout = 3 * time.Second
	cfg.Net.ReadTimeout = 3 * time.Second
	cfg.Net.WriteTimeout = 3 * time.Second
	cfg.Metadata.Retry.Max = 0
	admin, err := sarama.NewClusterAdmin([]string{broker}, cfg)
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
