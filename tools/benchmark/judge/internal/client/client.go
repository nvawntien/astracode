// Package client implements the public AstraCode HTTP contract used by the
// benchmark. Submission POST is deliberately a single-attempt operation.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/credentials"
)

const maxResponseBytes = 1 << 20

var errResponseBodyRead = errors.New("response body read failed")

type API struct {
	BaseURL     *url.URL
	Session     *credentials.Session
	Diagnostics *Diagnostics // retained for callers using one transport domain
	control     domainClient
	submission  domainClient
	ticket      domainClient
	sse         domainClient
}

// Domain identifies an intentionally isolated HTTP transport domain. Cookie
// jars remain session-scoped; only connection pools are separated.
type Domain string

const (
	DomainControl    Domain = "control"
	DomainSubmission Domain = "submission"
	DomainTicket     Domain = "ticket"
	DomainSSE        Domain = "sse"
)

type domainClient struct {
	client      *http.Client
	diagnostics *Diagnostics
}

// DomainClients supplies the four clients for one logical identity. Each may
// use a different shared transport but must use the same identity cookie jar.
type DomainClients struct {
	Control               *http.Client
	Submission            *http.Client
	Ticket                *http.Client
	SSE                   *http.Client
	ControlDiagnostics    *Diagnostics
	SubmissionDiagnostics *Diagnostics
	TicketDiagnostics     *Diagnostics
	SSEDiagnostics        *Diagnostics
}

// Diagnostics is shared by APIs in one benchmark run. It records only local
// transport behavior, never request bodies, cookies, or target identifiers.
type Diagnostics struct {
	newConnections    atomic.Uint64
	reusedConnections atomic.Uint64
	http1             atomic.Uint64
	http2             atomic.Uint64
	otherProtocol     atomic.Uint64
	active            atomic.Int64
	peakActive        atomic.Int64
	timingMu          sync.Mutex
	connectionAcquire []float64
	dispatch          []float64
}

type DiagnosticsSnapshot struct {
	NewConnections         uint64
	ReusedConnections      uint64
	HTTP1Responses         uint64
	HTTP2Responses         uint64
	OtherProtocolResponses uint64
	ActiveRequests         int
	PeakActiveRequests     int
	ConnectionAcquireMS    []float64
	DispatchMS             []float64
}

func (d *Diagnostics) Snapshot() DiagnosticsSnapshot {
	if d == nil {
		return DiagnosticsSnapshot{}
	}
	d.timingMu.Lock()
	connectionAcquire := append([]float64(nil), d.connectionAcquire...)
	dispatch := append([]float64(nil), d.dispatch...)
	d.timingMu.Unlock()
	return DiagnosticsSnapshot{NewConnections: d.newConnections.Load(), ReusedConnections: d.reusedConnections.Load(), HTTP1Responses: d.http1.Load(), HTTP2Responses: d.http2.Load(), OtherProtocolResponses: d.otherProtocol.Load(), ActiveRequests: int(d.active.Load()), PeakActiveRequests: int(d.peakActive.Load()), ConnectionAcquireMS: connectionAcquire, DispatchMS: dispatch}
}

func (d *Diagnostics) begin() func() {
	if d == nil {
		return func() {}
	}
	active := d.active.Add(1)
	for {
		peak := d.peakActive.Load()
		if active <= peak || d.peakActive.CompareAndSwap(peak, active) {
			break
		}
	}
	return func() { d.active.Add(-1) }
}

func (d *Diagnostics) recordTiming(start time.Time, timing requestTiming) {
	if d == nil {
		return
	}
	d.timingMu.Lock()
	if timing.gotConnAt != nil {
		d.connectionAcquire = append(d.connectionAcquire, timing.gotConnAt.Sub(start).Seconds()*1000)
	}
	if timing.wroteRequestAt != nil {
		d.dispatch = append(d.dispatch, timing.wroteRequestAt.Sub(start).Seconds()*1000)
	}
	d.timingMu.Unlock()
}

