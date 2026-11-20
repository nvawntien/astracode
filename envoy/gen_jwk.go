package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
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

	if !*replace {
		found, err := checkJWK(outputPath, key)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if found {
			fmt.Printf("Verified %s successfully.\n", outputPath)
			return
		}
	}

	data, err := json.MarshalIndent(JWKS{Keys: []JWK{key}}, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error marshalling JWKS:", err)
		os.Exit(1)
	}

	if *replace {
		err = os.WriteFile(outputPath, data, 0600)
	} else {
		err = createJWK(outputPath, data)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error writing JWK:", err)
		os.Exit(1)
	}
	if err := os.Chmod(outputPath, 0600); err != nil {
		fmt.Fprintln(os.Stderr, "Error securing output file:", err)
		os.Exit(1)
	}

	fmt.Printf("Generated %s successfully.\n", outputPath)
}

func checkJWK(path string, expected JWK) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read local JWK: %w", err)
	}

	var jwks JWKS
	if json.Unmarshal(data, &jwks) != nil || len(jwks.Keys) != 1 || jwks.Keys[0] != expected {
		return false, fmt.Errorf(
			"local JWK at %s is invalid or does not match JWT_ACCESS_SECRET. Check Auth's local env file and follow envoy/README.md#configuration-and-secrets for intentional replacement",
			path,
		)
	}
	return true, nil
}

func createJWK(path string, data []byte) error {
	// A file created after the check must not be overwritten by startup.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return errors.Join(err, os.Remove(path))
	}
	return nil
}
