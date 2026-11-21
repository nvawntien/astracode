package testcase

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"

	"go-judge-system/pkg/judge"
	"go-judge-system/services/problem/internal/application/port/outbound"
)

var managedObjectKey = regexp.MustCompile(`^problems/[1-9][0-9]*/testcases/(v[1-9][0-9]*|[a-z2-7]{26,})\.zip$`)

// ReconcileObjects expects the operator to maintain quiescence for the entire call.
// A nil reviewed list produces a dry run. A nonnil list permits exact-key cleanup.
func ReconcileObjects(ctx context.Context, refs outbound.TestCaseObjectReferences, storage outbound.TestCaseStorage, now, quiescedAt time.Time, maxClockSkew time.Duration, reviewed []string) ([]string, error) {
	retention := judge.TestcaseDownloadURLLifetime + judge.TestcaseDownloadTimeout
	elapsed := now.Sub(quiescedAt)
	if maxClockSkew < 0 || quiescedAt.IsZero() || elapsed < retention || elapsed-retention < maxClockSkew {
		return nil, errors.New("testcase download retention window has not been established")
	}
	for _, key := range reviewed {
		if !managedObjectKey.MatchString(key) {
			return nil, fmt.Errorf("reviewed key is outside the managed testcase namespace: %q", key)
		}
	}

	references, err := refs.ListAllZipObjectKeys(ctx)
	if err != nil {
		return nil, fmt.Errorf("list testcase references: %w", err)
	}
	keys, err := storage.ListTestCasesByPrefix(ctx, "problems/")
	if err != nil {
		return nil, fmt.Errorf("list testcase objects: %w", err)
	}
	candidates := make([]string, 0)
	referenceSet := make(map[string]bool, len(references))
	for _, key := range references {
		referenceSet[key] = true
	}
	for _, key := range keys {
		if managedObjectKey.MatchString(key) && !referenceSet[key] {
			candidates = append(candidates, key)
		}
	}
	slices.Sort(candidates)
	if reviewed == nil {
		return candidates, nil
	}

	references, err = refs.ListAllZipObjectKeys(ctx)
	if err != nil {
		return nil, fmt.Errorf("refresh testcase references: %w", err)
	}
	for _, key := range references {
		referenceSet[key] = true
	}
	sortedReviewed := slices.Clone(reviewed)
	slices.Sort(sortedReviewed)
	var failures []error
	for _, key := range slices.Compact(sortedReviewed) {
		if referenceSet[key] {
			continue
		}
		if _, found := slices.BinarySearch(candidates, key); !found {
			continue
		}
		if err := storage.DeleteTestCase(ctx, key); err != nil {
			failures = append(failures, fmt.Errorf("remove testcase object %q: %w", key, err))
		}
	}
	return candidates, errors.Join(failures...)
}
