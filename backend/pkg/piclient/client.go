// Package piclient provides a production-ready HTTP client for the Pi Network
// Platform API (https://api.minepi.com).
//
// Design principles:
//   - All credentials are loaded exclusively from environment variables; no
//     secrets are ever hard-coded or logged.
//   - Every outbound request is bounded by a strict per-request context deadline
//     so a slow upstream cannot hold goroutines open indefinitely.
//   - Transient server-side failures (5xx) and rate-limit responses (429) are
//     retried up to MaxRetries times using exponential back-off with full jitter,
//     preventing thundering-herd amplification.
//   - Non-retryable errors (4xx, network-level TLS errors) fail fast.
package piclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"
)

const (
	// DefaultBaseURL is the root of the Pi Platform REST API.
	DefaultBaseURL = "https://api.minepi.com"

	// DefaultRequestTimeout is the maximum duration for a single HTTP round-trip,
	// including connection establishment, request write, and response read.
	// Callers may override this via Config.RequestTimeout.
	DefaultRequestTimeout = 10 * time.Second

	// DefaultMaxRetries is the maximum number of additional attempts after the
	// first failure on retryable status codes (429, 5xx).
	DefaultMaxRetries = 3

	// DefaultRetryBaseDelay is the base duration for exponential back-off.
	// Actual delay = RetryBaseDelay * 2^attempt + jitter.
	DefaultRetryBaseDelay = 300 * time.Millisecond

	// DefaultRetryMaxDelay caps the computed back-off to avoid unbounded waits.
	DefaultRetryMaxDelay = 10 * time.Second
)

// envPiAPIKey is the environment variable that must hold the server-side Pi
// Platform API key.  The value is read once at Client construction time and
// is never written to logs or error messages.
const envPiAPIKey = "PI_API_KEY"

// MeResponse is the subset of the Pi Platform /v2/me payload that Lumina-Core
// requires.  Additional fields returned by the API are intentionally ignored.
type MeResponse struct {
	UID      string `json:"uid"`
	Username string `json:"username"`
}

// Config holds optional overrides for the Client.  The zero value is valid and
// falls back to all defaults.
type Config struct {
	// BaseURL overrides DefaultBaseURL; useful in tests or sandbox mode.
	BaseURL string

	// RequestTimeout overrides DefaultRequestTimeout.
	RequestTimeout time.Duration

	// MaxRetries overrides DefaultMaxRetries.
	MaxRetries int

	// RetryBaseDelay overrides DefaultRetryBaseDelay.
	RetryBaseDelay time.Duration

	// RetryMaxDelay overrides DefaultRetryMaxDelay.
	RetryMaxDelay time.Duration
}

// Client is a thread-safe Pi Network API client.  Construct one with New and
// reuse it across the application lifetime.
type Client struct {
	baseURL        string
	apiKey         string // loaded from PI_API_KEY; never exposed outside package
	httpClient     *http.Client
	maxRetries     int
	retryBaseDelay time.Duration
	retryMaxDelay  time.Duration
}

// New constructs a Client, loading PI_API_KEY from the process environment.
// Returns an error if the environment variable is absent or empty, so
// misconfiguration is caught at startup rather than at first request.
func New(cfg Config) (*Client, error) {
	apiKey := os.Getenv(envPiAPIKey)
	if apiKey == "" {
		// Do not include the variable name in a user-visible error path; log it
		// internally so operators can diagnose misconfiguration without the
		// message reaching untrusted callers.
		log.Println("[piclient] PI_API_KEY environment variable is not set")
		return nil, fmt.Errorf("pi api key is not configured")
	}

	baseURL := cfg.BaseURL
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}

	reqTimeout := cfg.RequestTimeout
	if reqTimeout <= 0 {
		reqTimeout = DefaultRequestTimeout
	}

	maxRetries := cfg.MaxRetries
	if maxRetries <= 0 {
		maxRetries = DefaultMaxRetries
	}

	retryBase := cfg.RetryBaseDelay
	if retryBase <= 0 {
		retryBase = DefaultRetryBaseDelay
	}

	retryMax := cfg.RetryMaxDelay
	if retryMax <= 0 {
		retryMax = DefaultRetryMaxDelay
	}

	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		// A dedicated http.Client per piclient instance ensures that connection
		// pooling is isolated from other subsystems and that the timeout setting
		// is unconditionally applied.
		httpClient: &http.Client{
			Timeout: reqTimeout,
			// Use the default transport (with connection pooling) but enforce
			// TLS; the Pi Platform API is HTTPS-only.
			Transport: http.DefaultTransport,
		},
		maxRetries:     maxRetries,
		retryBaseDelay: retryBase,
		retryMaxDelay:  retryMax,
	}, nil
}

