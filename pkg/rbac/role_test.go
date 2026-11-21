package rbac

import "testing"

func TestSupportedRoles(t *testing.T) {
	roles := []Role{RoleUser, RoleModerator, RoleAdmin}
	for roleIndex, role := range roles {
		if parsed, ok := ParseRole(string(role)); !ok || parsed != role {
			t.Fatalf("ParseRole(%q) = %q, %t", role, parsed, ok)
		}
		for minimumIndex, minimum := range roles {
			if got, want := role.AtLeast(minimum), roleIndex >= minimumIndex; got != want {
				t.Errorf("%q.AtLeast(%q) = %t, want %t", role, minimum, got, want)
			}
		}
	}
}

func TestUnsupportedRolesFailClosed(t *testing.T) {
	for _, role := range []Role{"", "contributor", "owner"} {
		if _, ok := ParseRole(string(role)); ok {
			t.Errorf("ParseRole(%q) accepted an unsupported role", role)
		}
		if role.AtLeast(RoleUser) || RoleAdmin.AtLeast(role) || role.AtLeast(role) {
			t.Errorf("authorization accepted %q as an actor or minimum role", role)
		}
	}
}
