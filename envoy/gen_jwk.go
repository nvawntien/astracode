package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

type JWK struct {
	Kty string `json:"kty"`
	K   string `json:"k"`
	Alg string `json:"alg"`
	Use string `json:"use"`
}

type JWKS struct {
	Keys []JWK `json:"keys"`
}

func main() {
	replace := flag.Bool("replace", false, "intentionally replace the local JWK")
	flag.Parse()

	secret := os.Getenv("JWT_ACCESS_SECRET")
	if secret == "" {
		fmt.Fprintln(os.Stderr, "JWT_ACCESS_SECRET is required")
		os.Exit(1)
	}

	key := JWK{
		Kty: "oct",
		K:   base64.RawURLEncoding.EncodeToString([]byte(secret)),
		Alg: "HS256",
		Use: "sig",
	}
	outputPath := os.Getenv("JWK_OUTPUT_PATH")
	if outputPath == "" {
		outputPath = "symmetric.json"
	}

	written, err := prepareJWK(outputPath, key, *replace)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if written {
		fmt.Printf("Generated %s successfully.\n", outputPath)
	} else {
		fmt.Printf("Verified %s successfully.\n", outputPath)
	}
}

func prepareJWK(path string, key JWK, replace bool) (written bool, err error) {
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("inspect local JWK: %w", err)
	}
	if info != nil {
		if !info.Mode().IsRegular() {
			return false, fmt.Errorf("local JWK at %q must be a regular file. Choose a regular file path for JWK_OUTPUT_PATH", path)
		}
		if !replace {
			return false, checkJWK(path, key, info)
		}
	}

	data, err := json.MarshalIndent(JWKS{Keys: []JWK{key}}, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal local JWKS: %w", err)
	}
	if info == nil {
		err = createJWK(path, data)
	} else {
		err = replaceJWK(path, data, info)
	}
	if err != nil {
		return false, fmt.Errorf("write local JWK: %w", err)
	}
	return true, nil
}

func checkJWK(path string, expected JWK, info os.FileInfo) error {
	if info.Mode() != 0600 {
		return fmt.Errorf("local JWK at %q must have mode 0600 (found %s). Restrict the file with chmod 600 before retrying", path, info.Mode())
	}

	// A path swapped after Lstat must not make validation follow a symlink or block on a pipe.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return fmt.Errorf("open local JWK without following symlinks: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return fmt.Errorf("inspect open local JWK: %w", err)
	}
	if !os.SameFile(info, opened) || opened.Mode() != 0600 {
		return fmt.Errorf("local JWK at %q changed during validation. Check the file and retry", path)
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return fmt.Errorf("read local JWK: %w", err)
	}

	var jwks JWKS
	if json.Unmarshal(data, &jwks) != nil || len(jwks.Keys) != 1 || jwks.Keys[0] != expected {
		return fmt.Errorf(
			"local JWK at %s is invalid or does not match JWT_ACCESS_SECRET. Check Auth's local env file and follow envoy/README.md#configuration-and-secrets for intentional replacement",
			path,
		)
	}
	return nil
}

func createJWK(path string, data []byte) error {
	// A file created after the check must not be overwritten by startup.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if err := writeJWK(file, data); err != nil {
		return errors.Join(err, os.Remove(path))
	}
	return nil
}

func replaceJWK(path string, data []byte, original os.FileInfo) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".jwk-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := writeJWK(file, data); err != nil {
		return err
	}

	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(original, current) {
		return fmt.Errorf("local JWK at %q changed during replacement. Check the file and retry", path)
	}
	// Rename replaces the directory entry without writing through it.
	return os.Rename(file.Name(), path)
}

func writeJWK(file *os.File, data []byte) error {
	if err := file.Chmod(0600); err != nil {
		return errors.Join(err, file.Close())
	}
	_, err := file.Write(data)
	return errors.Join(err, file.Close())
}
