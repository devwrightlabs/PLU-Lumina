// Package services contains the core business logic for Lumina-Core backend
// operations.
package services

import (
	"crypto/sha256"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
)

// TransactionService manages the lifecycle of 2-of-2 multi-sig transactions
// through a strict state machine.
//
// Concurrency strategy:
//
//	mu is a RWMutex that guards txns, the in-memory transaction store.
//	Read-only operations (GetTransaction) acquire a shared read lock so
//	multiple concurrent status queries proceed without blocking each other.
//	All state-mutating operations (Initiate, SubmitOwnerSignature,
//	SubmitAgentSignature, ExecuteTransaction) acquire an exclusive write lock
//	for the minimum duration required to read the current state, validate the
//	expected transition, apply the mutation, and write the record back.  This
//	eliminates TOCTOU (time-of-check/time-of-use) races: no other goroutine
//	can observe or modify the record between the state check and the write.
type TransactionService struct {
	mu   sync.RWMutex
	txns map[string]*models.MultiSigTransaction
}

// NewTransactionService constructs a TransactionService backed by an
// in-memory store.  In a production deployment this implementation is
// replaced by a database-backed version behind the same method signatures.
func NewTransactionService() *TransactionService {
	return &TransactionService{
		txns: make(map[string]*models.MultiSigTransaction),
	}
}

// deriveTxID produces a deterministic, collision-resistant transaction
// identifier from the initiating owner UID, vault ID, and a nanosecond
// timestamp.  A double-SHA-256 digest is used for consistency with the
// existing deriveVaultID scheme.
func deriveTxID(ownerUID, vaultID string, ts time.Time) string {
	h := sha256.New()
	h.Write([]byte("lumina-tx-v1:"))
	h.Write([]byte(ownerUID))
	h.Write([]byte(":"))
	h.Write([]byte(vaultID))
	h.Write([]byte(":"))
	h.Write([]byte(fmt.Sprintf("%d", ts.UnixNano())))
	first := h.Sum(nil)

	h2 := sha256.New()
	h2.Write(first)
	return fmt.Sprintf("%x", h2.Sum(nil))
}

// copyTx returns a shallow copy of tx so callers cannot mutate the stored
// record through the returned pointer.
func copyTx(tx *models.MultiSigTransaction) *models.MultiSigTransaction {
	cp := *tx
	return &cp
}

// InitiateTransaction creates a new multi-sig transaction in the
// pending_owner_sig state.
//
// All five fields are required.  The returned record is a copy; the original
// is stored inside the service.
func (s *TransactionService) InitiateTransaction(
	ownerUID, vaultID, txEnvelopeXDR, recipient, amount string,
) (*models.MultiSigTransaction, error) {
	if ownerUID == "" || vaultID == "" || txEnvelopeXDR == "" ||
		recipient == "" || amount == "" {
		return nil, fmt.Errorf("ownerUID, vaultID, txEnvelopeXDR, recipient, and amount are required")
	}

	now := time.Now().UTC()
	txID := deriveTxID(ownerUID, vaultID, now)

	tx := &models.MultiSigTransaction{
		ID:            txID,
		VaultID:       vaultID,
		OwnerUID:      ownerUID,
		TxEnvelopeXDR: txEnvelopeXDR,
		Recipient:     recipient,
		Amount:        amount,
		Status:        models.TxStatusPendingOwnerSig,
		InitiatedAt:   now,
		UpdatedAt:     now,
	}

	// Hold the write lock only for the map insertion.
	s.mu.Lock()
	s.txns[txID] = tx
	s.mu.Unlock()

	log.Printf("[tx] initiated id=%s vault=%s owner=%s", txID, vaultID, ownerUID)
	return copyTx(tx), nil
}

// GetTransaction retrieves the current state of a transaction by its ID.
// Returns an error if the ID is unknown.
func (s *TransactionService) GetTransaction(txID string) (*models.MultiSigTransaction, error) {
	s.mu.RLock()
	tx, ok := s.txns[txID]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("transaction %s not found", txID)
	}
	return copyTx(tx), nil
}

