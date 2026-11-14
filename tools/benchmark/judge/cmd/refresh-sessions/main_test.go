package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseDefaultsAndRejectsInvalidArguments(t *testing.T) {
	opts, err := parse([]string{"--base-url", "https://astracode.test", "--allow-remote", "--confirm-target-host", "astracode.test", "--replace"}, &bytes.Buffer{})
	if err != nil || opts.userCount != 100000 || opts.concurrency <= 0 || !opts.replace {
		t.Fatalf("opts=%+v err=%v", opts, err)
	}
	for _, args := range [][]string{
		{},
		{"--base-url", "https://astracode.test", "unexpected"},
		{"--base-url", "https://astracode.test", "--concurrency", "not-a-number"},
	} {
		if _, err := parse(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("parse(%q) succeeded", args)
		}
	}
}

func TestSafeErrorNeverEchoesCredentialLikeText(t *testing.T) {
	secret := "refresh-token-sentinel"
	if value := safeError(errors.New(secret)); strings.Contains(value, secret) {
		t.Fatalf("safe error leaked secret: %q", value)
	}
	if value := safeError(context.Canceled); !strings.Contains(value, "not replaced") {
		t.Fatalf("cancel=%q", value)
	}
}
