package refresh

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nvawntien/go-judge-system/tools/benchmark/judge/internal/credentials"
)

func TestRunRefreshesCanonicalSessionsAtomically(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	server, calls := refreshServer(t, now, func(alias string, attempt int) int { return http.StatusOK })
	defer server.Close()
	input, output := credentialPaths(t, credentialFile(now, 3))
	result, err := Run(context.Background(), testOptions(t, server.URL, input, output, 3, now))
	if err != nil {
		t.Fatal(err)
	}
	if result.Refreshed != 3 || result.RefreshAttempts != 6 || result.ValidationTotal != 3 || result.ValidationPassed != 3 {
		t.Fatalf("result=%+v", result)
	}
	if len(*calls) != 6 {
		t.Fatalf("refresh calls=%d", len(*calls))
	}
	loaded, err := credentials.Load(output)
	if err != nil {
		t.Fatal(err)
	}
	for index, user := range loaded.Users {
		if user.Alias != alias(index+1) || user.Cookies.AccessToken == credentialFile(now, 3).Users[index].Cookies.AccessToken || !strings.Contains(user.Cookies.RefreshToken, "new") {
			t.Fatalf("user %d = %#v", index, user)
		}
	}
	info, err := os.Lstat(output)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("output mode=%v err=%v", info.Mode(), err)
	}
}

func TestRunRefreshPrecheckRejectsExpiredMissingAndMalformedWithoutNetwork(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	for name, refreshToken := range map[string]string{
		"expired":   jwt(now.Add(-time.Minute)),
		"missing":   "",
		"malformed": "not-a-jwt",
	} {
		t.Run(name, func(t *testing.T) {
			serverCalls := 0
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { serverCalls++ }))
			defer server.Close()
			file := credentialFile(now, 1)
			file.Users[0].Cookies.RefreshToken = refreshToken
			input, output := credentialPaths(t, file)
			if err := os.WriteFile(output, []byte("prior"), 0o600); err != nil {
				t.Fatal(err)
			}
			opts := testOptions(t, server.URL, input, output, 1, now)
			opts.Replace = true
			_, err := Run(context.Background(), opts)
			if err == nil || serverCalls != 0 {
				t.Fatalf("err=%v calls=%d", err, serverCalls)
			}
			contents, readErr := os.ReadFile(output)
			if readErr != nil || string(contents) != "prior" {
				t.Fatalf("output changed=%q err=%v", contents, readErr)
			}
		})
	}
}

func TestRunRetries429And5xxButNot401(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	for name, statuses := range map[string][]int{
		"429 retry-after": {http.StatusTooManyRequests, http.StatusOK},
		"5xx":             {http.StatusServiceUnavailable, http.StatusOK},
		"401 terminal":    {http.StatusUnauthorized, http.StatusOK},
	} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			calls := 0
			server, _ := refreshServer(t, now, func(string, int) int {
				mu.Lock()
				defer mu.Unlock()
				status := statuses[calls]
				calls++
				return status
			})
			defer server.Close()
			input, output := credentialPaths(t, credentialFile(now, 1))
			opts := testOptions(t, server.URL, input, output, 1, now)
			opts.sleep = func(context.Context, time.Duration) error { return nil }
			result, err := Run(context.Background(), opts)
			if name == "401 terminal" {
				if err == nil || calls != 1 {
					t.Fatalf("err=%v calls=%d", err, calls)
				}
				return
			}
			if err != nil || calls != 2 || result.RetriedUsers != 1 {
				t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
			}
		})
	}
}

func TestRunRetriesTransportAndUsesCurrentJar(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	server, calls := refreshServer(t, now, func(string, int) int { return http.StatusOK })
	defer server.Close()
	input, output := credentialPaths(t, credentialFile(now, 1))
	base, _ := url.Parse(server.URL)
	first := true
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if first {
			first = false
			return nil, errors.New("temporary connection failure")
		}
		return http.DefaultTransport.RoundTrip(request)
	})
	opts := testOptions(t, base.String(), input, output, 1, now)
	opts.HTTPTransport, opts.sleep = transport, func(context.Context, time.Duration) error { return nil }
	result, err := Run(context.Background(), opts)
	if err != nil || result.RetriesTransport != 1 || len(*calls) != 2 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, len(*calls))
	}
}

func TestRunRejectsMissingReturnedCookiesWithoutReplacingOutput(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/refresh-token" {
			_, _ = w.Write([]byte(`{"status":"success","code":20000,"data":{}}`))
		}
	}))
	defer server.Close()
	input, output := credentialPaths(t, credentialFile(now, 1))
	if err := os.WriteFile(output, []byte("prior"), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := testOptions(t, server.URL, input, output, 1, now)
	opts.Replace = true
	_, err := Run(context.Background(), opts)
	if err == nil || strings.Contains(err.Error(), credentialFile(now, 1).Users[0].Cookies.AccessToken) {
		t.Fatalf("unsafe or missing error: %v", err)
	}
	contents, readErr := os.ReadFile(output)
	if readErr != nil || string(contents) != "prior" {
		t.Fatalf("output changed=%q err=%v", contents, readErr)
	}
}

func TestRunHonorsCancellationWithoutOutput(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	server, _ := refreshServer(t, now, func(string, int) int { return http.StatusServiceUnavailable })
	defer server.Close()
	input, output := credentialPaths(t, credentialFile(now, 1))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Run(ctx, testOptions(t, server.URL, input, output, 1, now))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
	if _, statErr := os.Lstat(output); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("output exists: %v", statErr)
	}
}

