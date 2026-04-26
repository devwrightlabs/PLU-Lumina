// Package handlers contains the HTTP handler implementations for each
// Lumina-Core API route.
package handlers

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/devwrightlabs/plu-lumina/backend/internal/middleware"
)

// ─── Shared helpers ───────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("writeJSON encode error: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// ─── /auth/pi-handshake ───────────────────────────────────────────────────────

// piHandshakeRequest is the inbound JSON body for a Pi Network handshake.
type piHandshakeRequest struct {
	// AccessToken is the token obtained from the Pi SDK on the frontend.
	AccessToken string `json:"access_token"`
	// UID is the Pi Network user identifier claimed by the client.
	UID string `json:"uid"`
}

// piHandshakeResponse is returned on successful authentication.
type piHandshakeResponse struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
	UID       string `json:"uid"`
}

// PiHandshake verifies a Pi Network access token and issues a Lumina JWT.
//
// Flow:
//  1. Decode & validate the inbound JSON.
//  2. Verify the access_token against the Pi Platform /me endpoint using the
//     server-side PI_API_KEY (prevents replay attacks).
//  3. Confirm that the UID in the token matches the claimed UID.
//  4. Issue a short-lived (15 min) Lumina JWT signed with JWT_SECRET.
func PiHandshake(w http.ResponseWriter, r *http.Request) {
	var req piHandshakeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.AccessToken == "" || req.UID == "" {
		writeError(w, http.StatusBadRequest, "access_token and uid are required")
		return
	}

	// Verify the Pi access token with the Pi Platform API.
	verifiedUID, err := verifyPiAccessToken(req.AccessToken)
	if err != nil {
		log.Printf("pi token verification failed: %v", err)
		writeError(w, http.StatusUnauthorized, "invalid Pi access token")
		return
	}

	if verifiedUID != req.UID {
		writeError(w, http.StatusUnauthorized, "uid mismatch")
		return
	}

	// Issue a Lumina JWT.
	expiresAt := time.Now().Add(15 * time.Minute)
	token, err := issueLuminaJWT(verifiedUID, expiresAt)
	if err != nil {
		log.Printf("jwt issuance failed: %v", err)
		writeError(w, http.StatusInternalServerError, "could not issue token")
		return
	}

	writeJSON(w, http.StatusOK, piHandshakeResponse{
		Token:     token,
		ExpiresAt: expiresAt.Unix(),
		UID:       verifiedUID,
	})
}

