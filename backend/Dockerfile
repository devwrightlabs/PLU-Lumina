# ──────────────────────────────────────────────────────────────────────────────
# Stage 1 — Builder
#
# Use the official Go image pinned to the exact minor version in go.mod.
# alpine base keeps the layer small; CGO_ENABLED=0 produces a fully static
# binary that can run inside the distroless/scratch runtime stage without any
# shared-library dependencies.
# ──────────────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS builder

# Install only the tools required for the build step.
# ca-certificates is needed at build-time for `go mod download` over HTTPS.
RUN apk add --no-cache ca-certificates git

WORKDIR /build

# Copy dependency manifests first so Docker cache reuse is maximised — the
# expensive `go mod download` layer is only invalidated when go.mod / go.sum
# actually change, not on every source edit.
COPY go.mod go.sum ./
RUN go mod download

# Copy the remaining source and compile.
# TARGETARCH is injected by Docker Buildx when building multi-platform images
# (e.g. linux/amd64 and linux/arm64).  This single build stage covers all
# target platforms without requiring separate Dockerfile variants.
# -trimpath removes host filesystem paths from the binary (hardening).
# -ldflags "-s -w" strips the symbol table and DWARF debug info, shrinking the
# final binary by ~30 % with zero runtime cost.
ARG TARGETARCH
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} \
    go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /lumina-core \
      ./cmd/server/

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 — Runtime
#
# distroless/static contains nothing but TLS root certificates and timezone
# data — no shell, no package manager, no libc.  The attack surface is as
# small as it can get while still supporting a Go binary that makes HTTPS
# calls (Pi Network API, Stellar Horizon, EVM RPC nodes).
# ──────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

# Copy the statically-linked binary from the builder stage.
COPY --from=builder /lumina-core /lumina-core

# Run as the pre-created nonroot UID (65532) — never as root in production.
USER nonroot:nonroot

# Expose the API port.  The actual PORT env var is resolved at runtime so the
# same image can be shifted between Railway, Digital Ocean App Platform, and
# Kubernetes without a rebuild.
EXPOSE 8080

# ENTRYPOINT avoids the shell layer; exec form means SIGTERM is delivered
# directly to lumina-core, enabling the graceful 15-second shutdown window
# wired in main.go.
ENTRYPOINT ["/lumina-core"]
