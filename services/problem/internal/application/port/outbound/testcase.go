package outbound

import (
	"context"
	"go-judge-system/services/problem/internal/domain/entity"
)

type TestCaseRepository interface {
	TestCaseObjectReferences
	Upsert(ctx context.Context, tc *entity.TestCase) error
	GetByProblemID(ctx context.Context, problemID int64) (*entity.TestCase, error)
	DeleteByProblemID(ctx context.Context, problemID int64) error
}

type TestCaseObjectReferences interface {
	ListAllZipObjectKeys(ctx context.Context) ([]string, error)
}

type OfficialTestCaseMetadata struct {
	ZipObjectKey string
	TestCount    int
	Version      int
	TimeLimit    float64
	MemoryLimit  int
}

type OfficialTestCaseMetadataRepository interface {
	GetOfficialTestCaseMetadata(ctx context.Context, problemID int64) (OfficialTestCaseMetadata, error)
}
