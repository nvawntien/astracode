package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"go-judge-system/pkg/config"
	pkgjudge "go-judge-system/pkg/judge"

	"github.com/IBM/sarama"
	"go.uber.org/zap"
)

type fakeProcessJudgeJobUseCase struct {
	got *pkgjudge.JobMessage
}

func (f *fakeProcessJudgeJobUseCase) Execute(_ context.Context, job *pkgjudge.JobMessage) error {
	cp := *job
	f.got = &cp
	return nil
}

type fakeConsumerGroupSession struct {
	ctx      context.Context
	mu       sync.Mutex
	marked   bool
	metadata string
}

func (f *fakeConsumerGroupSession) Claims() map[string][]int32 { return nil }
func (f *fakeConsumerGroupSession) MemberID() string           { return "member-1" }
func (f *fakeConsumerGroupSession) GenerationID() int32        { return 1 }
func (f *fakeConsumerGroupSession) MarkOffset(string, int32, int64, string) {
}
func (f *fakeConsumerGroupSession) Commit() {}
func (f *fakeConsumerGroupSession) ResetOffset(string, int32, int64, string) {
}
func (f *fakeConsumerGroupSession) MarkMessage(_ *sarama.ConsumerMessage, metadata string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.marked = true
	f.metadata = metadata
}
func (f *fakeConsumerGroupSession) Context() context.Context {
	if f.ctx == nil {
		return context.Background()
	}
	return f.ctx
}

func TestJudgeJobHandlerDecodesCallsUseCaseAndMarksMessage(t *testing.T) {
	t.Parallel()

	payload := pkgjudge.JobMessage{
		SubmissionID: 99,
		ProblemID:    42,
		AttemptID:    "attempt-a",
		Language:     "GO",
		SourceCode:   "package main\nfunc main(){}",
	}
	value, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	useCase := &fakeProcessJudgeJobUseCase{}
	session := &fakeConsumerGroupSession{}
	handler := &judgeJobHandler{
		useCase:    useCase,
		maxRetries: 1,
		logger:     zap.NewNop(),
	}
	handler.handleMessage(session, &sarama.ConsumerMessage{Value: value})

	if useCase.got == nil || useCase.got.SubmissionID != 99 || useCase.got.AttemptID != "attempt-a" {
		t.Fatalf("use case payload = %#v", useCase.got)
	}
	if !session.marked || session.metadata != "processed" {
		t.Fatalf("mark = %v/%q, want processed", session.marked, session.metadata)
	}
}

type blockingProcessJudgeJobUseCase struct {
	started chan struct{}
	release chan struct{}
	active  atomic.Int32
	max     atomic.Int32
}

func (f *blockingProcessJudgeJobUseCase) Execute(context.Context, *pkgjudge.JobMessage) error {
	active := f.active.Add(1)
	for {
		currentMax := f.max.Load()
		if active <= currentMax || f.max.CompareAndSwap(currentMax, active) {
			break
		}
	}
	f.started <- struct{}{}
	<-f.release
	f.active.Add(-1)
	return nil
}

func TestJudgeJobHandlerSharesConcurrencyLimitAcrossClaims(t *testing.T) {
	payload, err := json.Marshal(pkgjudge.JobMessage{SubmissionID: 99, ProblemID: 42, AttemptID: "attempt-a", Language: "GO", SourceCode: "package main"})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	useCase := &blockingProcessJudgeJobUseCase{
		started: make(chan struct{}, 2),
		release: make(chan struct{}, 2),
	}
	jobSlots := make(chan struct{}, 1)
	newHandler := func() *judgeJobHandler {
		return &judgeJobHandler{useCase: useCase, maxRetries: 1, jobSlots: jobSlots, logger: zap.NewNop()}
	}
	session := &fakeConsumerGroupSession{}

	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		newHandler().handleMessage(session, &sarama.ConsumerMessage{Value: payload})
	}()
	<-useCase.started

	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		newHandler().handleMessage(session, &sarama.ConsumerMessage{Value: payload})
	}()

	select {
	case <-useCase.started:
		t.Fatal("second claim started work before the shared slot was released")
	case <-time.After(50 * time.Millisecond):
	}

	useCase.release <- struct{}{}
	<-firstDone
	<-useCase.started
	useCase.release <- struct{}{}
	<-secondDone

	if got := useCase.max.Load(); got != 1 {
		t.Fatalf("max concurrent jobs = %d, want 1", got)
	}
}

type processJudgeJobFunc func(context.Context, *pkgjudge.JobMessage) error

func (f processJudgeJobFunc) Execute(ctx context.Context, job *pkgjudge.JobMessage) error {
	return f(ctx, job)
}

type syncProducerFunc struct {
	sarama.SyncProducer
	send func(*sarama.ProducerMessage) (int32, int64, error)
}

func (p syncProducerFunc) SendMessage(msg *sarama.ProducerMessage) (int32, int64, error) {
	return p.send(msg)
}

