// Transaction handlers expose the 2-of-2 multi-sig transaction lifecycle via
// HTTP.  All endpoints require a valid Lumina JWT (enforced at the router level
// by middleware.RequireJWT).
package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/mux"

	"github.com/devwrightlabs/plu-lumina/backend/internal/middleware"
	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
	"github.com/devwrightlabs/plu-lumina/backend/internal/services"
)

// txService is the package-level TransactionService instance.  It is
// initialised exactly once by InitTransactionService, which must be called
// during server startup before any requests are served.
var txService *services.TransactionService

// txServiceOnce ensures that the write to txService is visible to all
// goroutines that subsequently read it (Go memory model guarantee).
var txServiceOnce sync.Once

// aiSigner is the package-level AISigner instance injected via InitAISigner.
var aiSigner *services.AISigner

// aiSignerOnce ensures that the write to aiSigner is visible to all
// goroutines that subsequently read it.
var aiSignerOnce sync.Once

// InitTransactionService constructs the package-level TransactionService.
// Subsequent calls are no-ops, matching the InitPiClient pattern.
func InitTransactionService() {
	txServiceOnce.Do(func() {
		txService = services.NewTransactionService()
	})
}

// InitAISigner stores the shared AISigner for use by TxAgentSign.
// Must be called once during server startup; subsequent calls are no-ops.
func InitAISigner(s *services.AISigner) {
	aiSignerOnce.Do(func() {
		aiSigner = s
	})
}

// ─── POST /tx/initiate ───────────────────────────────────────────────────────

// TxInitiate creates a new multi-sig transaction in the pending_owner_sig
// state.
//
// Flow:
//  1. Extract the authenticated Pi UID from the request context (set by
//     middleware.RequireJWT).
//  2. Decode and validate the JSON request body.
//  3. Delegate to TransactionService.InitiateTransaction.
//  4. Return the new transaction record (status = pending_owner_sig).
func TxInitiate(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value(middleware.ContextKeyUID).(string)

	var req models.TxInitiateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.VaultID == "" || req.TxEnvelopeXDR == "" ||
		req.Recipient == "" || req.Amount == "" {
		writeError(w, http.StatusBadRequest,
			"vault_id, tx_envelope_xdr, recipient, and amount are required")
		return
	}

	tx, err := txService.InitiateTransaction(uid, req.VaultID, req.TxEnvelopeXDR, req.Recipient, req.Amount)
	if err != nil {
		log.Printf("[tx] initiate error uid=%s vault=%s: %v", uid, req.VaultID, err)
		writeError(w, http.StatusInternalServerError, "could not initiate transaction")
		return
	}

	writeJSON(w, http.StatusCreated, tx.ToResponse())
}

// ─── GET /tx/{txID} ──────────────────────────────────────────────────────────

// TxGetStatus returns the current state of a multi-sig transaction.
//
// Flow:
//  1. Extract txID from the URL path variables.
//  2. Delegate to TransactionService.GetTransaction.
//  3. Return the transaction record.
func TxGetStatus(w http.ResponseWriter, r *http.Request) {
	txID := mux.Vars(r)["txID"]
	if txID == "" {
		writeError(w, http.StatusBadRequest, "txID path parameter is required")
		return
	}

	tx, err := txService.GetTransaction(txID)
	if err != nil {
		writeError(w, http.StatusNotFound, "transaction not found")
		return
	}

	writeJSON(w, http.StatusOK, tx.ToResponse())
}

// ─── POST /tx/{txID}/sign ────────────────────────────────────────────────────