type Envelope struct {
	Status string          `json:"status"`
	Code   int             `json:"code"`
	Msg    string          `json:"msg"`
	Data   json.RawMessage `json:"data"`
}

type Me struct {
	ID       string `json:"id"`
	Role     string `json:"role"`
	IsActive bool   `json:"is_active"`
}

type Problem struct {
	ID int64 `json:"id"`
}

type SubmissionRequest struct {
	ProblemID  int64  `json:"problem_id"`
	Language   string `json:"language"`
	SourceCode string `json:"source_code"`
}

type Submission struct {
	ID        int64  `json:"id"`
	ProblemID int64  `json:"problem_id"`
	Language  string `json:"language"`
	Status    string `json:"status"`
}

type SubmissionDetail struct {
	ID        int64  `json:"id"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at"`
}

type Ticket struct {
	Value     string `json:"ticket"`
	ExpiresAt string `json:"expires_at"`
}

type SubmitKind string

const (
	SubmitAccepted  SubmitKind = "accepted"
	SubmitRateLimit SubmitKind = "rate_limited"
	Submit4xx       SubmitKind = "client_error"
	Submit5xx       SubmitKind = "server_error"
)

type SubmitResult struct {
	Kind            SubmitKind
	HTTPStatus      int
	APICode         int
	Submission      *Submission
	RetryAfter      *time.Duration
	Message         string
	Protocol        string
	GotConnAt       *time.Time
	WroteRequestAt  *time.Time
	FirstResponseAt *time.Time
}

// RefreshResult exposes only the HTTP facts needed by the operator-only
// session preparation command. It never includes response bodies or cookies.
type RefreshResult struct {
	HTTPStatus       int
	APICode          int
	RetryAfter       *time.Duration
	Protocol         string
	ResponseReadFail bool
}

// TransportError is ambiguous: the server may have received the POST. Callers
// must record and quarantine it, never retry it automatically.
type TransportError struct{ Err error }

func (e *TransportError) Error() string { return "ambiguous submission transport failure" }
func (e *TransportError) Unwrap() error { return e.Err }

// StreamTransportError preserves an inspectable underlying local transport
// error while keeping its public text free of the one-time ticket URL.
type StreamTransportError struct{ Err error }

func (e *StreamTransportError) Error() string { return "SSE connection failed" }
func (e *StreamTransportError) Unwrap() error { return e.Err }

// TransportErrorClass keeps generator-capacity failures distinct from an
// ambiguous remote POST outcome. It never exposes endpoint/cookie details.
func TransportErrorClass(err error) string {
	switch {
	case errors.Is(err, syscall.EMFILE):
		return "client_emfile"
	case errors.Is(err, syscall.ENFILE):
		return "client_enfile"
	case errors.Is(err, syscall.EADDRNOTAVAIL):
		return "client_ephemeral_port_exhaustion"
	case errors.Is(err, context.DeadlineExceeded):
		return "transport_deadline"
	case errors.Is(err, context.Canceled):
		return "transport_cancelled"
	default:
		return "ambiguous_post"
	}
}

func New(base *url.URL, session *credentials.Session) (*API, error) {
	return NewWithDiagnostics(base, session, nil)
}

func NewWithDiagnostics(base *url.URL, session *credentials.Session, diagnostics *Diagnostics) (*API, error) {
	if base == nil || session == nil || session.Client == nil {
		return nil, errors.New("base URL and isolated session are required")
	}
	return NewWithDomainClients(base, session, DomainClients{Control: session.Client, Submission: session.Client, Ticket: session.Client, SSE: session.Client, ControlDiagnostics: diagnostics, SubmissionDiagnostics: diagnostics, TicketDiagnostics: diagnostics, SSEDiagnostics: diagnostics})
}

