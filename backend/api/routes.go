// Package api contains route registration helpers and API contract types for
// the Lumina-Core backend.
//
// Route groups:
//   - Public  – unauthenticated endpoints (e.g. /auth/pi-handshake)
//   - Protected – JWT-gated endpoints (e.g. /vault/create, /sig/validate)
//
// TODO (Phase 2): Move OpenAPI/Swagger spec generation here and wire in
// auto-generated client SDKs for the Pi Network frontend.
package api
