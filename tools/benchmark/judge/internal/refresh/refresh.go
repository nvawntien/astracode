// Package refresh prepares an existing benchmark credential pool before a
// measured run. It is intentionally separate from benchmark preflight.
package refresh

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/bootstrap"
	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/client"
	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/credentials"
)

const (
	DefaultConcurrency       = 128
	DefaultMaxAttempts       = 5
	DefaultRequestTimeout    = 10 * time.Second
	DefaultMinAccessValidity = 5 * time.Minute
	DefaultValidationSample  = 32
	maxConcurrency           = 4096
	maxAttempts              = 10
)

type Options struct {
	BaseURL           *url.URL
	AllowRemote       bool
	ConfirmTargetHost string
	Input             string
	Output            string
	Replace           bool
	UserCount         int
	Concurrency       int
	RequestTimeout    time.Duration
	MaxAttempts       int
	MinAccessValidFor time.Duration
	ValidationSample  int
	HTTPTransport     http.RoundTripper

	now   func() time.Time
	sleep func(context.Context, time.Duration) error
}

type Precheck struct {
	Valid     int
	Missing   int
	Malformed int
	Expired   int
	Earliest  time.Time
	Latest    time.Time
}

type Result struct {
	InputUsers       int
	Refreshed        int
	RefreshAttempts  int
	RetriedUsers     int
	Retries429       int
	Retries5xx       int
	RetriesTransport int
	ValidationTotal  int
	ValidationPassed int
	Duration         time.Duration
	EarliestAccess   time.Time
	LatestAccess     time.Time
	MinimumRemaining time.Duration
	Precheck         Precheck
}

type counters struct {
	mu sync.Mutex
	Result
}

func (c *counters) increment(fn func(*Result)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fn(&c.Result)
}

func Run(ctx context.Context, options Options) (Result, error) {
	options = withDefaults(options)
	if err := validateOptions(options); err != nil {
		return Result{}, err
	}
	if err := bootstrap.ValidateTarget(options.BaseURL, options.AllowRemote, options.ConfirmTargetHost); err != nil {
		return Result{}, err
	}
	if err := credentials.ValidateOutputTarget(options.Output, options.Replace); err != nil {
		return Result{}, err
	}
	input, err := credentials.Load(options.Input)
	if err != nil {
		return Result{}, err
	}
	if len(input.Users) < options.UserCount {
		return Result{}, fmt.Errorf(
			"credential input contains %d users, need at least %d canonical users",
			len(input.Users),
			options.UserCount,
		)
	}
	selected, err := credentials.SelectCanonical(input, options.UserCount)
	if err != nil {
		return Result{}, err
	}
	precheck := inspectRefreshTokens(selected, options.now())
	if precheck.Missing != 0 || precheck.Malformed != 0 || precheck.Expired != 0 {
		return Result{InputUsers: len(selected.Users), Precheck: precheck}, fmt.Errorf("refresh-token precheck failed: missing=%d malformed=%d expired=%d", precheck.Missing, precheck.Malformed, precheck.Expired)
	}

	transport := options.HTTPTransport
	if transport == nil {
		transport = credentials.NewBenchmarkTransport(max(64, options.Concurrency*2))
	}
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		defer closer.CloseIdleConnections()
	}
	sessions, err := credentials.NewSessions(selected, options.BaseURL, transport)
	if err != nil {
		return Result{}, err
	}
	apis := make([]*client.API, len(sessions))
	for index, session := range sessions {
		api, err := client.New(options.BaseURL, session)
		if err != nil {
			return Result{}, err
		}
		apis[index] = api
	}
	started := options.now()
	count := &counters{Result: Result{InputUsers: len(selected.Users), Precheck: precheck}}
	all := make([]int, len(sessions))
	for index := range all {
		all[index] = index
	}
	if err := refreshIndexes(ctx, options, sessions, apis, all, count); err != nil {
		return count.snapshot(started, options.now()), err
	}
	stale, access := accessFreshness(sessions, options.BaseURL, options.now(), options.MinAccessValidFor)
	if len(stale) > 0 {
		if err := refreshIndexes(ctx, options, sessions, apis, stale, count); err != nil {
			return count.snapshot(started, options.now()), err
		}
		stale, access = accessFreshness(sessions, options.BaseURL, options.now(), options.MinAccessValidFor)
		if len(stale) > 0 {
			return count.snapshot(started, options.now()), errors.New("refreshed access tokens cannot satisfy minimum access validity")
		}
	}
	if err := validateSample(ctx, options, sessions, apis, count); err != nil {
		return count.snapshot(started, options.now()), err
	}
	output := selected
	for index, session := range sessions {
		accessToken, refreshToken := session.AccessToken(options.BaseURL), session.RefreshToken(options.BaseURL)
		if accessToken == "" || refreshToken == "" {
			return count.snapshot(started, options.now()), fmt.Errorf("refreshed session %q has missing cookies", session.Alias)
		}
		output.Users[index].Cookies = credentials.Cookies{AccessToken: accessToken, RefreshToken: refreshToken}
	}
	if err := credentials.Validate(output); err != nil {
		return count.snapshot(started, options.now()), errors.New("refreshed credential file failed validation")
	}
	if err := credentials.WriteAtomic(options.Output, output, options.Replace); err != nil {
		return count.snapshot(started, options.now()), err
	}
	result := count.snapshot(started, options.now())
	result.Refreshed = len(sessions)
	result.EarliestAccess = access.earliest
	result.LatestAccess = access.latest
	result.MinimumRemaining = access.minimum
	return result, nil
}

