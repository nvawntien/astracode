package postgres

import (
	"context"
	"fmt"

	"go-judge-system/services/submission/internal/application/port/outbound"
	"go-judge-system/services/submission/internal/domain"
	"go-judge-system/services/submission/internal/domain/entity"

	"gorm.io/gorm"
)

func NewCurrentSubmissionDetailRepository(db *gorm.DB) outbound.CurrentSubmissionDetailRepository {
	return &submissionRepository{db: db}
}

func (r *submissionRepository) GetCurrentDetail(
	ctx context.Context, id int64, ownerID *string,
) (*entity.Submission, outbound.SubmissionResultSummary, error) {
	var row struct {
		SubmissionDAO
		PassedCount int
		TotalCount  int
	}
	// The lateral aggregate reads only the attempt selected by this statement.
	// Exact equality preserves the former summary behavior for legacy IDs.
	query := getDB(ctx, r.db).
		Table("submissions AS s").
		Select("s.*, summary.passed_count, summary.total_count").
		Joins(`LEFT JOIN LATERAL (
			SELECT COUNT(*) FILTER (WHERE r.status = ?) AS passed_count,
			       COUNT(*) AS total_count
			FROM submission_results AS r
			WHERE r.submission_id = s.id AND r.attempt_id = s.current_attempt_id
		) AS summary ON TRUE`, string(entity.ResultAccepted)).
		Where("s.id = ?", id)
	if ownerID != nil {
		query = query.Where("s.user_id = ?", *ownerID)
	}

	result := query.Find(&row)
	if result.Error != nil {
		return nil, outbound.SubmissionResultSummary{}, fmt.Errorf("get current submission detail %d: %w", id, result.Error)
	}
	if result.RowsAffected == 0 {
		return nil, outbound.SubmissionResultSummary{}, domain.ErrSubmissionNotFound
	}
	return toSubmissionEntity(&row.SubmissionDAO), outbound.SubmissionResultSummary{
		SubmissionID: row.ID,
		Passed:       row.PassedCount,
		Total:        row.TotalCount,
	}, nil
}
