// Command astra-launch-guard supervises a fixed child under short-lived host
// authorization. The host owns the mounted directory and the issuing key.
package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

type permit struct {
	Environment  string    `json:"environment"`
	Session      string    `json:"session"`
	Operation    string    `json:"operation"`
	AppEpoch     string    `json:"app_epoch"`
	JudgeEpoch   string    `json:"judge_epoch"`
	Workload     string    `json:"workload"`
	Image        string    `json:"image"`
	Config       string    `json:"config"`
	PodUID       string    `json:"pod_uid"`
	PIDNamespace string    `json:"pid_namespace"`
	Issued       time.Time `json:"issued"`
	Expires      time.Time `json:"expires"`
}

type envelope struct {
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

func readPermit(dir, workload, uid string, now time.Time) (permit, error) {
	var p permit
	var e envelope
	key, err := os.ReadFile(filepath.Join(dir, "issuer.pub"))
	if err != nil {
		return p, err
	}
	public, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(key)))
	if err != nil || len(public) != ed25519.PublicKeySize {
		return p, errors.New("invalid issuer")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "permit.json"))
	if err != nil {
		return p, err
	}
	if json.Unmarshal(raw, &e) != nil || !ed25519.Verify(public, e.Payload, e.Signature) || json.Unmarshal(e.Payload, &p) != nil {
		return p, errors.New("invalid permit")
	}
	// The host verifies the running Pod UID, digest and both epochs before
	// updating this binding. Its removal revokes an already running child.
	expected, err := os.ReadFile(filepath.Join(dir, "binding.json"))
	var binding permit
	if err != nil || json.Unmarshal(expected, &binding) != nil {
		return p, errors.New("missing host binding")
	}
	namespace, err := os.Readlink("/proc/self/ns/pid")
	if err != nil || namespace != p.PIDNamespace || uid == "" || p.Workload != workload || p.PodUID != uid || p.Session == "" || p.Operation == "" ||
		p.Environment == "" || p.AppEpoch == "" || p.JudgeEpoch == "" || p.Image == "" || p.Config == "" ||
		now.Before(p.Issued) || !now.Before(p.Expires) || p.Expires.Sub(p.Issued) > 30*time.Second {
		return p, errors.New("invalid permit scope or lifetime")
	}
	identity := p
	identity.Issued, identity.Expires = time.Time{}, time.Time{}
	if identity != binding {
		return p, errors.New("wrong host binding")
	}
	return identity, nil
}

func supervise(dir, workload, uid string, command []string) error {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stop)
	// Pod UID and container image status become visible after admission.
	// Keep a newly created, single-attempt Job closed while the host binds it.
	until := time.Now().Add(30 * time.Second)
	initial, err := readPermit(dir, workload, uid, time.Now())
	for err != nil {
		if time.Now().After(until) {
			return errors.New("workload authorization unavailable")
		}
		select {
		case <-stop:
			return errors.New("workload stopped before authorization")
		case <-time.After(250 * time.Millisecond):
		}
		initial, err = readPermit(dir, workload, uid, time.Now())
	}
	child := exec.Command(command[0], command[1:]...)
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	if err = child.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err = <-done:
			return err
		case <-stop:
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
			select {
			case err = <-done:
				return err
			case <-time.After(time.Second):
			}
		case <-ticker.C:
			current, err := readPermit(dir, workload, uid, time.Now())
			if err == nil && current == initial {
				continue
			}
		}
		_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
		<-done
		return errors.New("workload stopped")
	}
}

func main() {
	if len(os.Args) < 4 || os.Args[2] != "--" {
		os.Exit(2)
	}
	if err := supervise("/run/astra/permits", os.Args[1], os.Getenv("ASTRA_POD_UID"), os.Args[3:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