func withDefaults(options Options) Options {
	if options.Concurrency == 0 {
		options.Concurrency = DefaultConcurrency
	}
	if options.RequestTimeout == 0 {
		options.RequestTimeout = DefaultRequestTimeout
	}
	if options.MaxAttempts == 0 {
		options.MaxAttempts = DefaultMaxAttempts
	}
	if options.MinAccessValidFor == 0 {
		options.MinAccessValidFor = DefaultMinAccessValidity
	}
	if options.now == nil {
		options.now = time.Now
	}
	if options.sleep == nil {
		options.sleep = wait
	}
	return options
}

func validateOptions(options Options) error {
	if options.Input == "" || options.Output == "" {
		return errors.New("input and output paths are required")
	}
	if options.UserCount < 1 || options.UserCount > credentials.MaxCanonicalSequence {
		return fmt.Errorf("user count must be within 1..%d", credentials.MaxCanonicalSequence)
	}
	if options.Concurrency < 1 || options.Concurrency > maxConcurrency {
		return fmt.Errorf("refresh concurrency must be within 1..%d", maxConcurrency)
	}
	if options.RequestTimeout <= 0 {
		return errors.New("request timeout must be positive")
	}
	if options.MaxAttempts < 1 || options.MaxAttempts > maxAttempts {
		return fmt.Errorf("max attempts must be within 1..%d", maxAttempts)
	}
	if options.MinAccessValidFor <= 0 {
		return errors.New("minimum access validity must be positive")
	}
	if options.ValidationSample < 0 {
		return errors.New("validation sample cannot be negative")
	}
	return nil
}

func inspectRefreshTokens(file credentials.File, now time.Time) Precheck {
	result := Precheck{}
	for _, user := range file.Users {
		expiresAt, ok := credentials.TokenExpiryUnverified(user.Cookies.RefreshToken)
		switch {
		case user.Cookies.RefreshToken == "":
			result.Missing++
		case !ok:
			result.Malformed++
		case !expiresAt.After(now):
			result.Expired++
		default:
			result.Valid++
			if result.Earliest.IsZero() || expiresAt.Before(result.Earliest) {
				result.Earliest = expiresAt
			}
			if result.Latest.IsZero() || expiresAt.After(result.Latest) {
				result.Latest = expiresAt
			}
		}
	}
	return result
}

func refreshIndexes(ctx context.Context, options Options, sessions []*credentials.Session, apis []*client.API, indexes []int, count *counters) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	errCh := make(chan error, 1)
	workers := min(options.Concurrency, len(indexes))
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case index, ok := <-jobs:
					if !ok {
						return
					}
					if err := refreshOne(ctx, options, sessions[index], apis[index], count); err != nil {
						select {
						case errCh <- err:
							cancel()
						default:
						}
						return
					}
				}
			}
		}()
	}
	for _, index := range indexes {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			select {
			case err := <-errCh:
				return err
			default:
				return ctx.Err()
			}
		case jobs <- index:
		}
	}
	close(jobs)
	wg.Wait()
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

func refreshOne(ctx context.Context, options Options, session *credentials.Session, api *client.API, count *counters) error {
	retried := false
	for attempt := 1; attempt <= options.MaxAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, options.RequestTimeout)
		result, err := api.RefreshDetailed(attemptCtx)
		cancel()
		count.increment(func(resultCount *Result) { resultCount.RefreshAttempts++ })
		if err == nil {
			if session.AccessToken(options.BaseURL) == "" || session.RefreshToken(options.BaseURL) == "" {
				return fmt.Errorf("refresh failed for %s: missing refreshed cookies", session.Alias)
			}
			if retried {
				count.increment(func(resultCount *Result) { resultCount.RetriedUsers++ })
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		retryKind, retry := refreshRetry(result, err)
		if !retry || attempt == options.MaxAttempts {
			return refreshFailure(session.Alias, result.HTTPStatus, err)
		}
		retried = true
		count.increment(func(resultCount *Result) {
			switch retryKind {
			case "429":
				resultCount.Retries429++
			case "5xx":
				resultCount.Retries5xx++
			default:
				resultCount.RetriesTransport++
			}
		})
		delay := retryDelay(options, attempt, result.RetryAfter)
		if err := options.sleep(ctx, delay); err != nil {
			return err
		}
	}
	return errors.New("refresh attempts exhausted")
}

