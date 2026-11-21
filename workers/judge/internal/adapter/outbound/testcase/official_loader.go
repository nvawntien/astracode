package testcase

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"go-judge-system/pkg/judge"
	"go-judge-system/workers/judge/internal/application/port/outbound"
	workerdomain "go-judge-system/workers/judge/internal/domain"

	"go.uber.org/zap"
)

const (
	defaultCacheBaseDir      = "/cache/testcases"
	defaultMaxZipBytes       = 64 * 1024 * 1024
	defaultMaxExtractedBytes = 128 * 1024 * 1024
	cacheGenerationFile      = ".current"
	cacheVersionFile         = ".version"
	cacheSHA256File          = ".sha256"
	cacheZipFile             = "bundle.zip"
)

var (
	testcaseFilePattern = regexp.MustCompile(`^0*([1-9][0-9]*)\.(in|out)$`)
	sha256HexPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type OfficialLoader struct {
	httpClient        *http.Client
	cacheBaseDir      string
	maxZipBytes       int64
	maxExtractedBytes int64
	logger            *zap.Logger
}

func NewOfficialLoader(logger *zap.Logger) *OfficialLoader {
	return &OfficialLoader{
		httpClient: &http.Client{
			Timeout: judge.TestcaseDownloadTimeout,
		},
		cacheBaseDir:      defaultCacheBaseDir,
		maxZipBytes:       defaultMaxZipBytes,
		maxExtractedBytes: defaultMaxExtractedBytes,
		logger:            logger,
	}
}

func (l *OfficialLoader) Load(
	ctx context.Context,
	metadata outbound.ProblemTestCaseMetadata,
) (outbound.OfficialTestCaseBundle, error) {
	if err := validateMetadata(metadata); err != nil {
		return outbound.OfficialTestCaseBundle{}, err
	}

	objectURL, err := url.Parse(metadata.ZipDownloadURL)
	if err != nil || objectURL.Host == "" || (objectURL.Scheme != "http" && objectURL.Scheme != "https") {
		return outbound.OfficialTestCaseBundle{}, workerdomain.MarkNonRetryable(fmt.Errorf("invalid testcase download URL"))
	}
	identity := sha256.Sum256([]byte(objectURL.Scheme + "://" + objectURL.Host + objectURL.EscapedPath()))
	cacheDir := filepath.Join(l.cacheBaseDir, fmt.Sprintf("problem_%d", metadata.ProblemID), hex.EncodeToString(identity[:]))
	version := strconv.Itoa(metadata.Version)
	referenceFile := filepath.Join(cacheDir, cacheGenerationFile)
	if reference, err := os.ReadFile(referenceFile); err == nil {
		name := string(reference)
		if filepath.Base(name) == name && strings.HasPrefix(name, "generation-") {
			generation := filepath.Join(cacheDir, name)
			cachedVersion, err := os.ReadFile(filepath.Join(generation, cacheVersionFile))
			if err == nil && string(cachedVersion) == version {
				if checksum, valid := l.verifiedCachedChecksum(generation); valid {
					if bundle, err := l.bundleFromDir(generation, metadata, checksum); err == nil {
						l.logger.Debug("official testcase cache hit", zap.Int64("problem_id", metadata.ProblemID), zap.Int("version", metadata.Version))
						return bundle, nil
					}
				}
			}
		}
	}

	l.logger.Info("official testcase cache miss, downloading bundle", zap.Int64("problem_id", metadata.ProblemID), zap.Int("version", metadata.Version))
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("create testcase cache directory: %w", err)
	}
	generation, err := os.MkdirTemp(cacheDir, "generation-")
	if err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("create testcase cache generation: %w", err)
	}
	published := false
	defer func() {
		if !published {
			if err := os.RemoveAll(generation); err != nil {
				l.logger.Debug("failed to remove testcase staging directory", zap.Error(err))
			}
		}
	}()

	zipPath := filepath.Join(generation, cacheZipFile)
	checksum, err := l.downloadToFile(ctx, metadata.ZipDownloadURL, zipPath)
	if err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("download testcase bundle: %w", err)
	}
	if err := l.extractZip(zipPath, generation); err != nil {
		return outbound.OfficialTestCaseBundle{}, workerdomain.MarkNonRetryable(fmt.Errorf("extract testcase bundle: %w", err))
	}
	bundle, err := l.bundleFromDir(generation, metadata, checksum)
	if err != nil {
		return outbound.OfficialTestCaseBundle{}, err
	}
	if err := os.WriteFile(filepath.Join(generation, cacheVersionFile), []byte(version), 0644); err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("write testcase cache version: %w", err)
	}
	if err := os.WriteFile(filepath.Join(generation, cacheSHA256File), []byte(checksum), 0644); err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("write testcase cache checksum: %w", err)
	}
	if err := os.Chmod(generation, 0755); err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("make testcase generation readable to the sandbox: %w", err)
	}

	// Jobs keep paths to the resolved generation. Replacing only the reference
	// leaves every previously published generation available to active jobs.
	if err := publishGeneration(referenceFile, filepath.Base(generation)); err != nil {
		return outbound.OfficialTestCaseBundle{}, fmt.Errorf("publish testcase generation: %w", err)
	}
	published = true
	return bundle, nil
}

func (l *OfficialLoader) verifiedCachedChecksum(cacheDir string) (string, bool) {
	checksumBytes, err := os.ReadFile(filepath.Join(cacheDir, cacheSHA256File))
	if err != nil {
		return "", false
	}
	checksum := strings.TrimSpace(string(checksumBytes))
	if !sha256HexPattern.MatchString(checksum) {
		return "", false
	}

	actual, err := sha256File(filepath.Join(cacheDir, cacheZipFile))
	if err != nil {
		return "", false
	}
	if actual != checksum {
		return "", false
	}
	return checksum, true
}