// SubmitOwnerSignature records the vault owner's Ed25519 signature and
// advances the transaction from pending_owner_sig → pending_agent_sig.
//
// Transition guard: returns an error if the transaction is in any state other
// than pending_owner_sig, preventing double-signing and out-of-order
// submissions.
func (s *TransactionService) SubmitOwnerSignature(txID, ownerSignature string) (*models.MultiSigTransaction, error) {
	if txID == "" || ownerSignature == "" {
		return nil, fmt.Errorf("txID and ownerSignature are required")
	}

	// Acquire write lock for the duration of the read-validate-write cycle to
	// prevent concurrent callers from both observing pending_owner_sig and both
	// advancing the state (TOCTOU race).
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, ok := s.txns[txID]
	if !ok {
		return nil, fmt.Errorf("transaction %s not found", txID)
	}

	if tx.Status != models.TxStatusPendingOwnerSig {
		return nil, fmt.Errorf("invalid state transition: cannot record owner signature in state %q", tx.Status)
	}

	tx.OwnerSignature = ownerSignature
	tx.Status = models.TxStatusPendingAgentSig
	tx.UpdatedAt = time.Now().UTC()

	log.Printf("[tx] owner signed id=%s → %s", txID, tx.Status)
	return copyTx(tx), nil
}

// SubmitAgentSignature records the Lumina Agent's Ed25519 counter-signature
// and advances the transaction from pending_agent_sig → ready_to_execute.
//
// Transition guard: returns an error if the transaction is in any state other
// than pending_agent_sig, ensuring the agent cannot sign a proposal the owner
// has not yet committed to.
func (s *TransactionService) SubmitAgentSignature(txID, agentSignature string) (*models.MultiSigTransaction, error) {
	if txID == "" || agentSignature == "" {
		return nil, fmt.Errorf("txID and agentSignature are required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, ok := s.txns[txID]
	if !ok {
		return nil, fmt.Errorf("transaction %s not found", txID)
	}

	if tx.Status != models.TxStatusPendingAgentSig {
		return nil, fmt.Errorf("invalid state transition: cannot record agent signature in state %q", tx.Status)
	}

	tx.AgentSignature = agentSignature
	tx.Status = models.TxStatusReadyToExecute
	tx.UpdatedAt = time.Now().UTC()

	log.Printf("[tx] agent signed id=%s → %s", txID, tx.Status)
	return copyTx(tx), nil
}

// ExecuteTransaction finalises the 2-of-2 multi-sig transaction by verifying
// that both required signatures are present and advancing the state from
// ready_to_execute → executed.
//
// In Phase 5 the Stellar Soroban RPC submission is prepared but deferred to
// Phase 6; the transaction hash will be populated once on-chain submission is
// wired.  The state machine transition is complete and auditable in this phase.
func (s *TransactionService) ExecuteTransaction(txID string) (*models.MultiSigTransaction, error) {
	if txID == "" {
		return nil, fmt.Errorf("txID is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, ok := s.txns[txID]
	if !ok {
		return nil, fmt.Errorf("transaction %s not found", txID)
	}

	if tx.Status != models.TxStatusReadyToExecute {
		return nil, fmt.Errorf("invalid state transition: cannot execute from state %q", tx.Status)
	}

	// Defensive check: both signatures must be present before on-chain
	// submission is attempted.  In theory this cannot be false if the state
	// machine transitions were respected, but defense-in-depth warrants the
	// explicit check.
	if tx.OwnerSignature == "" || tx.AgentSignature == "" {
		tx.Status = models.TxStatusFailed
		tx.FailureReason = "missing one or more required signatures"
		tx.UpdatedAt = time.Now().UTC()
		log.Printf("[tx] execution aborted (missing signatures) id=%s", txID)
		return copyTx(tx), fmt.Errorf("missing one or more required signatures")
	}

	// TODO (Phase 6): Inject SorobanTransactionData via simulateTransaction RPC,
	// attach both signatures to the XDR envelope, submit to Stellar Horizon RPC,
	// and record the returned transaction hash in tx.TxHash.

	tx.Status = models.TxStatusExecuted
	tx.UpdatedAt = time.Now().UTC()

	log.Printf("[tx] executed id=%s vault=%s", txID, tx.VaultID)
	return copyTx(tx), nil
}