func refreshRetry(result client.RefreshResult, err error) (string, bool) {
	if result.HTTPStatus == http.StatusTooManyRequests {
		return "429", true
	}
	if result.HTTPStatus >= 500 && result.HTTPStatus <= 599 {
		return "5xx", true
	}
	if result.ResponseReadFail {
		return "transport", true
	}
	if result.HTTPStatus == 0 && err != nil {
		return "transport", true
	}
	return "", false
}

func retryDelay(options Options, attempt int, retryAfter *time.Duration) time.Duration {
	if retryAfter != nil {
		return *retryAfter
	}
	base := 100 * time.Millisecond * time.Duration(1<<(attempt-1))
	if base > 2*time.Second {
		base = 2 * time.Second
	}
	return base/2 + time.Duration(rand.Int64N(int64(base/2)+1))
}

func refreshFailure(alias string, status int, _ error) error {
	if status != 0 {
		return fmt.Errorf("refresh failed for %s: HTTP %d", alias, status)
	}
	return fmt.Errorf("refresh failed for %s: transport error", alias)
}

type freshness struct {
	earliest, latest time.Time
	minimum          time.Duration
}

func accessFreshness(sessions []*credentials.Session, base *url.URL, now time.Time, minimum time.Duration) ([]int, freshness) {
	stale := make([]int, 0)
	info := freshness{}
	for index, session := range sessions {
		expiresAt, ok := credentials.TokenExpiryUnverified(session.AccessToken(base))
		if !ok || expiresAt.Sub(now) < minimum {
			stale = append(stale, index)
			continue
		}
		remaining := expiresAt.Sub(now)
		if info.earliest.IsZero() || expiresAt.Before(info.earliest) {
			info.earliest = expiresAt
		}
		if info.latest.IsZero() || expiresAt.After(info.latest) {
			info.latest = expiresAt
		}
		if info.minimum == 0 || remaining < info.minimum {
			info.minimum = remaining
		}
	}
	return stale, info
}

func validateSample(ctx context.Context, options Options, sessions []*credentials.Session, apis []*client.API, count *counters) error {
	indexes := sampleIndexes(len(sessions), options.ValidationSample)
	if len(indexes) == 0 {
		return nil
	}
	var mu sync.Mutex
	passed := 0
	err := parallel(ctx, options.Concurrency, indexes, func(index int) error {
		requestCtx, cancel := context.WithTimeout(ctx, options.RequestTimeout)
		me, err := apis[index].Me(requestCtx)
		cancel()
		if err != nil || me.ID == "" || !me.IsActive || me.Role != "user" {
			return fmt.Errorf("validation failed for %s", sessions[index].Alias)
		}
		mu.Lock()
		passed++
		mu.Unlock()
		return nil
	})
	count.increment(func(result *Result) { result.ValidationTotal = len(indexes); result.ValidationPassed = passed })
	return err
}

func sampleIndexes(total, wanted int) []int {
	if total == 0 || wanted == 0 {
		return nil
	}
	if wanted > total {
		wanted = total
	}
	if wanted == 1 {
		return []int{0}
	}
	indexes := make([]int, 0, wanted)
	for position := range wanted {
		indexes = append(indexes, position*(total-1)/(wanted-1))
	}
	return indexes
}

func parallel(ctx context.Context, concurrency int, indexes []int, work func(int) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	errCh := make(chan error, 1)
	workers := min(concurrency, len(indexes))
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case index, ok := <-jobs:
					if !ok {
						return
					}
					if err := work(index); err != nil {
						select {
						case errCh <- err:
							cancel()
						default:
						}
						return
					}
				}
			}
		}()
	}
	for _, index := range indexes {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			select {
			case err := <-errCh:
				return err
			default:
				return ctx.Err()
			}
		case jobs <- index:
		}
	}
	close(jobs)
	wg.Wait()
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

func wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (c *counters) snapshot(start, now time.Time) Result {
	c.mu.Lock()
	defer c.mu.Unlock()
	value := c.Result
	value.Duration = now.Sub(start)
	return value
}
func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
