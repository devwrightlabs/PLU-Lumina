// Package services contains the core business logic for Lumina-Core backend
// operations.
package services

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"

	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
	"github.com/devwrightlabs/plu-lumina/backend/internal/repository"
)

// ─── Policy constants ─────────────────────────────────────────────────────────

// maxApprovedAmountXLM is the upper bound (in stroops, 1 XLM = 10,000,000
// stroops) the AI validator will auto-approve without escalation.
// Transactions above this limit are rejected by the mock risk engine.
const maxApprovedAmountXLM = 10_000 * 10_000_000 // 10,000 XLM in stroops

// ─── AISigner ────────────────────────────────────────────────────────────────

// AISigner is the Lumina AI Co-Signer engine.  It fetches transactions that
// are waiting for the agent's counter-signature, runs an internal risk
// assessment, and — when the assessment passes — produces and records an
// Ed25519 counter-signature using the agent's private key.
//
// The private key is read from the LUMINA_AGENT_PRIVATE_KEY environment
// variable (64-byte hex-encoded seed+public concatenation, standard Go
// ed25519.PrivateKey encoding).  The key is resolved once at construction
// time so that rotations are picked up on restart.
type AISigner struct {
	repo       repository.TransactionRepository
	privateKey ed25519.PrivateKey
}

// NewAISigner constructs an AISigner backed by the supplied repository.
// It reads and validates LUMINA_AGENT_PRIVATE_KEY from the environment.
// Returns an error if the key is absent or malformed.
func NewAISigner(repo repository.TransactionRepository) (*AISigner, error) {
	if repo == nil {
		return nil, fmt.Errorf("repository must not be nil")
	}

	privKeyHex := os.Getenv("LUMINA_AGENT_PRIVATE_KEY")
	if privKeyHex == "" {
		return nil, fmt.Errorf("LUMINA_AGENT_PRIVATE_KEY environment variable is required")
	}

	privKeyBytes, err := hex.DecodeString(privKeyHex)
	if err != nil {
		return nil, fmt.Errorf("decoding LUMINA_AGENT_PRIVATE_KEY: %w", err)
	}
	// ed25519.PrivateKey is the 64-byte seed+public key concatenation.
	if len(privKeyBytes) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf(
			"LUMINA_AGENT_PRIVATE_KEY must be %d bytes (hex), got %d",
			ed25519.PrivateKeySize, len(privKeyBytes),
		)
	}

	return &AISigner{
		repo:       repo,
		privateKey: ed25519.PrivateKey(privKeyBytes),
	}, nil
}

// ProcessPendingTransactions fetches every transaction in the
// pending_agent_sig state and runs the full validate-and-sign pipeline for
// each one.  Errors on individual transactions are logged and do not abort
// processing of subsequent records.
//
// This method is designed to be called periodically (e.g. by a goroutine
// ticker) or on-demand by the /tx/{id}/agent-sign HTTP handler.
func (a *AISigner) ProcessPendingTransactions(ctx context.Context) error {
	pending, err := a.repo.ListByStatus(ctx, models.TxStatusPendingAgentSig)
	if err != nil {
		return fmt.Errorf("listing pending_agent_sig transactions: %w", err)
	}

	if len(pending) == 0 {
		log.Println("[ai-signer] no transactions awaiting agent signature")
		return nil
	}

	log.Printf("[ai-signer] processing %d pending transaction(s)", len(pending))
	for _, tx := range pending {
		if err := a.SignTransaction(ctx, tx.ID); err != nil {
			log.Printf("[ai-signer] failed to sign tx=%s: %v", tx.ID, err)
		}
	}
	return nil
}

// SignTransaction runs the AI risk assessment for a single transaction and,
// if validation passes, generates and persists the Ed25519 agent counter-
// signature.
//
// State guard: the transaction must be in pending_agent_sig; attempting to
// sign a transaction in any other state is an error.
func (a *AISigner) SignTransaction(ctx context.Context, txID string) error {
	if txID == "" {
		return fmt.Errorf("txID is required")
	}

	tx, err := a.repo.GetByID(ctx, txID)
	if err != nil {
		return fmt.Errorf("fetching transaction %s: %w", txID, err)
	}

	if tx.Status != models.TxStatusPendingAgentSig {
		return fmt.Errorf(
			"invalid state: expected %s, got %s",
			models.TxStatusPendingAgentSig, tx.Status,
		)
	}

	// ── Risk assessment ──────────────────────────────────────────────────────
	if err := a.validate(tx); err != nil {
		// Mark as failed so the owner can see the rejection reason.
		tx.Status = models.TxStatusFailed
		tx.FailureReason = "AI validation rejected: " + err.Error()
		if updateErr := a.repo.Update(ctx, tx); updateErr != nil {
			log.Printf("[ai-signer] failed to persist rejection for tx=%s: %v", txID, updateErr)
		}
		log.Printf("[ai-signer] rejected tx=%s reason=%q", txID, tx.FailureReason)
		return fmt.Errorf("validation failed for tx=%s: %w", txID, err)
	}

	// ── Generate counter-signature ───────────────────────────────────────────
	sig, err := a.sign(tx)
	if err != nil {
		return fmt.Errorf("generating agent signature for tx=%s: %w", txID, err)
	}

	tx.AgentSignature = sig
	tx.Status = models.TxStatusReadyToExecute

	if err := a.repo.Update(ctx, tx); err != nil {
		return fmt.Errorf("persisting agent signature for tx=%s: %w", txID, err)
	}

	log.Printf("[ai-signer] signed tx=%s → %s", txID, tx.Status)
	return nil
}