// TxOwnerSign records the vault owner's Ed25519 signature and advances the
// transaction from pending_owner_sig → pending_agent_sig.
//
// Flow:
//  1. Extract txID from the URL path variables.
//  2. Decode the JSON body containing the owner's hex-encoded signature.
//  3. Delegate to TransactionService.SubmitOwnerSignature.
//  4. Return the updated transaction record.
func TxOwnerSign(w http.ResponseWriter, r *http.Request) {
	txID := mux.Vars(r)["txID"]
	if txID == "" {
		writeError(w, http.StatusBadRequest, "txID path parameter is required")
		return
	}

	var req models.TxSignRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Signature == "" {
		writeError(w, http.StatusBadRequest, "signature is required")
		return
	}

	tx, err := txService.SubmitOwnerSignature(txID, req.Signature)
	if err != nil {
		log.Printf("[tx] owner sign error txID=%s: %v", txID, err)
		writeError(w, http.StatusUnprocessableEntity, "could not record owner signature: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, tx.ToResponse())
}

// ─── POST /tx/{txID}/agent-sign ──────────────────────────────────────────────

// TxAgentSign records the Lumina Agent's Ed25519 counter-signature and
// advances the transaction from pending_agent_sig → ready_to_execute.
//
// Flow:
//  1. Extract txID from the URL path variables.
//  2. If the AI Co-Signer is wired (Phase 6), delegate the validation and
//     signature generation entirely to AISigner.SignTransaction; the risk
//     engine fetches the transaction from the repository, validates policy
//     rules, and persists the counter-signature.
//  3. Otherwise fall back to accepting an explicit signature in the request
//     body via TransactionService (in-memory path for testing).
//  4. Return the updated transaction record (status = ready_to_execute).
//
// In production this endpoint is called by the Lumina AI Agent after it
// independently validates the transaction parameters against policy rules.
func TxAgentSign(w http.ResponseWriter, r *http.Request) {
	txID := mux.Vars(r)["txID"]
	if txID == "" {
		writeError(w, http.StatusBadRequest, "txID path parameter is required")
		return
	}

	// ── Phase 6: AI Co-Signer path ────────────────────────────────────────────
	if aiSigner != nil {
		if err := aiSigner.SignTransaction(r.Context(), txID); err != nil {
			log.Printf("[tx] ai-sign error txID=%s: %v", txID, err)
			writeError(w, http.StatusUnprocessableEntity, "AI co-signer rejected transaction: "+err.Error())
			return
		}
		// Return a minimal acknowledgement; the full record is readable via
		// GET /tx/{txID} once the caller wants the updated state.
		writeJSON(w, http.StatusOK, map[string]string{
			"status": string(models.TxStatusReadyToExecute),
			"tx_id":  txID,
		})
		return
	}

	// ── Fallback: explicit signature in request body (in-memory path) ─────────
	var req models.TxSignRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Signature == "" {
		writeError(w, http.StatusBadRequest, "signature is required")
		return
	}

	tx, err := txService.SubmitAgentSignature(txID, req.Signature)
	if err != nil {
		log.Printf("[tx] agent sign error txID=%s: %v", txID, err)
		writeError(w, http.StatusUnprocessableEntity, "could not record agent signature: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, tx.ToResponse())
}

// ─── POST /tx/{txID}/execute ─────────────────────────────────────────────────

// TxExecute finalises the 2-of-2 multi-sig transaction by verifying both
// signatures are present and advancing the state from ready_to_execute →
// executed.
//
// Flow:
//  1. Extract txID from the URL path variables.
//  2. Delegate to TransactionService.ExecuteTransaction.
//  3. Return the updated transaction record (status = executed).
//
// NOTE (Phase 6): this endpoint will trigger the Stellar Soroban RPC
// submission once the on-chain integration is implemented.
func TxExecute(w http.ResponseWriter, r *http.Request) {
	txID := mux.Vars(r)["txID"]
	if txID == "" {
		writeError(w, http.StatusBadRequest, "txID path parameter is required")
		return
	}

	tx, err := txService.ExecuteTransaction(txID)
	if err != nil {
		log.Printf("[tx] execute error txID=%s: %v", txID, err)
		writeError(w, http.StatusUnprocessableEntity, "could not execute transaction: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, tx.ToResponse())
}
