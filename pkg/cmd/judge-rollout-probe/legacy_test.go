package main

import (
	"net"
	"strings"
	"testing"

	"github.com/IBM/sarama"
)

func TestLegacyConsumerLogMustProveOneMatchingStartup(t *testing.T) {
	const matching = `{"level":"info","msg":"kafka consumer group initialized","brokers":["192.0.2.10:9094"],"group":"group-A"}`
	for _, test := range []struct {
		name, log string
		ok        bool
	}{
		{"release JSON", matching, true},
		{"console", "time\tINFO\tcaller\tkafka consumer group initialized\t" +
			`{"brokers":["192.0.2.10:9094"],"group":"group-A"}`, true},
		{"missing", `{"msg":"unrelated"}`, false},
		{"ambiguous", matching + "\n" + matching, false},
		{"wrong group", strings.Replace(matching, "group-A", "group-B", 1), false},
		{"wrong broker", strings.Replace(matching, "192.0.2.10", "192.0.2.11", 1), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := verifyLegacyConsumerLog(strings.NewReader(test.log), "192.0.2.10:9094", "group-A")
			if (err == nil) != test.ok {
				t.Fatalf("got %v, want success %t", err, test.ok)
			}
		})
	}
}

func TestLegacyMemberRequiresExclusivePeerAndTopic(t *testing.T) {
	const topic, id = "judge.jobs", "sarama-abc"
	for _, test := range []struct {
		name, peer, subscribed, assigned string
		count                            int
		ok                               bool
	}{
		{"matching", "192.0.2.20", topic, topic, 1, true},
		{"wrong peer", "192.0.2.21", topic, topic, 1, false},
		{"wrong subscription", "192.0.2.20", "other.jobs", topic, 1, false},
		{"wrong assignment", "192.0.2.20", topic, "other.jobs", 1, false},
		{"extra consumer", "192.0.2.20", topic, topic, 2, false},
		{"missing consumer", "192.0.2.20", topic, topic, 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			join := &sarama.JoinGroupRequest{}
			if err := join.AddGroupProtocolMetadata("roundrobin", &sarama.ConsumerGroupMemberMetadata{
				Topics: []string{test.subscribed},
			}); err != nil {
				t.Fatal(err)
			}
			sync := &sarama.SyncGroupRequest{}
			if err := sync.AddGroupAssignmentMember(id, &sarama.ConsumerGroupMemberAssignment{
				Topics: map[string][]int32{test.assigned: {0}},
			}); err != nil {
				t.Fatal(err)
			}
			member := &sarama.GroupMemberDescription{
				ClientId: "sarama", ClientHost: "/" + test.peer,
				MemberMetadata: join.OrderedGroupProtocols[0].Metadata, MemberAssignment: sync.GroupAssignments[0].Assignment,
			}
			group := &sarama.GroupDescription{GroupId: "group-A", State: "Stable",
				ProtocolType: "consumer", Protocol: "roundrobin", Members: map[string]*sarama.GroupMemberDescription{}}
			if test.count > 0 {
				group.Members[id] = member
			}
			if test.count > 1 {
				group.Members["sarama-extra"] = member
			}
			got, err := legacyMemberID(group, "group-A", topic, net.ParseIP("192.0.2.20"))
			if (err == nil) != test.ok || (test.ok && got != id) {
				t.Fatalf("got %q, %v, want success %t", got, err, test.ok)
			}
		})
	}
}
