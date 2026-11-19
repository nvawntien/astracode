// refresh-sessions renews a local benchmark session pool before a measured run.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/bootstrap"
	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/refresh"
)

type options struct {
	baseURL           string
	allowRemote       bool
	confirmTargetHost string
	input             string
	output            string
	replace           bool
	userCount         int
	concurrency       int
	requestTimeout    time.Duration
	maxAttempts       int
	minAccessValidFor time.Duration
	validationSample  int
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "refresh-sessions:", safeError(err))
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	opts, err := parse(args, stderr)
	if err != nil {
		return err
	}
	base, err := url.Parse(opts.baseURL)
	if err != nil {
		return bootstrap.ErrTargetUnsafe
	}
	result, err := refresh.Run(ctx, refresh.Options{
		BaseURL:           base,
		AllowRemote:       opts.allowRemote,
		ConfirmTargetHost: opts.confirmTargetHost,
		Input:             opts.input,
		Output:            opts.output,
		Replace:           opts.replace,
		UserCount:         opts.userCount,
		Concurrency:       opts.concurrency,
		RequestTimeout:    opts.requestTimeout,
		MaxAttempts:       opts.maxAttempts,
		MinAccessValidFor: opts.minAccessValidFor,
		ValidationSample:  opts.validationSample,
	})
	if err != nil {
		if result.InputUsers > 0 {
			fmt.Fprintf(stdout, "Input users: %d\nRefresh-token precheck valid: %d\nRefresh-token missing: %d\nRefresh-token malformed: %d\nRefresh-token expired: %d\n", result.InputUsers, result.Precheck.Valid, result.Precheck.Missing, result.Precheck.Malformed, result.Precheck.Expired)
		}
		return err
	}
	rate := 0.0
	if result.Duration > 0 {
		rate = float64(result.Refreshed) / result.Duration.Seconds()
	}
	fmt.Fprintf(stdout, "Input users: %d\nRefresh-token precheck valid: %d\nRefresh-token earliest expiry: %s\nRefresh-token latest expiry: %s\nRefreshed sessions: %d\nRefresh attempts: %d\nRetried users: %d\n429 retries: %d\n5xx retries: %d\nTransport retries: %d\nTerminal failures: 0\nValidation sample: %d/%d\nPreparation duration: %s\nEffective refresh rate: %.2f sessions/s\nEarliest access expiry: %s\nLatest access expiry: %s\nMinimum access remaining: %s\nOutput: %s\nMode: 0600\n", result.InputUsers, result.Precheck.Valid, result.Precheck.Earliest.UTC().Format(time.RFC3339), result.Precheck.Latest.UTC().Format(time.RFC3339), result.Refreshed, result.RefreshAttempts, result.RetriedUsers, result.Retries429, result.Retries5xx, result.RetriesTransport, result.ValidationPassed, result.ValidationTotal, result.Duration.Round(time.Millisecond), rate, result.EarliestAccess.UTC().Format(time.RFC3339), result.LatestAccess.UTC().Format(time.RFC3339), result.MinimumRemaining.Round(time.Second), opts.output)
	return nil
}

func parse(args []string, stderr io.Writer) (options, error) {
	var opts options
	fs := flag.NewFlagSet("refresh-sessions", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.baseURL, "base-url", "", "public AstraCode gateway base URL")
	fs.BoolVar(&opts.allowRemote, "allow-remote", false, "allow confirmed non-loopback HTTPS target")
	fs.StringVar(&opts.confirmTargetHost, "confirm-target-host", "", "exact non-loopback target hostname")
	fs.StringVar(&opts.input, "input", "users-100k.local.json", "secure existing credential input path")
	fs.StringVar(&opts.output, "output", "users-100k.local.json", "secure refreshed credential output path")
	fs.BoolVar(&opts.replace, "replace", false, "atomically replace an existing output file")
	fs.IntVar(&opts.userCount, "user-count", 100000, "canonical benchmark user count (1..100000)")
	fs.IntVar(&opts.concurrency, "concurrency", refresh.DefaultConcurrency, "bounded concurrent refresh requests")
	fs.DurationVar(&opts.requestTimeout, "request-timeout", refresh.DefaultRequestTimeout, "per-refresh and sampled validation timeout")
	fs.IntVar(&opts.maxAttempts, "max-attempts", refresh.DefaultMaxAttempts, "maximum total refresh attempts per user")
	fs.DurationVar(&opts.minAccessValidFor, "min-access-valid-for", refresh.DefaultMinAccessValidity, "required remaining access-token lifetime")
	fs.IntVar(&opts.validationSample, "validation-sample", refresh.DefaultValidationSample, "deterministic post-refresh /me validation count; zero disables it")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	if fs.NArg() != 0 || opts.baseURL == "" {
		return options{}, errors.New("invalid refresh-sessions arguments")
	}
	return opts, nil
}

func safeError(err error) string {
	switch {
	case errors.Is(err, bootstrap.ErrTargetUnsafe):
		return "target must be loopback HTTP(S), or confirmed HTTPS remote"
	case errors.Is(err, context.Canceled):
		return "session refresh cancelled; the existing credential file was not replaced"
	default:
		return "safe session refresh failure; review aggregate counts, target, and local credential file"
	}
}
