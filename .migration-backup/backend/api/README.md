# api/

This directory holds machine-readable API definitions for the Lumina-Core backend.

## Planned contents

| File | Purpose |
|------|---------|
| `openapi.yaml` | OpenAPI 3.1 specification for all REST endpoints |
| `proto/` | Protocol Buffers definitions (if gRPC is adopted in a future phase) |

These artifacts are auto-generated or hand-authored and consumed by client SDKs,
documentation generators, and integration test suites.