func TestRunFreshnessSecondRoundAndPartialFailureDoNotReplaceInput(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	var attempts int
	server, _ := refreshServer(t, now, func(string, int) int { attempts++; return http.StatusOK })
	defer server.Close()
	input, output := credentialPaths(t, credentialFile(now, 1))
	opts := testOptions(t, server.URL, input, output, 1, now)
	// The test server makes first-round tokens valid for only one minute, then
	// makes second-round tokens valid for an hour.
	_ = attempts
	result, err := Run(context.Background(), opts)
	if err != nil || result.RefreshAttempts != 2 {
		t.Fatalf("result=%+v err=%v", result, err)
	}

	failed := credentialFile(now, 2)
	failureInput, failureOutput := credentialPaths(t, failed)
	if err := os.WriteFile(failureOutput, []byte("prior"), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/refresh-token" {
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer bad.Close()
	failureOptions := testOptions(t, bad.URL, failureInput, failureOutput, 2, now)
	failureOptions.Replace = true
	if _, err := Run(context.Background(), failureOptions); err == nil {
		t.Fatal("partial failure succeeded")
	}
	contents, err := os.ReadFile(failureOutput)
	if err != nil || string(contents) != "prior" {
		t.Fatalf("output changed=%q err=%v", contents, err)
	}
}

func TestRunRejectsSymlinkOutputAndSampleIsDeterministic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics")
	}
	now := time.Unix(1_700_000_000, 0)
	server, _ := refreshServer(t, now, func(string, int) int { return http.StatusOK })
	defer server.Close()
	input, output := credentialPaths(t, credentialFile(now, 2))
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("prior"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, output); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(context.Background(), testOptions(t, server.URL, input, output, 2, now)); err == nil {
		t.Fatal("symlink output accepted")
	}
	if got := sampleIndexes(100000, 32); len(got) != 32 || got[0] != 0 || got[len(got)-1] != 99999 {
		t.Fatalf("sample=%v", got)
	}
}

func credentialPaths(t *testing.T, file credentials.File) (string, string) {
	t.Helper()
	directory := t.TempDir()
	input, output := filepath.Join(directory, "input.json"), filepath.Join(directory, "output.json")
	contents, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	return input, output
}

func credentialFile(now time.Time, count int) credentials.File {
	users := make([]credentials.User, count)
	for index := range users {
		users[index] = credentials.User{Alias: alias(index + 1), Cookies: credentials.Cookies{AccessToken: jwtWithSubject(now.Add(-time.Hour), index), RefreshToken: jwtWithSubject(now.Add(time.Hour), index+100000)}}
	}
	return credentials.File{SchemaVersion: credentials.SchemaVersion, Users: users}
}

func refreshServer(t *testing.T, now time.Time, status func(alias string, attempt int) int) (*httptest.Server, *[]string) {
	t.Helper()
	var mu sync.Mutex
	attempts := map[string]int{}
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/refresh-token" {
			cookie, _ := r.Cookie("refresh_token")
			alias := strings.TrimPrefix(cookie.Value, "refresh-")
			mu.Lock()
			attempt := attempts[alias]
			attempts[alias]++
			calls = append(calls, alias)
			mu.Unlock()
			code := status(alias, attempt)
			if code == http.StatusTooManyRequests {
				w.Header().Set("Retry-After", "0")
			}
			if code != http.StatusOK {
				w.WriteHeader(code)
				_, _ = w.Write([]byte(`{"status":"error","code":40000}`))
				return
			}
			expires := now.Add(time.Minute)
			if attempt > 0 || strings.HasPrefix(cookie.Value, "new-") {
				expires = now.Add(time.Hour)
			}
			http.SetCookie(w, &http.Cookie{Name: "access_token", Value: jwtWithString(expires, cookie.Value), Path: "/"})
			http.SetCookie(w, &http.Cookie{Name: "refresh_token", Value: "new-" + alias, Path: "/"})
			_, _ = w.Write([]byte(`{"status":"success","code":20000,"data":{}}`))
			return
		}
		if r.URL.Path == "/api/v1/me" {
			_, _ = w.Write([]byte(`{"status":"success","code":20000,"data":{"id":"subject","role":"user","is_active":true}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	return server, &calls
}

func testOptions(t *testing.T, target, input, output string, count int, now time.Time) Options {
	t.Helper()
	base, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	return Options{BaseURL: base, Input: input, Output: output, UserCount: count, Concurrency: 2, RequestTimeout: time.Second, MaxAttempts: 3, MinAccessValidFor: 5 * time.Minute, ValidationSample: count, now: func() time.Time { return now }, sleep: func(context.Context, time.Duration) error { return nil }}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func alias(sequence int) string { return "bench-" + fmt.Sprintf("%03d", sequence) }
func jwt(expiration time.Time) string {
	payload, _ := json.Marshal(map[string]int64{"exp": expiration.Unix()})
	return "x." + base64.RawURLEncoding.EncodeToString(payload) + ".y"
}
func jwtWithSubject(expiration time.Time, subject int) string {
	payload, _ := json.Marshal(map[string]any{"exp": expiration.Unix(), "sub": subject})
	return "x." + base64.RawURLEncoding.EncodeToString(payload) + ".y"
}
func jwtWithString(expiration time.Time, subject string) string {
	payload, _ := json.Marshal(map[string]any{"exp": expiration.Unix(), "sub": subject})
	return "x." + base64.RawURLEncoding.EncodeToString(payload) + ".y"
}