// NewWithDomainClients constructs an API with isolated connection-pool
// domains. It never shares a cookie jar between sessions: every supplied
// client is expected to be created for this session's jar.
func NewWithDomainClients(base *url.URL, session *credentials.Session, clients DomainClients) (*API, error) {
	if base == nil || session == nil || clients.Control == nil || clients.Submission == nil || clients.Ticket == nil || clients.SSE == nil {
		return nil, errors.New("base URL, isolated session, and all transport domains are required")
	}
	return &API{BaseURL: base, Session: session, Diagnostics: clients.ControlDiagnostics, control: domainClient{clients.Control, clients.ControlDiagnostics}, submission: domainClient{clients.Submission, clients.SubmissionDiagnostics}, ticket: domainClient{clients.Ticket, clients.TicketDiagnostics}, sse: domainClient{clients.SSE, clients.SSEDiagnostics}}, nil
}

func (a *API) Me(ctx context.Context) (Me, error) {
	var data Me
	_, err := a.doJSON(ctx, http.MethodGet, "/api/v1/me", nil, &data)
	return data, err
}

func (a *API) PublicProblem(ctx context.Context, slug string) (Problem, error) {
	var data Problem
	_, err := a.doJSON(ctx, http.MethodGet, "/api/v1/problems/"+url.PathEscape(slug), nil, &data)
	return data, err
}

func (a *API) Refresh(ctx context.Context) error {
	_, err := a.RefreshDetailed(ctx)
	return err
}

// RefreshDetailed performs exactly one public Auth refresh request. Its
// caller owns retry policy because refresh is retryable under the current
// Auth contract, unlike submission creation.
func (a *API) RefreshDetailed(ctx context.Context) (RefreshResult, error) {
	response, err := a.request(ctx, http.MethodPost, "/api/v1/auth/refresh-token", nil, "application/json")
	if err != nil {
		return RefreshResult{}, err
	}
	defer response.Body.Close()
	result := RefreshResult{HTTPStatus: response.StatusCode, Protocol: response.Proto}
	if retryAfter, ok := parseRetryAfter(response.Header.Get("Retry-After")); ok {
		result.RetryAfter = &retryAfter
	}
	envelope, err := readEnvelope(response)
	if err != nil {
		result.ResponseReadFail = errors.Is(err, errResponseBodyRead)
		return result, err
	}
	result.APICode = envelope.Code
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices || envelope.Status != "success" {
		return result, fmt.Errorf("API request returned HTTP %d code %d", response.StatusCode, envelope.Code)
	}
	return result, nil
}

// Submit makes exactly one HTTP request. It intentionally exposes ambiguous
// transport failures instead of hiding them behind a retry.
func (a *API) Submit(ctx context.Context, request SubmissionRequest) (SubmitResult, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return SubmitResult{}, fmt.Errorf("marshal submission request: %w", err)
	}
	timing := requestTiming{}
	response, err := a.requestWithTiming(ctx, a.submission, http.MethodPost, "/api/v1/submissions", bytes.NewReader(body), "application/json", &timing)
	result := SubmitResult{GotConnAt: timing.gotConnAt, WroteRequestAt: timing.wroteRequestAt, FirstResponseAt: timing.firstResponseAt}
	if err != nil {
		return result, &TransportError{Err: err}
	}
	defer response.Body.Close()
	envelope, err := readEnvelope(response)
	if err != nil {
		result.Kind, result.HTTPStatus = Submit5xx, response.StatusCode
		return result, &TransportError{Err: err}
	}
	result.HTTPStatus, result.APICode, result.Message, result.Protocol = response.StatusCode, envelope.Code, safeMessage(envelope.Msg), response.Proto
	switch {
	case response.StatusCode == http.StatusCreated:
		var submission Submission
		if envelope.Status != "success" || envelope.Code != 20100 || json.Unmarshal(envelope.Data, &submission) != nil || submission.ID <= 0 {
			return result, &TransportError{Err: errors.New("malformed HTTP 201 submission envelope")}
		}
		result.Kind = SubmitAccepted
		result.Submission = &submission
		return result, nil
	case response.StatusCode == http.StatusTooManyRequests:
		result.Kind = SubmitRateLimit
		if retryAfter, ok := parseRetryAfter(response.Header.Get("Retry-After")); ok {
			result.RetryAfter = &retryAfter
		}
		return result, nil
	case response.StatusCode >= 400 && response.StatusCode < 500:
		result.Kind = Submit4xx
		return result, nil
	default:
		result.Kind = Submit5xx
		return result, nil
	}
}