// verifyPiAccessToken calls the Pi Platform /v2/me endpoint to validate the
// access token and return the authenticated UID.
func verifyPiAccessToken(accessToken string) (string, error) {
	piAPIKey := os.Getenv("PI_API_KEY")
	if piAPIKey == "" {
		return "", errorf("PI_API_KEY environment variable not set")
	}

	req, err := http.NewRequest(http.MethodGet, "https://api.minepi.com/v2/me", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("X-Pi-Api-Key", piAPIKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errorf("pi platform returned status %d", resp.StatusCode)
	}

	var body struct {
		UID string `json:"uid"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.UID == "" {
		return "", errorf("empty uid in pi platform response")
	}
	return body.UID, nil
}

// issueLuminaJWT creates a signed JWT for the given UID valid until expiresAt.
func issueLuminaJWT(uid string, expiresAt time.Time) (string, error) {
	secret := os.Getenv("JWT_SECRET")
	if len(secret) < middleware.MinJWTSecretLen {
		return "", errorf("JWT_SECRET must be at least %d bytes", middleware.MinJWTSecretLen)
	}

	claims := jwt.MapClaims{
		"sub": uid,
		"iss": "lumina-core",
		"aud": "lumina-client",
		"exp": expiresAt.Unix(),
		"iat": time.Now().Unix(),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(secret))
}

// ─── /vault/create ───────────────────────────────────────────────────────────

// vaultCreateRequest is the inbound JSON body for vault creation.
type vaultCreateRequest struct {
	// OwnerPublicKey is the owner's Ed25519 public key (hex-encoded).
	OwnerPublicKey string `json:"owner_public_key"`
}

// vaultCreateResponse is returned on successful vault provisioning.
type vaultCreateResponse struct {
	VaultID         string `json:"vault_id"`
	AgentPublicKey  string `json:"agent_public_key"`
	RequiredSigners int    `json:"required_signers"`
	CreatedAt       int64  `json:"created_at"`
}

// VaultCreate provisions a new Sub-Wallet multi-sig vault.
//
// Flow:
//  1. Validate the owner's Ed25519 public key.
//  2. Generate a unique vault ID using deriveVaultID (deterministic: versioned
//     prefix + UID + owner_public_key, hashed with double-SHA-256).
//  3. Record the vault in the database (handshake_history + vault_balances).
//  4. Return the vault ID and the Lumina Agent's public key so the frontend
//     can construct co-signed transactions.
func VaultCreate(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value(middleware.ContextKeyUID).(string)

	var req vaultCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.OwnerPublicKey == "" {
		writeError(w, http.StatusBadRequest, "owner_public_key is required")
		return
	}

	// Validate that the key is a valid 32-byte Ed25519 public key.
	ownerKeyBytes, err := hex.DecodeString(req.OwnerPublicKey)
	if err != nil || len(ownerKeyBytes) != ed25519.PublicKeySize {
		writeError(w, http.StatusBadRequest, "owner_public_key must be a 32-byte hex-encoded Ed25519 public key")
		return
	}

	agentPubKeyHex := os.Getenv("LUMINA_AGENT_PUBLIC_KEY")
	if agentPubKeyHex == "" {
		log.Println("LUMINA_AGENT_PUBLIC_KEY not configured")
		writeError(w, http.StatusInternalServerError, "agent key not configured")
		return
	}

	agentKeyBytes, err := hex.DecodeString(agentPubKeyHex)
	if err != nil || len(agentKeyBytes) != ed25519.PublicKeySize {
		log.Println("LUMINA_AGENT_PUBLIC_KEY is invalid")
		writeError(w, http.StatusInternalServerError, "agent key not configured")
		return
	}
	vaultID := deriveVaultID(uid, req.OwnerPublicKey)

	writeJSON(w, http.StatusCreated, vaultCreateResponse{
		VaultID:         vaultID,
		AgentPublicKey:  agentPubKeyHex,
		RequiredSigners: 2,
		CreatedAt:       time.Now().Unix(),
	})
}

// ─── /sig/validate ───────────────────────────────────────────────────────────

// sigValidateRequest is the inbound JSON body for signature validation.
type sigValidateRequest struct {
	// VaultID is the target vault.
	VaultID string `json:"vault_id"`
	// TxEnvelopeXDR is the base64-encoded Stellar XDR transaction envelope.
	TxEnvelopeXDR string `json:"tx_envelope_xdr"`
	// OwnerSignature is the owner's Ed25519 signature over TxEnvelopeXDR (hex).
	OwnerSignature string `json:"owner_signature"`
	// AgentSignature is the Lumina Agent's Ed25519 signature over TxEnvelopeXDR (hex).
	AgentSignature string `json:"agent_signature"`
}

// sigValidateResponse is returned after successful 2-of-2 validation.
type sigValidateResponse struct {
	Valid       bool   `json:"valid"`
	VaultID     string `json:"vault_id"`
	TxHash      string `json:"tx_hash"`
	ValidatedAt int64  `json:"validated_at"`
}

// SigValidate verifies both the Owner and Lumina Agent signatures against
// the serialised transaction envelope, then forwards the XDR to the Soroban
// multi-sig contract for on-chain execution.
//
// Flow:
//  1. Decode and validate all required fields.
//  2. Verify the owner's Ed25519 signature.
//  3. Verify the Lumina Agent's Ed25519 signature.
//  4. On dual-signature success, submit the XDR to the Soroban contract via
//     the Stellar Horizon RPC endpoint.
//  5. Record the sig_event in the database.
func SigValidate(w http.ResponseWriter, r *http.Request) {
	var req sigValidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.VaultID == "" || req.TxEnvelopeXDR == "" ||
		req.OwnerSignature == "" || req.AgentSignature == "" {
		writeError(w, http.StatusBadRequest, "vault_id, tx_envelope_xdr, owner_signature, and agent_signature are required")
		return
	}

	txHash, err := validateAndSubmit(req)
	if err != nil {
		log.Printf("sig validation failed for vault %s: %v", req.VaultID, err)
		writeError(w, http.StatusUnprocessableEntity, "signature validation failed: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, sigValidateResponse{
		Valid:       true,
		VaultID:     req.VaultID,
		TxHash:      txHash,
		ValidatedAt: time.Now().Unix(),
	})
}

// validateAndSubmit performs the dual-signature check and submits the
// transaction to the Stellar network.
//
// TODO (Phase 3): Implement the following steps:
//  1. Decode TxEnvelopeXDR from base64.
//  2. Verify ownerSignature against the canonical tx hash using the vault's
//     stored owner public key.
//  3. Verify agentSignature using LUMINA_AGENT_PUBLIC_KEY.
//  4. Inject SorobanTransactionData (via simulateTransaction RPC call).
//  5. Submit the fully-signed XDR to the Stellar Horizon RPC.
//  6. Return the resulting transaction hash.
func validateAndSubmit(_ sigValidateRequest) (string, error) {
	return "", errorf("validateAndSubmit not yet implemented (Phase 3)")
}
