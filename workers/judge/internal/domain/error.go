package domain

import (
	"errors"
	"fmt"

	"go-judge-system/pkg/judge"
)

var (
	ErrJobNotFound       = errors.New("job not found")
	ErrInvalidLanguage   = errors.New("invalid programming language")
	ErrExecutionTimeout  = errors.New("execution timeout")
	ErrGoJudgeConnection = errors.New("cannot connect to go-judge")
	ErrInvalidJobMessage = errors.New("invalid job message format")
)

type nonRetryableError struct {
	err error
}

func (e nonRetryableError) Error() string {
	return e.err.Error()
}

func (e nonRetryableError) Unwrap() error {
	return e.err
}

func MarkNonRetryable(err error) error {
	if err == nil {
		return nil
	}
	if IsNonRetryable(err) {
		return err
	}
	return nonRetryableError{err: err}
}

func IsNonRetryable(err error) bool {
	var target nonRetryableError
	return errors.As(err, &target)
}

func ValidateOfficialExecutionLimits(timeLimitMS, memoryLimitKB int64) error {
	// An older Problem Service omits these scalar fields, which decode as zero.
	if timeLimitMS == 0 || memoryLimitKB == 0 {
		return errors.New("problem-service did not provide both official execution limits")
	}
	if !judge.ValidExecutionLimits(timeLimitMS, memoryLimitKB) {
		return MarkNonRetryable(fmt.Errorf(
			"invalid official execution limits: time_limit_ms=%d memory_limit_kb=%d",
			timeLimitMS, memoryLimitKB,
		))
	}
	return nil
}
