package schema

import "fmt"

// Receipt binds a verified local activation to one launch and migration bundle.
type Receipt struct {
	Run      string           `json:"run"`
	Bundle   string           `json:"bundle"`
	Revision string           `json:"revision"`
	Instance string           `json:"instance"`
	Targets  []VerifiedTarget `json:"targets"`
}

type VerifiedTarget struct {
	Owner      string `json:"owner"`
	Generation string `json:"generation"`
	OID        uint32 `json:"database_oid"`
	Version    int    `json:"version"`
}

func (r Receipt) Verify(run, bundle, owner string, oid uint32, version int) error {
	if run == "" || bundle == "" || r.Run != run || r.Bundle != bundle ||
		r.Revision == "" || r.Instance == "" || len(r.Targets) != 3 {
		return fmt.Errorf("missing verification for the current local migration run")
	}
	matched := false
	for i, expected := range []string{"auth", "problem", "submission"} {
		t := r.Targets[i]
		if t.Owner != expected || t.Generation == "" || t.OID == 0 || t.Version < 1 {
			return fmt.Errorf("local migration receipt does not cover %s", expected)
		}
		if t.Owner == owner {
			matched = t.OID == oid && t.Version == version
		}
	}
	if !matched {
		return fmt.Errorf("local migration receipt does not match the %s database", owner)
	}
	return nil
}