func TestJudgeJobDLTAcknowledgement(t *testing.T) {
	for _, tt := range []struct {
		name, value, wantMark                                      string
		fail, missing, cancelDuringProcessing, cancelDuringPublish bool
	}{
		{name: "exhaustion delivered", value: `{"submission_id":7}`, wantMark: "dlt_forwarded"},
		{name: "exhaustion interrupted", value: `{"submission_id":7}`, cancelDuringProcessing: true},
		{name: "exhaustion DLT unavailable", value: `{"submission_id":7}`, fail: true},
		{name: "nil publisher", value: `{"submission_id":7}`, missing: true},
		{name: "invalid JSON delivered", value: "{broken", wantMark: "invalid_payload_dlt"},
		{name: "invalid JSON DLT unavailable", value: "{broken", fail: true},
		{name: "invalid JSON nil publisher", value: "{broken", missing: true},
		{name: "cancelled during DLT send", value: `{"submission_id":7}`, cancelDuringPublish: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			session := &fakeConsumerGroupSession{ctx: ctx}
			sends := 0
			producer := syncProducerFunc{send: func(msg *sarama.ProducerMessage) (int32, int64, error) {
				sends++
				data, err := msg.Value.Encode()
				if err != nil {
					t.Fatal(err)
				}
				var record struct {
					OriginalValue json.RawMessage `json:"original_value"`
					Encoding      string          `json:"original_value_encoding"`
					Offset        int64           `json:"original_offset"`
				}
				if err := json.Unmarshal(data, &record); err != nil || record.Offset != 7 {
					t.Fatalf("bad DLT envelope: %+v %v", record, err)
				}
				if json.Valid([]byte(tt.value)) {
					if record.Encoding != "" || string(record.OriginalValue) != tt.value {
						t.Fatalf("valid payload changed: %+v", record)
					}
				} else {
					var decoded []byte
					if err := json.Unmarshal(record.OriginalValue, &decoded); err != nil || record.Encoding != "base64" || string(decoded) != tt.value {
						t.Fatalf("malformed bytes not recoverable: %+v %v", record, err)
					}
				}
				if tt.cancelDuringPublish {
					cancel()
				}
				if tt.fail {
					return 0, 0, sarama.ErrUnknownTopicOrPartition
				}
				return 0, 1, nil
			}}
			useCase := processJudgeJobFunc(func(context.Context, *pkgjudge.JobMessage) error {
				if tt.cancelDuringProcessing {
					cancel()
				}
				return errors.New("judging unavailable")
			})
			handler := &judgeJobHandler{useCase: useCase, maxRetries: 1, logger: zap.NewNop()}
			if !tt.missing {
				handler.dltPublisher = NewDLTPublisher(producer, config.KafkaConfig{}, zap.NewNop())
			}
			handler.handleMessage(session, &sarama.ConsumerMessage{Offset: 7, Value: []byte(tt.value)})
			if session.metadata != tt.wantMark || session.marked != (tt.wantMark != "") {
				t.Fatalf("offset marking = %v %q, want %q", session.marked, session.metadata, tt.wantMark)
			}
			wantSends := 1
			if tt.missing || tt.cancelDuringProcessing {
				wantSends = 0
			}
			if sends != wantSends {
				t.Fatalf("DLT sends = %d, want %d", sends, wantSends)
			}
		})
	}
}

type consumerClaim struct {
	sarama.ConsumerGroupClaim
	messages <-chan *sarama.ConsumerMessage
}

func (c consumerClaim) Messages() <-chan *sarama.ConsumerMessage { return c.messages }

func TestJudgeJobClaimStopsBeforeLaterOffsetsAfterDLTFailure(t *testing.T) {
	for _, pool := range []int{1, 4} {
		t.Run(fmt.Sprintf("pool-%d", pool), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var later atomic.Bool
				producer := syncProducerFunc{send: func(*sarama.ProducerMessage) (int32, int64, error) {
					return 0, 0, sarama.ErrUnknownTopicOrPartition
				}}
				cfg := config.KafkaConfig{}
				t.Setenv("WORKER_POOL_SIZE", strconv.Itoa(pool))
				consumer := NewJudgeJobConsumer(nil, cfg, processJudgeJobFunc(func(_ context.Context, job *pkgjudge.JobMessage) error {
					if job.SubmissionID == 8 {
						later.Store(true)
						return nil
					}
					return errors.New("judging unavailable")
				}), NewDLTPublisher(producer, cfg, zap.NewNop()), zap.NewNop())
				handler := &judgeJobHandler{useCase: consumer.useCase, dltPublisher: consumer.dltPublisher,
					jobSlots: consumer.jobSlots, maxRetries: 1, logger: zap.NewNop()}
				session := &fakeConsumerGroupSession{ctx: ctx}
				messages := make(chan *sarama.ConsumerMessage, 2)
				messages <- &sarama.ConsumerMessage{Offset: 7, Value: []byte(`{"submission_id":7}`)}
				messages <- &sarama.ConsumerMessage{Offset: 8, Value: []byte(`{"submission_id":8}`)}
				close(messages)
				done := make(chan struct{})
				go func() {
					defer close(done)
					_ = handler.ConsumeClaim(session, consumerClaim{messages: messages})
				}()
				synctest.Wait()
				if later.Load() || session.marked {
					t.Errorf("claim advanced after failed DLT: later=%t, marked=%q", later.Load(), session.metadata)
				}
				cancel()
				<-done
			})
		})
	}
}
