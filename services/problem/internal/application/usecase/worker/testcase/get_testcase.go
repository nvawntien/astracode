package worker

import (
	"context"

	"go-judge-system/pkg/judge"
	"go-judge-system/services/problem/internal/application/dto"
	"go-judge-system/services/problem/internal/application/port/inbound/worker"
	"go-judge-system/services/problem/internal/application/port/outbound"
	"go-judge-system/services/problem/internal/domain"
)

type getTestCaseUseCase struct {
	tcRepo    outbound.OfficialTestCaseMetadataRepository
	tcStorage outbound.TestCaseStorage
}

func NewGetTestCaseUseCase(tcRepo outbound.OfficialTestCaseMetadataRepository, tcStorage outbound.TestCaseStorage) worker.GetTestCaseUseCase {
	return &getTestCaseUseCase{
		tcRepo:    tcRepo,
		tcStorage: tcStorage,
	}
}

func (uc *getTestCaseUseCase) Execute(ctx context.Context, problemID int64) (*dto.InternalTestCaseResponse, error) {
	testcase, err := uc.tcRepo.GetOfficialTestCaseMetadata(ctx, problemID)
	if err != nil {
		return nil, err
	}

	timeLimitMS := judge.ProblemTimeLimitMS(testcase.TimeLimit)
	if timeLimitMS == 0 {
		return nil, domain.ErrInvalidTimeLimit
	}
	memoryLimitKB := judge.ProblemMemoryLimitKB(testcase.MemoryLimit)
	if memoryLimitKB == 0 {
		return nil, domain.ErrInvalidMemoryLimit
	}

	downloadURL, err := uc.tcStorage.GetPresignedURL(ctx, testcase.ZipObjectKey, judge.TestcaseDownloadURLLifetime)
	if err != nil {
		return nil, err
	}

	return &dto.InternalTestCaseResponse{
		TestCount:      testcase.TestCount,
		Version:        testcase.Version,
		ZipDownloadURL: downloadURL,
		TimeLimitMS:    timeLimitMS,
		MemoryLimitKB:  memoryLimitKB,
	}, nil
}
