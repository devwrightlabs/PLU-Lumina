// Package models defines the canonical data structures used across the
// Lumina-Core backend for multi-sig transaction management.
package models

import "time"

// TxStatus represents the lifecycle state of a 2-of-2 multi-sig transaction.
// Transitions are strictly ordered and enforced by TransactionService.
type TxStatus string

const (
	// TxStatusPendingOwnerSig is the initial state after creation; the vault
	// owner's Ed25519 signature has not yet been received.
	TxStatusPendingOwnerSig TxStatus = "pending_owner_sig"

	// TxStatusPendingAgentSig means the owner has signed; the Lumina Agent's
	// counter-signature is now required to advance.
	TxStatusPendingAgentSig TxStatus = "pending_agent_sig"

	// TxStatusReadyToExecute means both required signatures are present and the
	// assembled XDR envelope is ready for on-chain submission.
	TxStatusReadyToExecute TxStatus = "ready_to_execute"

	// TxStatusExecuted means the transaction was successfully submitted to the
	// Stellar network and a transaction hash has been recorded.
	TxStatusExecuted TxStatus = "executed"

	// TxStatusFailed means the transaction entered an unrecoverable error state.
	// FailureReason will contain the diagnostic message.
	TxStatusFailed TxStatus = "failed"

	// TxStatusCancelled means the vault owner explicitly cancelled the proposal
	// before it reached the ready_to_execute stage.
	TxStatusCancelled TxStatus = "cancelled"
)

// MultiSigTransaction is the canonical in-flight record for a 2-of-2 multi-sig
// transaction.  It flows through the states defined by TxStatus and is the
// primary type persisted to the sig_events audit table on each transition.
//
// JSON tags use snake_case for consistency with existing API responses.
// Fields that may be absent at certain lifecycle stages carry omitempty to
// avoid cluttering API responses with null values.
type MultiSigTransaction struct {
	// ID is the unique transaction identifier (hex-encoded double-SHA-256 of
	// ownerUID + vaultID + nanosecond timestamp).
	ID string `json:"id"`

	// VaultID identifies the owning Sub-Wallet vault.
	VaultID string `json:"vault_id"`

	// OwnerUID is the Pi Network UID of the transaction initiator.
	OwnerUID string `json:"owner_uid"`

	// TxEnvelopeXDR is the base64-encoded Stellar XDR transaction envelope
	// awaiting both required signatures.
	TxEnvelopeXDR string `json:"tx_envelope_xdr"`

	// Recipient is the destination Stellar address for the token release.
	Recipient string `json:"recipient"`

	// Amount is the token quantity to release expressed as a decimal string
	// (7 decimal places, Stellar stroops precision), e.g. "1234.5670000".
	Amount string `json:"amount"`

	// Status is the current lifecycle state of the transaction.
	Status TxStatus `json:"status"`

	// OwnerSignature is the hex-encoded Ed25519 signature produced by the vault
	// owner over the canonical transaction hash.  Populated after the owner
	// calls POST /tx/{id}/sign.
	OwnerSignature string `json:"owner_signature,omitempty"`

	// AgentSignature is the hex-encoded Ed25519 counter-signature produced by
	// the Lumina Agent.  Populated after the agent calls POST /tx/{id}/agent-sign.
	AgentSignature string `json:"agent_signature,omitempty"`

	// TxHash is the Stellar transaction hash assigned after successful on-chain
	// submission.  Populated when Status transitions to TxStatusExecuted.
	TxHash string `json:"tx_hash,omitempty"`

	// FailureReason contains the diagnostic message when Status is TxStatusFailed.
	FailureReason string `json:"failure_reason,omitempty"`

	// InitiatedAt is the UTC timestamp when the transaction was first created.
	InitiatedAt time.Time `json:"initiated_at"`

	// UpdatedAt is the UTC timestamp of the most recent state transition.
	UpdatedAt time.Time `json:"updated_at"`
}

// TxInitiateRequest is the inbound JSON body for POST /tx/initiate.
type TxInitiateRequest struct {
	// VaultID identifies the vault that will execute this transaction.
	VaultID string `json:"vault_id"`

	// TxEnvelopeXDR is the base64-encoded Stellar XDR transaction envelope
	// constructed by the frontend before signatures are applied.
	TxEnvelopeXDR string `json:"tx_envelope_xdr"`

	// Recipient is the destination Stellar address for the token release.
	Recipient string `json:"recipient"`

	// Amount is the token quantity as a decimal string (e.g. "10.0000000").
	Amount string `json:"amount"`
}

// TxSignRequest is the inbound JSON body for POST /tx/{id}/sign (owner) and
// POST /tx/{id}/agent-sign (Lumina Agent).
type TxSignRequest struct {
	// Signature is the hex-encoded Ed25519 signature over the canonical
	// transaction hash (double-SHA-256 of the base64 XDR envelope bytes).
	Signature string `json:"signature"`
}

// TxResponse is the outbound JSON body returned by all transaction endpoints.
// It is a projection of MultiSigTransaction safe for external consumption.
type TxResponse struct {
	ID            string   `json:"id"`
	VaultID       string   `json:"vault_id"`
	Status        TxStatus `json:"status"`
	Recipient     string   `json:"recipient"`
	Amount        string   `json:"amount"`
	TxHash        string   `json:"tx_hash,omitempty"`
	FailureReason string   `json:"failure_reason,omitempty"`
	InitiatedAt   int64    `json:"initiated_at"`
	UpdatedAt     int64    `json:"updated_at"`
}

// ToResponse converts a MultiSigTransaction to its safe external representation.
func (t *MultiSigTransaction) ToResponse() TxResponse {
	return TxResponse{
		ID:            t.ID,
		VaultID:       t.VaultID,
		Status:        t.Status,
		Recipient:     t.Recipient,
		Amount:        t.Amount,
		TxHash:        t.TxHash,
		FailureReason: t.FailureReason,
		InitiatedAt:   t.InitiatedAt.Unix(),
		UpdatedAt:     t.UpdatedAt.Unix(),
	}
}
