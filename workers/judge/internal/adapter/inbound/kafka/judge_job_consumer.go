package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"go-judge-system/pkg/config"
	"go-judge-system/pkg/judge"
	"go-judge-system/workers/judge/internal/application/port/inbound"

	"github.com/IBM/sarama"
	"go.uber.org/zap"
)

const (
	defaultMaxRetries    = 3
	defaultRetryBaseWait = 500 * time.Millisecond
)

type JudgeJobConsumer struct {
	group        sarama.ConsumerGroup
	topic        string
	useCase      inbound.ProcessJudgeJobUseCase
	dltPublisher *DLTPublisher
	maxRetries   int
	jobSlots     chan struct{}
	logger       *zap.Logger
}

func NewJudgeJobConsumer(
	group sarama.ConsumerGroup,
	kafkaCfg config.KafkaConfig,
	useCase inbound.ProcessJudgeJobUseCase,
	dltPublisher *DLTPublisher,
	logger *zap.Logger,
) *JudgeJobConsumer {
	topic := strings.TrimSpace(kafkaCfg.JobTopic)
	if topic == "" {
		topic = "judge.submission.jobs"
	}

	poolSize := 4
	if psStr := os.Getenv("WORKER_POOL_SIZE"); psStr != "" {
		if ps, err := strconv.Atoi(psStr); err == nil && ps > 0 {
			poolSize = ps
		}
	}

	return &JudgeJobConsumer{
		group:        group,
		topic:        topic,
		useCase:      useCase,
		dltPublisher: dltPublisher,
		maxRetries:   defaultMaxRetries,
		jobSlots:     make(chan struct{}, poolSize),
		logger:       logger,
	}
}

func (c *JudgeJobConsumer) JobSettings() (topic string, poolSize int) {
	return c.topic, cap(c.jobSlots)
}

func (c *JudgeJobConsumer) Run(ctx context.Context) error {
	handler := &judgeJobHandler{
		useCase:      c.useCase,
		dltPublisher: c.dltPublisher,
		maxRetries:   c.maxRetries,
		jobSlots:     c.jobSlots,
		logger:       c.logger,
	}

	for {
		if err := c.group.Consume(ctx, []string{c.topic}, handler); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}

		if ctx.Err() != nil {
			return nil
		}
	}
}

func (c *JudgeJobConsumer) Close() error {
	if c.group == nil {
		return nil
	}
	return c.group.Close()
}

// -------------------------------------------------------------------
// Handler
// -------------------------------------------------------------------

type judgeJobHandler struct {
	useCase      inbound.ProcessJudgeJobUseCase
	dltPublisher *DLTPublisher
	maxRetries   int
	jobSlots     chan struct{}
	logger       *zap.Logger
}

func (h *judgeJobHandler) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (h *judgeJobHandler) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }

func (h *judgeJobHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	ctx := session.Context()
	for {
		select {
		case <-ctx.Done():
			return nil
		case msg, ok := <-claim.Messages():
			if !ok || ctx.Err() != nil {
				return nil
			}
			// Kafka commits a position per partition. Sarama runs claims
			// concurrently, but each claim must acknowledge offsets in order.
			if err := h.handleMessage(session, msg); err != nil {
				if ctx.Err() == nil {
					h.logger.Error("judge partition blocked by failed DLT write; restore DLT and restart Worker",
						zap.String("topic", msg.Topic), zap.Int32("partition", msg.Partition),
						zap.Int64("offset", msg.Offset), zap.Error(err))
				}
				// Returning early would end the session and start a new
				// delivery loop. Keep the claim idle until shutdown or rebalance.
				<-ctx.Done()
				return nil
			}
		}
	}
}

func (h *judgeJobHandler) handleMessage(session sarama.ConsumerGroupSession, msg *sarama.ConsumerMessage) error {
	ctx := session.Context()
	if !h.acquireJobSlot(ctx) {
		h.logger.Debug("judge job skipped because consumer session was cancelled before execution",
			zap.Int64("offset", msg.Offset),
		)
		return nil
	}
	defer h.releaseJobSlot()
	if ctx.Err() != nil {
		return nil
	}

	// 1. Decode payload
	var payload judge.JobMessage
	if err := json.Unmarshal(msg.Value, &payload); err != nil {
		h.logger.Error("invalid judge job message — forwarding to DLT",
			zap.Int64("offset", msg.Offset),
			zap.Error(err),
		)
		return h.forwardToDLT(session, msg, err, 0, "invalid_payload_dlt")
	}

	// 2. Retry with exponential backoff
	var lastErr error
	for attempt := 1; attempt <= h.maxRetries; attempt++ {
		lastErr = h.useCase.Execute(ctx, &payload)

		// If context is cancelled (shutdown), stop retrying immediately
		if ctx.Err() != nil {
			h.logger.Warn("context cancelled during retry, not committing offset",
				zap.Int64("submission_id", payload.SubmissionID),
				zap.Int("attempt", attempt),
			)
			return nil
		}
		if lastErr == nil {
			session.MarkMessage(msg, "processed")
			return nil
		}

		h.logger.Warn("judge job processing failed, retrying",
			zap.Int64("submission_id", payload.SubmissionID),
			zap.String("attempt_id", payload.AttemptID),
			zap.Int("attempt", attempt),
			zap.Int("max_retries", h.maxRetries),
			zap.Error(lastErr),
		)

		if attempt < h.maxRetries {
			backoff := defaultRetryBaseWait * time.Duration(1<<(attempt-1)) // 500ms, 1s, 2s
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil
			}
		}
	}

	// 3. Max retries exhausted → send to DLT
	h.logger.Error("judge job exceeded max retries — forwarding to DLT",
		zap.Int64("submission_id", payload.SubmissionID),
		zap.String("attempt_id", payload.AttemptID),
		zap.Int("max_retries", h.maxRetries),
		zap.Error(lastErr),
	)
	return h.forwardToDLT(session, msg, lastErr, h.maxRetries, "dlt_forwarded")
}

func (h *judgeJobHandler) acquireJobSlot(ctx context.Context) bool {
	if h.jobSlots == nil {
		return ctx.Err() == nil
	}

	select {
	case h.jobSlots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (h *judgeJobHandler) releaseJobSlot() {
	if h.jobSlots != nil {
		<-h.jobSlots
	}
}

func (h *judgeJobHandler) forwardToDLT(session sarama.ConsumerGroupSession, msg *sarama.ConsumerMessage, cause error, retries int, metadata string) error {
	if h.dltPublisher == nil {
		return fmt.Errorf("DLT publisher not configured: %w", cause)
	}
	if err := h.dltPublisher.Publish(session.Context(), msg, cause.Error(), retries); err != nil {
		return fmt.Errorf("forward judge job to DLT: %w", errors.Join(cause, err))
	}
	if session.Context().Err() == nil {
		session.MarkMessage(msg, metadata)
	}
	return nil
}
