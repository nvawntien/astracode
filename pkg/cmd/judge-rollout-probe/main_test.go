package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	problemv1 "go-judge-system/pkg/pb/problem/v1"
	"google.golang.org/grpc"
)

type fixtureProblem struct {
	problemv1.UnimplementedProblemServiceServer
	timeMS, memoryKB int64
}

func (s fixtureProblem) GetTestCase(context.Context, *problemv1.GetTestCaseRequest) (*problemv1.GetTestCaseResponse, error) {
	return &problemv1.GetTestCaseResponse{
		TestCount: 1, Version: 2, ZipDownloadUrl: "https://fixture.internal/?secret=not-for-logs",
		TimeLimitMs: s.timeMS, MemoryLimitKb: s.memoryKB,
	}, nil
}

func TestVerifyMetadataChecksExactUnitsAndLegacyResponses(t *testing.T) {
	for _, tt := range []struct {
		name    string
		ms, kib int64
		wantOK  bool
	}{
		{"matching configured fixture", 1_000, 524_288, true},
		{"legacy fields omitted on wire", 0, 0, false},
		{"seconds instead of milliseconds", 1, 524_288, false},
		{"MiB instead of KiB", 1_000, 512, false},
		{"invalid memory", 1_000, -1, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			server := grpc.NewServer()
			problemv1.RegisterProblemServiceServer(server, fixtureProblem{timeMS: tt.ms, memoryKB: tt.kib})
			go server.Serve(listener)
			t.Cleanup(server.Stop)

			err = verifyMetadata(listener.Addr().String(), []string{"42", "1000", "524288"})
			if (err == nil) != tt.wantOK {
				t.Fatalf("verifyMetadata() error = %v, want success = %t", err, tt.wantOK)
			}
			if err != nil && strings.Contains(err.Error(), "not-for-logs") {
				t.Fatal("probe leaked a signed URL")
			}
		})
	}
}

func TestUsesWorkerConfigRejectsShadowingMount(t *testing.T) {
	want := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(want, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	volumes := []mount{
		{Type: "bind", Source: filepath.Dir(want), Target: "/app/config"},
	}
	if !usesWorkerConfig(volumes, want) {
		t.Fatal("directory bind to the expected configuration was rejected")
	}
	volumes = append(volumes, mount{Type: "volume", Source: "other-config", Target: "/app/config/config.yaml"})
	if usesWorkerConfig(volumes, want) {
		t.Fatal("another mount shadows the expected Worker configuration")
	}
}