func (a *API) IssueTicket(ctx context.Context, submissionID int64) (Ticket, error) {
	var data Ticket
	_, err := a.doJSONWithDomain(ctx, a.ticket, http.MethodPost, fmt.Sprintf("/api/v1/submissions/%d/events/ticket", submissionID), nil, &data)
	if err == nil && data.Value == "" {
		err = errors.New("ticket response contains no ticket")
	}
	return data, err
}

func (a *API) GetSubmission(ctx context.Context, submissionID int64) (SubmissionDetail, error) {
	var data SubmissionDetail
	_, err := a.doJSON(ctx, http.MethodGet, fmt.Sprintf("/api/v1/submissions/%d", submissionID), nil, &data)
	if err == nil && data.ID != submissionID {
		err = errors.New("submission detail ID mismatch")
	}
	return data, err
}

// Prewarm performs a non-mutating public GET through one transport domain.
// It is always outside the measured release and never creates benchmark state.
func (a *API) Prewarm(ctx context.Context, domain Domain, slug string) (string, error) {
	selected := a.control
	switch domain {
	case DomainControl:
	case DomainSubmission:
		selected = a.submission
	case DomainTicket:
		selected = a.ticket
	case DomainSSE:
		selected = a.sse
	default:
		return "", errors.New("unknown transport domain")
	}
	response, err := a.requestWithTiming(ctx, selected, http.MethodGet, "/api/v1/problems/"+url.PathEscape(slug), nil, "", nil)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return response.Proto, fmt.Errorf("prewarm returned HTTP %d", response.StatusCode)
	}
	_, err = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
	return response.Proto, err
}

// OpenEvents returns a stream response. The ticket query must never be logged
// or persisted by callers.
func (a *API) OpenEvents(ctx context.Context, submissionID int64, ticket string) (*http.Response, error) {
	path := fmt.Sprintf("/events/submissions/%d", submissionID)
	u := a.resolve(path)
	query := u.Query()
	query.Set("ticket", ticket)
	u.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/event-stream")
	start := time.Now()
	timing := requestTiming{}
	if a.sse.diagnostics != nil {
		request = request.WithContext(httptrace.WithClientTrace(request.Context(), a.clientTrace(a.sse.diagnostics, &timing)))
	}
	done := a.sse.diagnostics.begin()
	response, err := a.sse.client.Do(request)
	a.sse.diagnostics.recordTiming(start, timing)
	if err != nil {
		done()
		// The URL embeds a one-time ticket. Never surface a transport error that
		// might include the full request URL through net/http formatting.
		return nil, &StreamTransportError{Err: err}
	}
	a.trackResponseWith(a.sse.diagnostics, response)
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		done()
		response.Body.Close()
		return nil, fmt.Errorf("SSE endpoint returned HTTP %d", response.StatusCode)
	}
	response.Body = &trackedBody{ReadCloser: response.Body, done: done}
	return response, nil
}

func (a *API) doJSON(ctx context.Context, method, path string, body io.Reader, output any) (Envelope, error) {
	return a.doJSONWithDomain(ctx, a.control, method, path, body, output)
}

