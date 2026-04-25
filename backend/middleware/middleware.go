// Package middleware provides HTTP middleware for the Lumina-Core backend.
package middleware

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// contextKey is an unexported type for context keys set by this package.
type contextKey string

// ContextKeyUID is the context key under which the authenticated Pi UID is
// stored after successful JWT validation.
const ContextKeyUID contextKey = "uid"

// ─── RequestLogger ────────────────────────────────────────────────────────────

// MinJWTSecretLen is the minimum acceptable byte length for the JWT_SECRET
// environment variable.  Both the token issuer and validator enforce this.
const MinJWTSecretLen = 32

// RequestLogger logs the method, path, and elapsed time of every request.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(lrw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, lrw.statusCode, time.Since(start))
	})
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

// ─── SecurityHeaders ──────────────────────────────────────────────────────────

// SecurityHeaders sets secure HTTP response headers on every response.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// ─── RequireJWT ───────────────────────────────────────────────────────────────

// RequireJWT validates the Bearer JWT in the Authorization header and stores
// the authenticated Pi UID in the request context.
func RequireJWT(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, `{"error":"missing or malformed Authorization header"}`, http.StatusUnauthorized)
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		secret := os.Getenv("JWT_SECRET")
		if len(secret) < MinJWTSecretLen {
			log.Println("JWT_SECRET is not configured or too short")
			http.Error(w, `{"error":"server misconfiguration"}`, http.StatusInternalServerError)
			return
		}

		token, err := jwt.Parse(tokenString, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(secret), nil
		},
			jwt.WithIssuer("lumina-core"),
			jwt.WithAudience("lumina-client"),
			jwt.WithExpirationRequired(),
		)
		if err != nil || !token.Valid {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, `{"error":"malformed token claims"}`, http.StatusUnauthorized)
			return
		}

		uid, _ := claims["sub"].(string)
		if uid == "" {
			http.Error(w, `{"error":"token missing subject"}`, http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), ContextKeyUID, uid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
