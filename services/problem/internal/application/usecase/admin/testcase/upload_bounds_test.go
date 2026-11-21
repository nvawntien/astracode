package testcase

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go-judge-system/pkg/rbac"
	"go-judge-system/services/problem/internal/application/dto"
	"go-judge-system/services/problem/internal/domain"
)

func TestUploadTestCaseRejectsOversizedMultipartFile(t *testing.T) {
	uc := NewUploadTestCaseUseCase(&accessMatrixProblemRepository{problem: testcaseProblem(true)}, nil, nil)
	_, err := uc.Execute(context.Background(), testcaseClaims(rbac.RoleUser, "owner"), dto.ProblemIDRequest{ID: 42},
		dto.UploadTestCaseRequest{File: &multipart.FileHeader{Size: maxFileZipSize + 1}})
	if !errors.Is(err, domain.ErrInvalidTestCase) {
		t.Fatalf("oversized upload = %v", err)
	}
}

func TestTestCaseZipBounds(t *testing.T) {
	for _, tc := range []struct {
		name       string
		entries    int
		unpacked   uint64
		wantReason string
	}{
		{"entry count", maxFileCount + 1, 0, "too many files"},
		{"declared unpacked bytes", 1, maxExtractedSize + 1, "total uncompressed size exceeds"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fixture.zip")
			file, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			writer := zip.NewWriter(file)
			for i := 1; i <= tc.entries; i++ {
				if _, err := writer.CreateRaw(&zip.FileHeader{Name: fmt.Sprintf("%d.in", i), UncompressedSize64: tc.unpacked}); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			_, err = validateTestCaseZip(path)
			if err == nil || !strings.Contains(err.Error(), tc.wantReason) {
				t.Fatalf("archive validation = %v, want %q", err, tc.wantReason)
			}
		})
	}
}