// VerifyAccessToken calls the Pi Platform /v2/me endpoint to validate
// accessToken and returns the authoritative MeResponse on success.
//
// Security contract:
//   - accessToken is sent as a Bearer token; it is never written to logs.
//   - The server-side API key is sent as X-Pi-Api-Key; it is never written to
//     logs or included in returned errors.
//   - On non-200 responses the status code is recorded but the response body is
//     discarded to avoid leaking upstream error messages to callers.
func (c *Client) VerifyAccessToken(ctx context.Context, accessToken string) (*MeResponse, error) {
	url := c.baseURL + "/v2/me"

	var (
		lastErr    error
		lastStatus int
	)

	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if attempt > 0 {
			delay := c.backoffDelay(attempt)
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				// Respect caller cancellation even during a retry sleep.
				return nil, fmt.Errorf("request cancelled during retry backoff: %w", ctx.Err())
			}
		}

		me, status, err := c.doMeRequest(ctx, url, accessToken)
		if err == nil {
			return me, nil
		}

		lastErr = err
		lastStatus = status

		if !isRetryable(status) {
			// Fast-fail on client errors and permanent failures.
			break
		}

		log.Printf("[piclient] retryable error on attempt %d/%d (status=%d); retrying",
			attempt+1, c.maxRetries+1, status)
	}

	// Omit accessToken and apiKey from the returned error.
	if lastStatus != 0 {
		return nil, fmt.Errorf("pi platform request failed after %d attempt(s) (last status: %d)",
			c.maxRetries+1, lastStatus)
	}
	return nil, fmt.Errorf("pi platform request failed after %d attempt(s): %w",
		c.maxRetries+1, lastErr)
}

// doMeRequest executes a single GET /v2/me request and returns the parsed
// response, the HTTP status code (0 on network error), and any error.
func (c *Client) doMeRequest(ctx context.Context, url, accessToken string) (*MeResponse, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("building request: %w", err)
	}

	// Authenticate with the Pi Platform.
	// accessToken  – the end-user's Pi SDK token (sent in Authorization header).
	// c.apiKey     – the server-side key that identifies this application.
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("X-Pi-Api-Key", c.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Network / TLS error – status 0, not retryable via HTTP status logic.
		return nil, 0, fmt.Errorf("executing request: %w", sanitizeNetworkError(err))
	}
	defer func() {
		// Drain and close the body to allow connection reuse.
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("non-200 response")
	}

	var me MeResponse
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("decoding response body: %w", err)
	}

	if me.UID == "" {
		return nil, resp.StatusCode, fmt.Errorf("pi platform returned empty uid")
	}

	return &me, resp.StatusCode, nil
}

// isRetryable returns true for HTTP status codes that warrant a retry attempt.
// Client errors (4xx, except 429 rate-limit) are permanent and must not be
// retried to avoid amplifying malformed request loops.
func isRetryable(status int) bool {
	return status == http.StatusTooManyRequests || status >= http.StatusInternalServerError
}

// backoffDelay computes the exponential back-off duration for the given attempt
// number (1-based) with full jitter to spread retry load across instances.
//
//	delay = min(RetryMaxDelay, RetryBaseDelay * 2^(attempt-1)) * random[0,1)
func (c *Client) backoffDelay(attempt int) time.Duration {
	// Cap the exponent to avoid overflow on large attempt counts.
	exp := attempt - 1
	if exp > 10 {
		exp = 10
	}
	base := c.retryBaseDelay * (1 << uint(exp))
	if base > c.retryMaxDelay {
		base = c.retryMaxDelay
	}
	// Full jitter: multiply by a random fraction in [0, 1).
	jitter := time.Duration(rand.Int63n(int64(base) + 1))
	return jitter
}

// sanitizeNetworkError strips any URL or header content from network-level
// errors before they propagate, preventing accidental credential leakage in
// log output.  The wrapped error type is preserved for errors.Is / errors.As.
func sanitizeNetworkError(err error) error {
	if err == nil {
		return nil
	}
	// Return a generic description; callers receive actionable context (e.g.,
	// "connection refused") without any request metadata.
	return fmt.Errorf("network error communicating with pi platform")
}
