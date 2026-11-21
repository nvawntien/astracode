package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	pkgauth "go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"
	"go-judge-system/services/auth/internal/application/dto"
	"go-judge-system/services/auth/internal/application/port/outbound"
	"go-judge-system/services/auth/internal/domain"
	"go-judge-system/services/auth/internal/domain/entity"
)

func TestLoginAndRefreshRequireSupportedRoles(t *testing.T) {
	for _, test := range []struct {
		name      string
		role      rbac.Role
		supported bool
	}{
		{name: "user", role: rbac.RoleUser, supported: true},
		{name: "moderator", role: rbac.RoleModerator, supported: true},
		{name: "admin", role: rbac.RoleAdmin, supported: true},
		{name: "retired role", role: "contributor"},
		{name: "unknown role", role: "owner"},
		{name: "missing role"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			user := testSessionUser()
			user.Role = test.role
			repo := &sessionUserRepository{user: user}
			store := &sessionIATStore{}
			loginSigner := &sessionJWT{}
			login := NewLoginUseCase(repo, sessionPasswordEncoder{}, loginSigner, store)
			_, loginErr := login.Execute(ctx, dto.LoginRequest{Identifier: user.Username, Password: "correct"})

			// A still-valid refresh token carries its original role after role assignment.
			user.Role = rbac.RoleUser
			refreshSigner := &sessionJWT{refreshRole: &test.role, refreshIAT: 101}
			refresh := NewRefreshTokenUseCase(refreshSigner, repo, store)
			_, refreshErr := refresh.Execute(ctx, "refresh")
			if !test.supported {
				if !errors.Is(loginErr, domain.ErrInvalidCredentials) || loginSigner.accessCalls != 0 ||
					!errors.Is(refreshErr, domain.ErrInvalidOrExpiredToken) || refreshSigner.accessCalls != 0 {
					t.Fatalf("login error/calls = %v/%d, refresh error/calls = %v/%d", loginErr, loginSigner.accessCalls, refreshErr, refreshSigner.accessCalls)
				}
				return
			}
			if loginErr != nil || refreshErr != nil {
				t.Fatalf("login error = %v, refresh error = %v", loginErr, refreshErr)
			}
			if _, err := refresh.Execute(ctx, "refresh"); err != nil {
				t.Fatalf("reusing still-valid refresh token: %v", err)
			}
			for _, signer := range []*sessionJWT{loginSigner, refreshSigner} {
				if signer.issuedAccessRole != test.role || signer.issuedRefreshRole != test.role {
					t.Errorf("issued access/refresh roles = %q/%q, want %q", signer.issuedAccessRole, signer.issuedRefreshRole, test.role)
				}
			}
		})
	}
}

func TestLoginRejectsSuspendedUser(t *testing.T) {
	user := testSessionUser()
	user.IsSuspended = true
	jwt := &sessionJWT{}
	uc := NewLoginUseCase(&sessionUserRepository{user: user}, sessionPasswordEncoder{}, jwt, &sessionIATStore{})
	_, err := uc.Execute(context.Background(), dto.LoginRequest{Identifier: user.Username, Password: "correct"})
	if !errors.Is(err, domain.ErrUserSuspended) || jwt.accessCalls != 0 {
		t.Fatalf("error=%v accessCalls=%d", err, jwt.accessCalls)
	}
}

func TestRefreshRejectsSuspendedAndInvalidatedUser(t *testing.T) {
	user := testSessionUser()
	user.IsSuspended = true
	jwt := &sessionJWT{refreshIAT: time.Now().Unix() + 1}
	uc := NewRefreshTokenUseCase(jwt, &sessionUserRepository{user: user}, &sessionIATStore{})
	_, err := uc.Execute(context.Background(), "refresh")
	if !errors.Is(err, domain.ErrUserSuspended) || jwt.accessCalls != 0 {
		t.Fatalf("suspended refresh error=%v accessCalls=%d", err, jwt.accessCalls)
	}

	user.IsSuspended = false
	jwt.accessCalls = 0
	_, err = NewRefreshTokenUseCase(jwt, &sessionUserRepository{user: user}, &sessionIATStore{value: jwt.refreshIAT}).Execute(context.Background(), "refresh")
	if !errors.Is(err, domain.ErrInvalidOrExpiredToken) || jwt.accessCalls != 0 {
		t.Fatalf("invalidated refresh error=%v accessCalls=%d", err, jwt.accessCalls)
	}
}

