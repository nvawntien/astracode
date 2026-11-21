package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go-judge-system/pkg/auth"
	"go-judge-system/pkg/rbac"

	"github.com/gin-gonic/gin"
)

func TestAuthMiddlewareRequiresSupportedRole(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name   string
		userID string
		role   rbac.Role
		status int
	}{
		{name: "user", userID: "user-1", role: rbac.RoleUser, status: http.StatusNoContent},
		{name: "moderator", userID: "user-1", role: rbac.RoleModerator, status: http.StatusNoContent},
		{name: "admin", userID: "user-1", role: rbac.RoleAdmin, status: http.StatusNoContent},
		{name: "missing identity", role: rbac.RoleUser, status: http.StatusUnauthorized},
		{name: "missing role", userID: "user-1", status: http.StatusUnauthorized},
		{name: "retired role", userID: "user-1", role: "contributor", status: http.StatusForbidden},
		{name: "unknown role", userID: "user-1", role: "owner", status: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.Use(NewAuthMiddleware(middlewareIATStore{cutoff: 100}))
			router.GET("/protected", func(c *gin.Context) {
				claims, ok := auth.GetClaims(c)
				if !ok || claims.UserID != test.userID || claims.Role != test.role || claims.TokenIssuedAt != 101 {
					t.Errorf("claims = %+v, present = %t", claims, ok)
				}
				c.Status(http.StatusNoContent)
			})

			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			req.Header.Set("X-User-ID", test.userID)
			req.Header.Set("X-Token-Iat", "101")
			req.Header.Set("X-Role", string(test.role))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
		})
	}
}

func TestAuthMiddlewareRejectsTokenAtOrBeforeInvalidationCutoff(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(NewAuthMiddleware(middlewareIATStore{cutoff: 100}))
	router.GET("/protected", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("X-User-ID", "user-1")
	req.Header.Set("X-Token-Iat", "100")
	req.Header.Set("X-Role", "user")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

type middlewareIATStore struct{ cutoff int64 }

func (s middlewareIATStore) SetLogoutAllIAT(context.Context, string, int64) error { return nil }
func (s middlewareIATStore) GetLogoutAllIAT(context.Context, string) (int64, error) {
	return s.cutoff, nil
}

var _ auth.LogoutAllIATStore = middlewareIATStore{}
