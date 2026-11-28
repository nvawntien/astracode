package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSignedPermitAndRevocation(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	p := permit{Environment: "s3", Session: "session", Operation: "operation", AppEpoch: "app-epoch", JudgeEpoch: "judge-epoch", Workload: "go-judge", Image: "image-digest", Config: "config-digest", PodUID: "pod-uid"}
	namespace, err := os.Readlink("/proc/self/ns/pid")
	if err != nil {
		t.Fatal(err)
	}
	p.PIDNamespace = namespace
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(p)
	write("binding.json", raw)
	write("issuer.pub", []byte(base64.StdEncoding.EncodeToString(pub)))
	p.Issued, p.Expires = now.Add(-time.Second), now.Add(20*time.Second)
	raw, _ = json.Marshal(p)
	signed, _ := json.Marshal(envelope{Payload: raw, Signature: ed25519.Sign(key, raw)})
	write("permit.json", signed)
	for _, tc := range []struct {
		name, workload, uid string
		at                  time.Time
		allowed             bool
	}{
		{"valid", "go-judge", "pod-uid", now, true},
		{"expired", "go-judge", "pod-uid", p.Expires, false},
		{"future", "go-judge", "pod-uid", p.Issued.Add(-time.Second), false},
		{"other-pod", "go-judge", "replaced", now, false},
		{"other-workload", "judge-worker", "pod-uid", now, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readPermit(dir, tc.workload, tc.uid, tc.at)
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v, err=%v", tc.allowed, err)
			}
		})
	}
	result := make(chan error, 1)
	started := filepath.Join(dir, "started")
	go func() {
		result <- supervise(dir, "go-judge", "pod-uid", []string{"sh", "-c", "touch \"$1\" && exec sleep 30", "test", started})
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.Remove(filepath.Join(dir, "binding.json")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("revoked child reported success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("child survived revocation")
	}
	if _, err := readPermit(dir, "go-judge", "pod-uid", now); err == nil {
		t.Fatal("stale permit survived host restart")
	}
	p.Issued, p.Expires = time.Time{}, time.Time{}
	p.PIDNamespace = "pid:[0]"
	raw, _ = json.Marshal(p)
	write("binding.json", raw)
	p.Issued, p.Expires = now.Add(-time.Second), now.Add(20*time.Second)
	raw, _ = json.Marshal(p)
	signed, _ = json.Marshal(envelope{Payload: raw, Signature: ed25519.Sign(key, raw)})
	write("permit.json", signed)
	if _, err := readPermit(dir, "go-judge", "pod-uid", now); err == nil {
		t.Fatal("permit for a previous container PID namespace was accepted")
	}
}
