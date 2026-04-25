# Protocol 23 Compliance Notes

Lumina-Core targets full compatibility with **Stellar Protocol 23**, which
marks the general-availability (GA) milestone for the Soroban smart-contract
platform on Stellar Mainnet.

---

## What Changed in Protocol 23

| Area | Change | Lumina-Core Impact |
|------|--------|--------------------|
| **`SorobanTransactionData`** | Mandatory on all transactions invoking host functions | All XDR submitted via `/sig/validate` must include a populated `SorobanTransactionData` field |
| **Resource fee model** | Fees are now split: `inclusionFee` (base) + `resourceFee` (CPU instructions, read/write bytes, events) | Backend must simulate transactions via Soroban RPC `simulateTransaction` before submission to get accurate resource fees |
| **`InvokeHostFunctionOp` v0** | Deprecated; only v1 (`InvokeContractArgs`) is accepted | `contracts/src/lib.rs` uses `soroban-sdk = "21.0.0"` which generates Protocol 23-compliant XDR |
| **Persistent storage TTL** | Persistent ledger entries expire; contracts must extend TTL via `extend_ttl` | MultiSigVault should call `env.storage().persistent().extend_ttl(...)` on entries it reads |
| **Event schema** | Events must use `Symbol` topic values (not arbitrary `Val`) | All `env.events().publish(...)` calls in `lib.rs` use `Symbol::new` as the first topic element |

---

## Checklist

- [x] Use `soroban-sdk` v21.x (Protocol 23 GA SDK)
- [x] All contract events use `Symbol` topics
- [x] Contract is compiled with `--target wasm32-unknown-unknown --release`
- [x] `opt-level = "z"`, `lto = true`, `panic = "abort"` set in `Cargo.toml`
- [ ] Backend adds `SorobanTransactionData` to every XDR envelope before submission
- [ ] Backend calls `simulateTransaction` to populate resource limits and fees
- [ ] MultiSigVault extends persistent-entry TTL on every read
- [ ] Integration tests against Futurenet / Testnet Protocol 23 node

---

## Soroban RPC Simulation Flow

```
POST /sig/validate
      │
      ▼
1.  Deserialise TxEnvelopeXDR
2.  Verify owner signature  (Ed25519)
3.  Verify agent signature  (Ed25519)
      │ both valid
      ▼
4.  Call soroban_rpc.simulateTransaction(xdr)
      │ receives resource_fee + SorobanTransactionData
      ▼
5.  Inject SorobanTransactionData into envelope
6.  Re-sign with fee-bump if necessary
7.  Call soroban_rpc.sendTransaction(xdr)
      │
      ▼
8.  Poll soroban_rpc.getTransaction(hash) until SUCCESS/FAILED
9.  Persist sig_event to Supabase
```

---

## References

- [Stellar Protocol 23 Upgrade Guide](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/protocol-upgrades)
- [Soroban SDK v21 Changelog](https://github.com/stellar/rs-soroban-sdk/blob/main/CHANGELOG.md)
- [Soroban RPC `simulateTransaction`](https://developers.stellar.org/docs/data/rpc/api-reference/methods/simulateTransaction)
