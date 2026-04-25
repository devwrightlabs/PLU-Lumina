# PLU-Lumina (Lumina-Core)

A high-speed Go-based backend and Rust/Soroban smart contract system for a secure **Sub-Wallet Liquidity Handshake Utility** built on the Pi Network ecosystem.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Pi Browser (Frontend)                  │
│  - Pi SDK Authentication  - Sub-Wallet UI  - Vault Dashboard│
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS / JWT (Zero-Trust)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Lumina-Core Backend (Go)                  │
│                                                             │
│  POST /auth/pi-handshake  ──► Pi Network Auth Verification  │
│  POST /vault/create       ──► Sub-Wallet Vault Provisioning │
│  POST /sig/validate       ──► 2-of-2 Multi-Sig Validation   │
│                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐ │
│  │  Auth Layer │   │  Vault Layer │   │  Signature Layer │ │
│  │ (JWT/HMAC)  │   │ (Supabase DB)│   │ (Ed25519/Soroban)│ │
│  └─────────────┘   └──────────────┘   └──────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ XDR / Horizon API
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Soroban Smart Contracts (Rust)                 │
│                                                             │
│  MultiSigVault Contract                                     │
│  - Requires 2-of-2 signatures: Owner + Lumina Agent        │
│  - Escrow release gated by both parties                     │
│  - On-chain audit trail for all vault operations            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Supabase (PostgreSQL)                      │
│  - handshake_history  - vault_balances  - sig_events        │
└─────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
PLU-Lumina/
├── backend/              # Go REST API server
│   ├── main.go           # Entry point & route registration
│   ├── handlers/         # Route handler implementations
│   ├── middleware/        # JWT auth, rate limiting, logging
│   └── go.mod            # Go module definition
├── contracts/            # Rust/Soroban smart contracts
│   ├── src/
│   │   └── lib.rs        # MultiSigVault contract
│   └── Cargo.toml        # Rust package manifest
├── docs/                 # Architecture & API documentation
│   ├── api.md            # REST API reference
│   └── protocol23.md     # Protocol 23 compliance notes
├── schema.sql            # Supabase PostgreSQL schema
└── README.md             # This file
```

---

## Phases 1–3 Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Core infrastructure: Go API skeleton, Soroban contract scaffold, DB schema | ✅ In Progress |
| **Phase 2** | Pi Network authentication flow, JWT issuance, Sub-Wallet binding | 🔜 Planned |
| **Phase 3** | Multi-Sig vault creation, escrow release, on-chain event indexing | 🔜 Planned |

---

## Security & Zero-Trust Architecture

- **Authentication**: Every request requires a valid Pi Network UID + server-side JWT.  No implicit trust between services.
- **Transport**: TLS 1.3 enforced end-to-end; no plain-HTTP endpoints in production.
- **Signatures**: All vault operations require 2-of-2 Ed25519 signatures (Owner key + Lumina Agent key) before the Soroban contract releases funds.
- **Secrets Management**: Credentials are never stored in source control; loaded exclusively from environment variables or a secrets manager (e.g., HashiCorp Vault / Supabase Vault).
- **Audit Logging**: Every handshake, vault event, and signature validation is persisted to `handshake_history` and `sig_events` tables with immutable timestamps.

---

## Protocol 23 Compliance

Lumina-Core targets full compliance with **Stellar Protocol 23** (Soroban GA), which introduces:
- `SorobanTransactionData` mandatory on all contract invocations.
- Updated resource fee model (instructions, read/write bytes, events).
- Deprecation of legacy `InvokeHostFunctionOp` v0 XDR.

See [`docs/protocol23.md`](docs/protocol23.md) for the complete compliance checklist.

---

## Quick Start

### Backend

```bash
cd backend
go mod tidy
go run main.go
```

### Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### Database

Apply the schema to your Supabase project:

```bash
psql "$SUPABASE_DB_URL" -f schema.sql
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP listen port (default: `8080`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service-role API key |
| `JWT_SECRET` | Secret for signing JWTs (min 32 bytes) |
| `LUMINA_AGENT_PUBLIC_KEY` | Ed25519 public key of the Lumina Agent |
| `PI_API_KEY` | Pi Network server-side API key |

---

## License

See [LICENSE](LICENSE).