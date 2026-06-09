# pkg/

This directory holds library code that is safe to import by external Go modules
or by other packages within this repository.

## Planned contents

| Package | Purpose |
|---------|---------|
| `stellar/` | Thin wrapper around the Stellar Horizon RPC (XDR encoding, fee estimation) |
| `crypto/` | Ed25519 key-derivation and signing utilities shared across handlers |

Code under `pkg/` must have **no** dependency on `internal/` packages and must
be independently testable.