func (a *API) doJSONWithDomain(ctx context.Context, domain domainClient, method, path string, body io.Reader, output any) (Envelope, error) {
	response, err := a.requestWithTiming(ctx, domain, method, path, body, "application/json", nil)
	if err != nil {
		return Envelope{}, err
	}
	defer response.Body.Close()
	envelope, err := readEnvelope(response)
	if err != nil {
		return Envelope{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || envelope.Status != "success" {
		return envelope, fmt.Errorf("API request returned HTTP %d code %d", response.StatusCode, envelope.Code)
	}
	if output != nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		if err := json.Unmarshal(envelope.Data, output); err != nil {
			return envelope, fmt.Errorf("decode API response: %w", err)
		}
	}
	return envelope, nil
}

func (a *API) request(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	return a.requestWithTiming(ctx, a.control, method, path, body, contentType, nil)
}

type requestTiming struct {
	gotConnAt       *time.Time
	wroteRequestAt  *time.Time
	firstResponseAt *time.Time
}

func (a *API) requestWithTiming(ctx context.Context, domain domainClient, method, path string, body io.Reader, contentType string, timing *requestTiming) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, a.resolve(path).String(), body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("Accept", "application/json")
	traceTiming := timing
	if traceTiming == nil {
		traceTiming = &requestTiming{}
	}
	if domain.diagnostics != nil || timing != nil {
		request = request.WithContext(httptrace.WithClientTrace(request.Context(), a.clientTrace(domain.diagnostics, traceTiming)))
	}
	start := time.Now()
	done := domain.diagnostics.begin()
	response, err := domain.client.Do(request)
	done()
	domain.diagnostics.recordTiming(start, dereferenceTiming(traceTiming))
	a.trackResponseWith(domain.diagnostics, response)
	return response, err
}

func dereferenceTiming(timing *requestTiming) requestTiming {
	if timing == nil {
		return requestTiming{}
	}
	return *timing
}

func (a *API) clientTrace(diagnostics *Diagnostics, timing *requestTiming) *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			at := time.Now()
			if timing != nil {
				timing.gotConnAt = &at
			}
			if diagnostics == nil {
				return
			}
			if info.Reused {
				diagnostics.reusedConnections.Add(1)
			} else {
				diagnostics.newConnections.Add(1)
			}
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {
			if timing == nil {
				return
			}
			at := time.Now()
			timing.wroteRequestAt = &at
		},
		GotFirstResponseByte: func() {
			if timing == nil {
				return
			}
			at := time.Now()
			timing.firstResponseAt = &at
		},
	}
}

func (a *API) trackResponse(response *http.Response) {
	a.trackResponseWith(a.Diagnostics, response)
}

func (a *API) trackResponseWith(diagnostics *Diagnostics, response *http.Response) {
	if response == nil || diagnostics == nil {
		return
	}
	switch response.ProtoMajor {
	case 1:
		diagnostics.http1.Add(1)
	case 2:
		diagnostics.http2.Add(1)
	default:
		diagnostics.otherProtocol.Add(1)
	}
}

type trackedBody struct {
	io.ReadCloser
	once sync.Once
	done func()
}

func (b *trackedBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(b.done)
	return err
}

func (a *API) resolve(path string) *url.URL {
	u := *a.BaseURL
	u.Path = strings.TrimSuffix(a.BaseURL.Path, "/") + path
	u.RawQuery = ""
	u.Fragment = ""
	return &u
}

func readEnvelope(response *http.Response) (Envelope, error) {
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return Envelope{}, fmt.Errorf("read HTTP %d API response: %w", response.StatusCode, errResponseBodyRead)
	}
	if len(data) > maxResponseBytes {
		return Envelope{}, fmt.Errorf("HTTP %d API response exceeds size limit", response.StatusCode)
	}
	if len(data) == 0 {
		return Envelope{}, fmt.Errorf("HTTP %d API response is empty", response.StatusCode)
	}
	var envelope Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Envelope{}, fmt.Errorf("HTTP %d API response contains invalid JSON", response.StatusCode)
	}
	return envelope, nil
}

func parseRetryAfter(raw string) (time.Duration, bool) {
	raw = strings.TrimSpace(raw)
	if seconds, err := strconv.ParseInt(raw, 10, 64); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second, true
	}
	when, err := http.ParseTime(raw)
	if err != nil {
		return 0, false
	}
	delay := time.Until(when)
	if delay < 0 {
		delay = 0
	}
	return delay, true
}

func safeMessage(message string) string {
	message = strings.ReplaceAll(message, "\n", " ")
	message = strings.TrimSpace(message)
	if len(message) > 256 {
		return message[:256]
	}
	return message
}
