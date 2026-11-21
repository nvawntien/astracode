package rbac

type Role string

const (
	RoleUser      Role = "user"
	RoleModerator Role = "moderator"
	RoleAdmin     Role = "admin"
)

func (r Role) Level() int {
	switch r {
	case RoleUser:
		return 1
	case RoleModerator:
		return 3
	case RoleAdmin:
		return 4
	default:
		return 0
	}
}

func (r Role) AtLeast(min Role) bool {
	minLevel := min.Level()
	return minLevel > 0 && r.Level() >= minLevel
}

func ParseRole(value string) (Role, bool) {
	role := Role(value)
	return role, role.Level() > 0
}
