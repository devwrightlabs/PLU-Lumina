# Lumina-Core REST API Reference

Base URL: `https://<your-domain>/`

All requests and responses use `Content-Type: application/json`.  
Protected routes require: `Authorization: Bearer <lumina_jwt>`

---

## POST `/auth/pi-handshake`

Verifies a Pi Network access token and issues a short-lived Lumina JWT.

### Request body

```json
{
  "access_token": "<pi_sdk_access_token>",
  "uid": "<pi_network_uid>"
}
```

| Field          | Type   | Required | Description |
|----------------|--------|----------|-------------|
| `access_token` | string | ✅       | Token from the Pi SDK `Pi.authenticate()` call |
| `uid`          | string | ✅       | Pi Network UID claimed by the client |

### Success response `200`

```json
{
  "token": "<lumina_jwt>",
  "expires_at": 1714000000,
  "uid": "<verified_pi_uid>"
}
```

### Error responses

| Status | Reason |
|--------|--------|
| `400`  | Missing or malformed fields |
| `401`  | Invalid Pi access token or UID mismatch |
| `500`  | Server misconfiguration |

---

## POST `/vault/create`  🔒

Provisions a new Sub-Wallet multi-sig vault.

### Request body

```json
{
  "owner_public_key": "<32-byte Ed25519 public key, hex-encoded>"
}
```

### Success response `201`

```json
{
  "vault_id": "<sha256²_hex>",
  "agent_public_key": "<lumina_agent_ed25519_pubkey_hex>",
  "required_signers": 2,
  "created_at": 1714000000
}
```

### Error responses

| Status | Reason |
|--------|--------|
| `400`  | Missing or invalid `owner_public_key` |
| `401`  | Missing or expired JWT |
| `500`  | Agent key not configured |

---

## POST `/sig/validate`  🔒

Validates 2-of-2 signatures and submits the XDR to the Soroban contract.

### Request body

```json
{
  "vault_id": "<vault_id>",
  "tx_envelope_xdr": "<base64-encoded Stellar XDR>",
  "owner_signature": "<ed25519 signature hex>",
  "agent_signature": "<ed25519 signature hex>"
}
```

### Success response `200`

```json
{
  "valid": true,
  "vault_id": "<vault_id>",
  "tx_hash": "<stellar_transaction_hash>",
  "validated_at": 1714000000
}
```

### Error responses

| Status | Reason |
|--------|--------|
| `400`  | Missing required fields |
| `401`  | Missing or expired JWT |
| `422`  | One or both signatures are invalid |

---

## Security Notes

- JWTs are valid for **15 minutes** only.
- All endpoints enforce TLS 1.3 in production.
- Rate limiting: 10 requests/minute per IP on `/auth/pi-handshake`.