func validateMetadata(metadata outbound.ProblemTestCaseMetadata) error {
	if metadata.ProblemID <= 0 {
		return workerdomain.MarkNonRetryable(fmt.Errorf("problem_id must be greater than zero"))
	}
	if strings.TrimSpace(metadata.ZipDownloadURL) == "" {
		return workerdomain.MarkNonRetryable(fmt.Errorf("zip_download_url is required"))
	}
	if metadata.TestCount <= 0 {
		return workerdomain.MarkNonRetryable(fmt.Errorf("test_count must be greater than zero"))
	}
	if metadata.Version <= 0 {
		return workerdomain.MarkNonRetryable(fmt.Errorf("version must be greater than zero"))
	}
	return nil
}

func (l *OfficialLoader) downloadToFile(ctx context.Context, url, destPath string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", workerdomain.MarkNonRetryable(fmt.Errorf("build testcase download request: %w", err))
	}

	resp, err := l.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("testcase download returned status %d", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	reader := io.LimitReader(resp.Body, l.maxZipBytes+1)
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), reader)
	if err != nil {
		return "", err
	}
	if n > l.maxZipBytes {
		return "", workerdomain.MarkNonRetryable(fmt.Errorf("testcase zip exceeds %d bytes", l.maxZipBytes))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func publishGeneration(referencePath, name string) error {
	tmp, err := os.CreateTemp(filepath.Dir(referencePath), ".current-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.WriteString(name)
	closeErr := tmp.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), referencePath)
}

func (l *OfficialLoader) bundleFromDir(
	dir string,
	metadata outbound.ProblemTestCaseMetadata,
	checksum string,
) (outbound.OfficialTestCaseBundle, error) {
	testCases, err := l.loadFromDir(dir, metadata.TestCount)
	if err != nil {
		return outbound.OfficialTestCaseBundle{}, err
	}
	return outbound.OfficialTestCaseBundle{
		TestCases:       testCases,
		TestCount:       metadata.TestCount,
		Version:         metadata.Version,
		DatasetChecksum: checksum,
	}, nil
}

func (l *OfficialLoader) extractZip(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer r.Close()

	var extracted int64
	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if f.FileInfo().Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("zip entry %q is a symlink", f.Name)
		}

		name := filepath.Clean(f.Name)
		if filepath.IsAbs(name) || strings.HasPrefix(name, ".."+string(os.PathSeparator)) || name == ".." {
			return fmt.Errorf("zip entry %q escapes destination", f.Name)
		}
		base := filepath.Base(name)
		if !testcaseFilePattern.MatchString(base) {
			continue
		}

		extracted += int64(f.UncompressedSize64)
		if extracted > l.maxExtractedBytes {
			return fmt.Errorf("testcase bundle exceeds %d extracted bytes", l.maxExtractedBytes)
		}

		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("open zip entry %s: %w", f.Name, err)
		}
		destPath := filepath.Join(destDir, base)
		outFile, err := os.Create(destPath)
		if err != nil {
			rc.Close()
			return fmt.Errorf("create file %s: %w", destPath, err)
		}
		if _, err := io.Copy(outFile, rc); err != nil {
			outFile.Close()
			rc.Close()
			return fmt.Errorf("extract %s: %w", f.Name, err)
		}
		outFile.Close()
		rc.Close()
	}
	return nil
}

func (l *OfficialLoader) loadFromDir(dir string, testCount int) ([]outbound.ExecutionTestCase, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read testcase dir: %w", err)
	}

	inputs := make(map[int]string)
	outputs := make(map[int]string)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matches := testcaseFilePattern.FindStringSubmatch(entry.Name())
		if matches == nil {
			continue
		}
		index, err := strconv.Atoi(matches[1])
		if err != nil {
			return nil, workerdomain.MarkNonRetryable(fmt.Errorf("parse testcase index %q: %w", entry.Name(), err))
		}
		path := filepath.Join(dir, entry.Name())
		switch matches[2] {
		case "in":
			inputs[index] = path
		case "out":
			outputs[index] = path
		}
	}

	indexes := make([]int, 0, len(inputs))
	for index := range inputs {
		if _, ok := outputs[index]; !ok {
			return nil, workerdomain.MarkNonRetryable(fmt.Errorf("missing output file for testcase %d", index))
		}
		indexes = append(indexes, index)
	}
	for index := range outputs {
		if _, ok := inputs[index]; !ok {
			return nil, workerdomain.MarkNonRetryable(fmt.Errorf("missing input file for testcase %d", index))
		}
	}
	sort.Ints(indexes)
	if len(indexes) != testCount {
		return nil, workerdomain.MarkNonRetryable(
			fmt.Errorf("testcase count mismatch: metadata=%d files=%d", testCount, len(indexes)),
		)
	}

	testCases := make([]outbound.ExecutionTestCase, 0, len(indexes))
	for sequence, index := range indexes {
		stdinBytes, err := os.ReadFile(inputs[index])
		if err != nil {
			return nil, fmt.Errorf("read input file for testcase %d: %w", index, err)
		}
		expectedBytes, err := os.ReadFile(outputs[index])
		if err != nil {
			return nil, fmt.Errorf("read output file for testcase %d: %w", index, err)
		}
		expected := string(expectedBytes)
		testCases = append(testCases, outbound.ExecutionTestCase{
			Index:            sequence + 1,
			ID:               strconv.Itoa(index),
			Kind:             "official",
			Stdin:            string(stdinBytes),
			SandboxInputPath: inputs[index],
			ExpectedOutput:   &expected,
		})
	}
	return testCases, nil
}