func TestLoginAfterUnsuspensionUsesFreshAuthenticationWithoutClearingCutoff(t *testing.T) {
	user := testSessionUser()
	cutoff := time.Now().Unix() - 1
	store := &sessionIATStore{value: cutoff}
	jwt := &sessionJWT{}
	res, err := NewLoginUseCase(&sessionUserRepository{user: user}, sessionPasswordEncoder{}, jwt, store).Execute(context.Background(), dto.LoginRequest{Identifier: user.Username, Password: "correct"})
	if err != nil || res.AccessToken == "" || jwt.accessCalls != 1 || store.value != cutoff {
		t.Fatalf("response=%+v error=%v accessCalls=%d cutoff=%d", res, err, jwt.accessCalls, store.value)
	}
}

type sessionUserRepository struct {
	user *entity.User
	err  error
}

func (r *sessionUserRepository) CreateUser(context.Context, *entity.User) error { return nil }
func (r *sessionUserRepository) GetUserByEmail(context.Context, string) (*entity.User, error) {
	return r.user, r.err
}
func (r *sessionUserRepository) GetUserByUsername(context.Context, string) (*entity.User, error) {
	return r.user, r.err
}
func (r *sessionUserRepository) GetUserById(context.Context, string) (*entity.User, error) {
	return r.user, r.err
}
func (r *sessionUserRepository) ListUsers(context.Context, outbound.ListUsersFilter) (outbound.ListUsersResult, error) {
	return outbound.ListUsersResult{}, nil
}
func (r *sessionUserRepository) SearchPublicUsers(context.Context, outbound.SearchPublicUsersFilter) (outbound.SearchPublicUsersResult, error) {
	return outbound.SearchPublicUsersResult{}, nil
}
func (r *sessionUserRepository) UpdateUser(context.Context, *entity.User) error { return nil }
func (r *sessionUserRepository) UpdatePassword(context.Context, string, string, time.Time) error {
	return nil
}
func (r *sessionUserRepository) UpdateProfile(context.Context, string, outbound.ProfileUpdates) error {
	return nil
}
func (r *sessionUserRepository) UpdateAvatar(context.Context, string, string, string, time.Time) error {
	return nil
}
func (r *sessionUserRepository) DeleteUser(context.Context, string) error { return nil }

type sessionPasswordEncoder struct{}

func (sessionPasswordEncoder) HashAndSalt([]byte) (string, error) { return "", nil }
func (sessionPasswordEncoder) ComparePasswords(_ string, provided []byte) bool {
	return string(provided) == "correct"
}

type sessionJWT struct {
	refreshIAT        int64
	refreshRole       *rbac.Role
	accessCalls       int
	issuedAccessRole  rbac.Role
	issuedRefreshRole rbac.Role
}

func (j *sessionJWT) GenerateAccessToken(_ context.Context, _, _ string, role rbac.Role) (string, int, error) {
	j.accessCalls++
	j.issuedAccessRole = role
	return "access", 60, nil
}
func (j *sessionJWT) GenerateRefreshToken(_ context.Context, _, _ string, role rbac.Role) (string, int, error) {
	j.issuedRefreshRole = role
	return "refresh", 60, nil
}
func (j *sessionJWT) VerifyAccessToken(context.Context, string) (string, string, rbac.Role, error) {
	return "", "", "", nil
}
func (j *sessionJWT) VerifyRefreshToken(context.Context, string) (string, string, rbac.Role, int64, error) {
	role := rbac.RoleUser
	if j.refreshRole != nil {
		role = *j.refreshRole
	}
	return "a1cdbf51-5bd4-416d-a74e-35e3cb7b5f83", "session-user", role, j.refreshIAT, nil
}

type sessionIATStore struct {
	value int64
	err   error
}

func (s *sessionIATStore) SetLogoutAllIAT(context.Context, string, int64) error { return s.err }
func (s *sessionIATStore) GetLogoutAllIAT(context.Context, string) (int64, error) {
	return s.value, s.err
}

func testSessionUser() *entity.User {
	return &entity.User{
		ID:       "a1cdbf51-5bd4-416d-a74e-35e3cb7b5f83",
		Username: "session-user",
		Email:    "session@example.test",
		Password: "hash",
		Role:     rbac.RoleUser,
		IsActive: true,
	}
}

var _ outbound.UserRepository = (*sessionUserRepository)(nil)
var _ outbound.JWTProvider = (*sessionJWT)(nil)
var _ pkgauth.LogoutAllIATStore = (*sessionIATStore)(nil)
