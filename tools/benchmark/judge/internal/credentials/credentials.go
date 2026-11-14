// Package credentials handles local, pre-issued benchmark sessions and their
// secure local-file representation. It never provisions accounts or logs in.
package credentials

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"time"
)

const SchemaVersion = 1
const MaxCanonicalSequence = 100000

// NewBenchmarkTransport returns the shared, explicitly bounded connection
// transport used by all isolated cookie-jar clients in one benchmark process.
// Cookie jars remain per-user; only TCP connection reuse is shared.
func NewBenchmarkTransport(maxConnsPerHost int) *http.Transport {
	if maxConnsPerHost < 1 {
		maxConnsPerHost = 1
	}
	maxIdle := maxConnsPerHost
	if maxIdle > 4096 {
		maxIdle = 4096
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = maxIdle
	transport.MaxIdleConnsPerHost = maxIdle
	transport.MaxConnsPerHost = maxConnsPerHost
	transport.IdleConnTimeout = 90 * time.Second
	// Clone preserves Go's default HTTP/2 negotiation behavior. Cookie jars
	// remain isolated in NewSessions; only TCP/HTTP transport state is shared.
	return transport
}

var aliasPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
var canonicalAliasPattern = regexp.MustCompile(`^bench-([0-9]+)$`)

type File struct {
	SchemaVersion int    `json:"schema_version"`
	Users         []User `json:"users"`
}

type User struct {
	Alias   string  `json:"alias"`
	Cookies Cookies `json:"cookies"`
}

type Cookies struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

// Session is deliberately per logical user. Its Jar must never be shared.
type Session struct {
	Alias  string
	Jar    http.CookieJar
	Client *http.Client
	// Subject remains memory-only and is set by authenticated preflight.
	Subject string
}

func Load(path string) (File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return File{}, fmt.Errorf("inspect credential file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return File{}, errors.New("credential file must not be a symlink")
	}
	if !info.Mode().IsRegular() {
		return File{}, errors.New("credential file must be a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return File{}, errors.New("credential file must be mode 0600 or stricter")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return File{}, fmt.Errorf("read credential file: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var file File
	if err := decoder.Decode(&file); err != nil {
		return File{}, fmt.Errorf("decode credential file: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return File{}, errors.New("credential file contains trailing JSON values")
	}
	if err := Validate(file); err != nil {
		return File{}, err
	}
	return file, nil
}

func Validate(file File) error {
	if file.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported credential schema_version %d", file.SchemaVersion)
	}
	if len(file.Users) == 0 {
		return errors.New("credential file contains no users")
	}
	aliases := make(map[string]struct{}, len(file.Users))
	tokens := make(map[string]struct{}, len(file.Users))
	for _, user := range file.Users {
		if !aliasPattern.MatchString(user.Alias) {
			return fmt.Errorf("invalid benchmark alias %q", user.Alias)
		}
		if user.Cookies.AccessToken == "" {
			return fmt.Errorf("user %q has no access_token", user.Alias)
		}
		if _, exists := aliases[user.Alias]; exists {
			return fmt.Errorf("duplicate benchmark alias %q", user.Alias)
		}
		if _, exists := tokens[user.Cookies.AccessToken]; exists {
			return errors.New("duplicate access_token in credential file")
		}
		aliases[user.Alias] = struct{}{}
		tokens[user.Cookies.AccessToken] = struct{}{}
	}
	return nil
}

// SelectCanonical returns the first count canonical benchmark aliases in
// numeric order. It deliberately rejects gaps and non-canonical aliases so a
// massive burst cannot accidentally select an arbitrary real-user session.
func SelectCanonical(file File, count int) (File, error) {
	if err := Validate(file); err != nil {
		return File{}, err
	}
	if count < 1 || count > MaxCanonicalSequence {
		return File{}, fmt.Errorf("canonical benchmark user count must be within 1..%d", MaxCanonicalSequence)
	}
	bySequence := make(map[int]User, len(file.Users))
	for _, user := range file.Users {
		match := canonicalAliasPattern.FindStringSubmatch(user.Alias)
		if len(match) != 2 {
			return File{}, fmt.Errorf("benchmark session alias %q is not canonical", user.Alias)
		}
		sequence, err := strconv.Atoi(match[1])
		if err != nil || sequence < 1 || sequence > MaxCanonicalSequence || user.Alias != fmt.Sprintf("bench-%03d", sequence) {
			return File{}, fmt.Errorf("benchmark session alias %q is not canonical", user.Alias)
		}
		if _, exists := bySequence[sequence]; exists {
			return File{}, fmt.Errorf("duplicate canonical benchmark alias %q", user.Alias)
		}
		bySequence[sequence] = user
	}
	selected := make([]User, 0, count)
	for sequence := 1; sequence <= count; sequence++ {
		user, ok := bySequence[sequence]
		if !ok {
			return File{}, fmt.Errorf("canonical benchmark session bench-%03d is missing", sequence)
		}
		selected = append(selected, user)
	}
	return File{SchemaVersion: SchemaVersion, Users: selected}, nil
}

func NewSessions(file File, base *url.URL, transport http.RoundTripper) ([]*Session, error) {
	if err := Validate(file); err != nil {
		return nil, err
	}
	if base == nil || base.Scheme == "" || base.Host == "" {
		return nil, errors.New("valid base URL is required to seed session cookies")
	}
	if transport == nil {
		transport = http.DefaultTransport
	}
	sessions := make([]*Session, 0, len(file.Users))
	for _, user := range file.Users {
		jar, err := cookiejar.New(nil)
		if err != nil {
			return nil, fmt.Errorf("create cookie jar: %w", err)
		}
		cookies := []*http.Cookie{{Name: "access_token", Value: user.Cookies.AccessToken, Path: "/", HttpOnly: true}}
		if user.Cookies.RefreshToken != "" {
			cookies = append(cookies, &http.Cookie{Name: "refresh_token", Value: user.Cookies.RefreshToken, Path: "/", HttpOnly: true})
		}
		jar.SetCookies(base, cookies)
		sessions = append(sessions, &Session{
			Alias: user.Alias,
			Jar:   jar,
			Client: &http.Client{
				Transport:     transport,
				Jar:           jar,
				CheckRedirect: sameOriginRedirect(base),
			},
		})
	}
	return sessions, nil
}

func sameOriginRedirect(_ *url.URL) func(*http.Request, []*http.Request) error {
	return func(_ *http.Request, _ []*http.Request) error {
		// Reject every redirect. Same-origin 307/308 redirects can replay a POST,
		// violating the benchmark's exactly-one submission request invariant.
		return errors.New("redirect rejected")
	}
}

// HasRefresh reports only local session capability; it does not reveal or log
// the token itself.
func (s *Session) HasRefresh(base *url.URL) bool {
	for _, cookie := range s.Jar.Cookies(base) {
		if cookie.Name == "refresh_token" && cookie.Value != "" {
			return true
		}
	}
	return false
}

// AccessToken returns the in-memory cookie only to the local runner so it can
// inspect the unverified JWT expiry for pre-run lifetime planning. Callers must
// not persist or log the returned value.
func (s *Session) AccessToken(base *url.URL) string {
	for _, cookie := range s.Jar.Cookies(base) {
		if cookie.Name == "access_token" {
			return cookie.Value
		}
	}
	return ""
}

// RefreshToken returns the in-memory refresh cookie only to local preparation
// code. Callers must never log or persist this value outside a credential file.
func (s *Session) RefreshToken(base *url.URL) string {
	for _, cookie := range s.Jar.Cookies(base) {
		if cookie.Name == "refresh_token" {
			return cookie.Value
		}
	}
	return ""
}

// TokenExpiryUnverified decodes only the JWT payload exp claim for local
// lifetime planning. It deliberately does not validate a signature.
func TokenExpiryUnverified(token string) (time.Time, bool) {
	parts := bytes.Split([]byte(token), []byte("."))
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(string(parts[1]))
	if err != nil {
		return time.Time{}, false
	}
	var claim struct {
		Exp json.Number `json:"exp"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&claim); err != nil {
		return time.Time{}, false
	}
	expiration, err := claim.Exp.Int64()
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(expiration, 0), true
}

// WriteAtomic installs a complete credential file only after it has been
// encoded and synced. It never follows a symlink and leaves an existing file
// untouched unless replace is explicitly requested.
func WriteAtomic(path string, file File, replace bool) error {
	if err := ensureOutputTarget(path, replace); err != nil {
		return err
	}
	directory := filepath.Dir(path)
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return errors.New("create output temporary name")
	}
	temporary := filepath.Join(directory, ".users.local."+hex.EncodeToString(random)+".tmp")
	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return errors.New("create output temporary file")
	}
	defer func() { _ = f.Close(); _ = os.Remove(temporary) }()
	if err := json.NewEncoder(f).Encode(file); err != nil {
		return errors.New("write credential output")
	}
	if err := f.Sync(); err != nil {
		return errors.New("sync credential output")
	}
	if err := f.Close(); err != nil {
		return errors.New("close credential output")
	}
	if replace {
		if err := ensureOutputTarget(path, true); err != nil {
			return err
		}
		if err := os.Rename(temporary, path); err != nil {
			return errors.New("install credential output")
		}
	} else if err := os.Link(temporary, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errors.New("output file already exists; use --replace to renew it")
		}
		return errors.New("install credential output")
	} else if err := os.Remove(temporary); err != nil {
		return errors.New("remove credential temporary file")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return errors.New("secure credential output permissions")
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return errors.New("verify credential output permissions")
	}
	return nil
}

// ValidateOutputTarget checks that a future atomic credential install is safe.
// WriteAtomic repeats this check immediately before installing the file.
func ValidateOutputTarget(path string, replace bool) error {
	return ensureOutputTarget(path, replace)
}

func ensureOutputTarget(path string, replace bool) error {
	if path == "" {
		return errors.New("output path is required")
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("inspect output path")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("output path must not be a symlink")
	}
	if !info.Mode().IsRegular() {
		return errors.New("output path must be a regular file")
	}
	if !replace {
		return errors.New("output file already exists; use --replace to renew it")
	}
	return nil
}
