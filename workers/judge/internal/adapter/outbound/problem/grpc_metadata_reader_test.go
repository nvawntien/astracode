package problem

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	problemv1 "go-judge-system/pkg/pb/problem/v1"
	workerdomain "go-judge-system/workers/judge/internal/domain"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeProblemServiceClient struct {
	resp *problemv1.GetTestCaseResponse
	err  error
	seen *problemv1.GetTestCaseRequest
}

func (f *fakeProblemServiceClient) GetTestCase(
	_ context.Context,
	req *problemv1.GetTestCaseRequest,
	_ ...grpc.CallOption,
) (*problemv1.GetTestCaseResponse, error) {
	f.seen = req
	return f.resp, f.err
}

func (f *fakeProblemServiceClient) GetProblem(
	_ context.Context,
	_ *problemv1.GetProblemRequest,
	_ ...grpc.CallOption,
) (*problemv1.GetProblemResponse, error) {
	return nil, errors.New("not implemented")
}

func TestGRPCMetadataReaderGetTestCaseMetadata(t *testing.T) {
	t.Parallel()

	client := &fakeProblemServiceClient{
		resp: &problemv1.GetTestCaseResponse{
			ZipDownloadUrl: " http://minio/testcases.zip ",
			TestCount:      3,
			Version:        7,
			TimeLimitMs:    500,
			MemoryLimitKb:  524_288,
		},
	}
	reader := NewGRPCMetadataReader(client, time.Second, zap.NewNop())

	got, err := reader.GetTestCaseMetadata(context.Background(), 42)
	if err != nil {
		t.Fatalf("GetTestCaseMetadata() error = %v", err)
	}
	if client.seen == nil || client.seen.GetProblemId() != 42 {
		t.Fatalf("GetTestCase request = %+v, want problem_id=42", client.seen)
	}
	if got.ProblemID != 42 || got.ZipDownloadURL != "http://minio/testcases.zip" || got.TestCount != 3 || got.Version != 7 {
		t.Fatalf("metadata = %#v", got)
	}
	if got.TimeLimitMS != 500 || got.MemoryLimitKB != 524_288 {
		t.Fatalf("execution limits = %d ms / %d KiB, want 500 / 524288", got.TimeLimitMS, got.MemoryLimitKB)
	}
}

func TestGRPCMetadataReaderMarksNotFoundNonRetryable(t *testing.T) {
	t.Parallel()

	reader := NewGRPCMetadataReader(&fakeProblemServiceClient{
		err: status.Error(codes.NotFound, "missing"),
	}, time.Second, zap.NewNop())

	_, err := reader.GetTestCaseMetadata(context.Background(), 42)
	if err == nil {
		t.Fatal("GetTestCaseMetadata() error = nil")
	}
	if !workerdomain.IsNonRetryable(err) {
		t.Fatalf("IsNonRetryable(%v) = false, want true", err)
	}
}

func TestGRPCMetadataReaderRejectsLegacyResponseWithoutExecutionLimits(t *testing.T) {
	t.Parallel()

	reader := NewGRPCMetadataReader(&fakeProblemServiceClient{
		resp: &problemv1.GetTestCaseResponse{
			ZipDownloadUrl: "http://minio.local/testcases.zip",
			TestCount:      24,
			Version:        1,
		},
	}, time.Second, zap.NewNop())

	_, err := reader.GetTestCaseMetadata(context.Background(), 42)
	if err == nil || workerdomain.IsNonRetryable(err) {
		t.Fatalf("GetTestCaseMetadata() error = %v, want retryable missing-limit error", err)
	}
}

func TestGRPCMetadataReaderRejectsUnusableExecutionLimits(t *testing.T) {
	for _, tt := range []struct {
		name         string
		timeMS       int64
		memoryKB     int64
		nonRetryable bool
	}{
		{"missing time", 0, 524_288, false},
		{"missing memory", 1_000, 0, false},
		{"negative time", -1, 524_288, true},
		{"negative memory", 1_000, -1, true},
		{"clock overflow", math.MaxInt64, 524_288, true},
		{"memory byte overflow", 1_000, math.MaxInt64, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			reader := NewGRPCMetadataReader(&fakeProblemServiceClient{
				resp: &problemv1.GetTestCaseResponse{
					ZipDownloadUrl: "http://minio.local/testcases.zip", TestCount: 24, Version: 1,
					TimeLimitMs: tt.timeMS, MemoryLimitKb: tt.memoryKB,
				},
			}, time.Second, zap.NewNop())

			_, err := reader.GetTestCaseMetadata(context.Background(), 42)
			if err == nil || workerdomain.IsNonRetryable(err) != tt.nonRetryable {
				t.Fatalf("GetTestCaseMetadata() error = %v, want error with non-retryable = %v", err, tt.nonRetryable)
			}
		})
	}
}

func TestGRPCMetadataReaderRejectsInvalidProblemServiceResponse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		response *problemv1.GetTestCaseResponse
		wantErr  string
	}{
		{
			name:     "nil response",
			response: nil,
			wantErr:  "nil testcase metadata",
		},
		{
			name: "empty URL",
			response: &problemv1.GetTestCaseResponse{
				TestCount: 24,
				Version:   1,
			},
			wantErr: "empty zip_download_url",
		},
		{
			name: "invalid test count",
			response: &problemv1.GetTestCaseResponse{
				ZipDownloadUrl: "http://minio.local/testcases.zip",
				Version:        1,
			},
			wantErr: "invalid test_count",
		},
		{
			name: "invalid version",
			response: &problemv1.GetTestCaseResponse{
				ZipDownloadUrl: "http://minio.local/testcases.zip",
				TestCount:      24,
			},
			wantErr: "invalid version",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			reader := NewGRPCMetadataReader(&fakeProblemServiceClient{resp: tt.response}, time.Second, zap.NewNop())

			_, err := reader.GetTestCaseMetadata(context.Background(), 42)
			if err == nil {
				t.Fatal("GetTestCaseMetadata() error = nil, want error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("GetTestCaseMetadata() error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestGRPCMetadataReaderPropagatesRetryableGRPCError(t *testing.T) {
	t.Parallel()

	reader := NewGRPCMetadataReader(&fakeProblemServiceClient{
		err: status.Error(codes.Unavailable, "problem unavailable"),
	}, time.Second, zap.NewNop())

	_, err := reader.GetTestCaseMetadata(context.Background(), 42)
	if err == nil {
		t.Fatal("GetTestCaseMetadata() error = nil, want error")
	}
	if workerdomain.IsNonRetryable(err) {
		t.Fatalf("IsNonRetryable(%v) = true, want false", err)
	}
	if !strings.Contains(err.Error(), "get testcase metadata from problem-service") {
		t.Fatalf("GetTestCaseMetadata() error = %v, want gRPC context", err)
	}
}