// ─── Validation (mock risk engine) ───────────────────────────────────────────

// validate performs the AI agent's risk-assessment checks against the
// transaction.  In Phase 6 these are representative policy rules; a
// production deployment would call an ML inference endpoint or a rules engine.
//
// Rules evaluated:
//  1. Owner signature must be present (defence-in-depth: the state machine
//     should guarantee this, but we re-verify).
//  2. The XDR envelope must be non-empty.
//  3. The transaction amount must be above zero and within the auto-approval
//     ceiling defined by maxApprovedAmountXLM.
//  4. The recipient address must be a valid 56-character Stellar account ID
//     (starts with 'G').
func (a *AISigner) validate(tx *models.MultiSigTransaction) error {
	if tx.OwnerSignature == "" {
		return fmt.Errorf("owner signature is absent")
	}

	if tx.TxEnvelopeXDR == "" {
		return fmt.Errorf("tx_envelope_xdr is empty")
	}

	// Parse the amount string as stroops (integer).
	amountStroops, err := parseStroops(tx.Amount)
	if err != nil {
		return fmt.Errorf("unparseable amount %q: %w", tx.Amount, err)
	}
	if amountStroops <= 0 {
		return fmt.Errorf("amount must be positive, got %d stroops", amountStroops)
	}
	if amountStroops > maxApprovedAmountXLM {
		return fmt.Errorf(
			"amount %d stroops exceeds auto-approval ceiling %d stroops",
			amountStroops, maxApprovedAmountXLM,
		)
	}

	// A valid Stellar account address is 56 characters and starts with 'G'.
	if len(tx.Recipient) != 56 || tx.Recipient[0] != 'G' {
		return fmt.Errorf("recipient %q does not look like a valid Stellar address", tx.Recipient)
	}

	return nil
}

// ─── Signature generation ─────────────────────────────────────────────────────

// sign computes the canonical transaction hash and produces an Ed25519
// signature over it using the agent's private key.
//
// Canonical hash = SHA-256(SHA-256(txID || ":" || TxEnvelopeXDR))
//
// This matches the double-SHA-256 scheme used by the owner-side signing,
// ensuring both parties sign the same message digest.
func (a *AISigner) sign(tx *models.MultiSigTransaction) (string, error) {
	h1 := sha256.New()
	h1.Write([]byte(tx.ID))
	h1.Write([]byte(":"))
	h1.Write([]byte(tx.TxEnvelopeXDR))
	first := h1.Sum(nil)

	h2 := sha256.New()
	h2.Write(first)
	digest := h2.Sum(nil)

	sigBytes := ed25519.Sign(a.privateKey, digest)
	return hex.EncodeToString(sigBytes), nil
}

// ─── Amount parsing helper ────────────────────────────────────────────────────

// parseStroops converts a decimal string (up to 7 decimal places, as used
// throughout Lumina for Stellar amounts) into an integer stroop count.
//
// Example: "10.0000000" → 100_000_000
func parseStroops(s string) (int64, error) {
	if s == "" {
		return 0, fmt.Errorf("amount string is empty")
	}

	// Split on the decimal point.
	intPart, fracPart := "", ""
	for i, ch := range s {
		if ch == '.' {
			intPart = s[:i]
			fracPart = s[i+1:]
			break
		}
	}
	if intPart == "" {
		// No decimal point — treat entire string as the integer part.
		intPart = s
	}

	// Pad or truncate fractional part to exactly 7 digits.
	for len(fracPart) < 7 {
		fracPart += "0"
	}
	fracPart = fracPart[:7]

	intVal, err := parseDigits(intPart)
	if err != nil {
		return 0, fmt.Errorf("invalid integer part %q: %w", intPart, err)
	}
	fracVal, err := parseDigits(fracPart)
	if err != nil {
		return 0, fmt.Errorf("invalid fractional part %q: %w", fracPart, err)
	}

	return intVal*10_000_000 + fracVal, nil
}

// parseDigits converts a string of ASCII decimal digits to int64.
func parseDigits(s string) (int64, error) {
	if s == "" {
		return 0, nil
	}
	var result int64
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("non-digit character %q", ch)
		}
		result = result*10 + int64(ch-'0')
	}
	return result, nil
}
