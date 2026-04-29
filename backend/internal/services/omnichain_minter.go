// Package services contains the core business logic for Lumina-Core backend
// operations.
package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
)

// ─── Environment variable names ───────────────────────────────────────────────

const (
	// EnvMasterProtocolContract is the address of the deployed Soroban Master
	// Protocol contract that handles mint_wrapped calls.
	EnvMasterProtocolContract = "SOROBAN_MASTER_PROTOCOL_CONTRACT"
)

// ─── OmnichainMinter ──────────────────────────────────────────────────────────

// OmnichainMinter formats and submits Soroban mint_wrapped calls to the Pi
// Network when an external cross-chain deposit is confirmed.
//
// Flow for each confirmed deposit:
//  1. Derive the wrapped asset symbol (e.g. ETH → piETH).
//  2. Build a typed sorobanCallEnvelope targeting the master protocol's
//     mint_wrapped function.
//  3. Base64-encode the envelope and submit it to the Stellar Horizon RPC.
//  4. Persist the resulting Soroban transaction hash in the deposit record.
//
// All credentials and endpoint URLs are read exclusively from environment
// variables at construction time; no secrets are ever hard-coded.
type OmnichainMinter struct {
	store           *DepositStore
	horizonURL      string
	contractAddress string
	networkPass     string
	httpClient      *http.Client
}

// NewOmnichainMinter constructs an OmnichainMinter from environment variables.
// EnvHorizonURL, EnvNetworkPassphrase, and EnvMasterProtocolContract must all
// be set; an error is returned if any are missing.
func NewOmnichainMinter(store *DepositStore) (*OmnichainMinter, error) {
	if store == nil {
		return nil, fmt.Errorf("deposit store must not be nil")
	}

	horizonURL := os.Getenv(EnvHorizonURL)
	if horizonURL == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvHorizonURL)
	}

	contractAddr := os.Getenv(EnvMasterProtocolContract)
	if contractAddr == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvMasterProtocolContract)
	}

	networkPass := os.Getenv(EnvNetworkPassphrase)
	if networkPass == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvNetworkPassphrase)
	}

	return &OmnichainMinter{
		store:           store,
		horizonURL:      strings.TrimRight(horizonURL, "/"),
		contractAddress: contractAddr,
		networkPass:     networkPass,
		httpClient: &http.Client{
			Timeout:   horizonSubmitTimeout,
			Transport: http.DefaultTransport,
		},
	}, nil
}

// MintWrapped submits a Soroban mint_wrapped transaction for a confirmed
// cross-chain deposit.
//
// It advances the deposit through DepositStatusMinting → DepositStatusMinted
// on success, or to DepositStatusFailed on a non-retryable error.
func (m *OmnichainMinter) MintWrapped(ctx context.Context, depositID string) error {
	deposit, err := m.store.GetByID(depositID)
	if err != nil {
		return fmt.Errorf("fetching deposit %s: %w", depositID, err)
	}

	if deposit.Status != models.DepositStatusConfirmed {
		return fmt.Errorf(
			"invalid state for minting: expected %s, got %s",
			models.DepositStatusConfirmed, deposit.Status,
		)
	}

	wrappedSymbol, ok := models.WrappedAsset[deposit.Asset]
	if !ok {
		return m.failDeposit(deposit, fmt.Sprintf("unsupported asset %q", deposit.Asset))
	}

	// Build the Soroban invoke_host_function envelope targeting the master
	// protocol's mint_wrapped entry point.  The master protocol contract
	// (Phase 9/10) authenticates the call via the Lumina Agent signature that
	// will be attached during the subsequent multi-sig flow.
	envelope, err := m.buildMintEnvelope(deposit, wrappedSymbol)
	if err != nil {
		return m.failDeposit(deposit, "building mint envelope: "+err.Error())
	}

	// Advance to minting before submission so a crash during submitToHorizon
	// does not leave the deposit in confirmed; the operator can retry from
	// the minting state.
	deposit.Status = models.DepositStatusMinting
	deposit.UpdatedAt = time.Now().UTC()
	if err := m.store.Update(deposit); err != nil {
		return fmt.Errorf("persisting minting state for deposit %s: %w", depositID, err)
	}

	txHash, err := m.submitToHorizon(ctx, envelope)
	if err != nil {
		return m.failDeposit(deposit, "horizon submission: "+err.Error())
	}

	deposit.SorobanTxHash = txHash
	deposit.Status = models.DepositStatusMinted
	deposit.UpdatedAt = time.Now().UTC()
	if err := m.store.Update(deposit); err != nil {
		// On-chain success but DB update failed — log with full detail for
		// manual reconciliation.
		log.Printf(
			"[omnichain-minter] CRITICAL: deposit=%s minted on-chain (soroban_hash=%s) but store update failed: %v",
			depositID, txHash, err,
		)
		return fmt.Errorf("persisting mint result for deposit %s: %w", depositID, err)
	}

	log.Printf("[omnichain-minter] minted deposit=%s asset=%s→%s soroban_hash=%s",
		depositID, deposit.Asset, wrappedSymbol, txHash)
	return nil
}

// ─── Envelope builder ─────────────────────────────────────────────────────────

// buildMintEnvelope produces the base64-encoded sorobanCallEnvelope for the
// master protocol's mint_wrapped function call.
//
// Function signature (Soroban Rust):
//
//	fn mint_wrapped(
//	    env: Env,
//	    recipient_vault: Address,  // The user's 2-of-2 vault address
//	    asset_symbol:    Symbol,   // e.g. "piUSDT"
//	    amount:          i128,     // ActualAmount in smallest external unit
//	    external_tx_hash: Bytes,   // External chain tx hash for auditability
//	) -> Result<(), Error>
func (m *OmnichainMinter) buildMintEnvelope(
	deposit *models.CrossChainDeposit,
	wrappedSymbol string,
) (string, error) {
	if deposit.ActualAmount == "" {
		return "", fmt.Errorf("actual_amount is required for minting")
	}
	if deposit.VaultID == "" {
		return "", fmt.Errorf("vault_id is required for minting")
	}

	env := sorobanCallEnvelope{
		ContractAddress:   m.contractAddress,
		FunctionName:      "mint_wrapped",
		NetworkPassphrase: m.networkPass,
		Args: []sorobanCallArg{
			// Recipient vault: the user's 2-of-2 Multi-Sig vault address on Pi Network.
			{Type: "address", Value: deposit.VaultID},
			// Asset symbol: the wrapped token to mint (e.g. "piUSDT").
			{Type: "symbol", Value: wrappedSymbol},
			// Amount: exact value from the confirmed external-chain transfer.
			{Type: "i128", Value: deposit.ActualAmount},
			// External chain provenance: makes the mint call auditable on-chain.
			{Type: "bytes", Value: deposit.ExternalTxHash},
		},
	}

	raw, err := json.Marshal(env)
	if err != nil {
		return "", fmt.Errorf("marshalling mint envelope: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// ─── Horizon submission ───────────────────────────────────────────────────────

// submitToHorizon posts the base64-encoded Soroban envelope to the Stellar
// Horizon POST /transactions endpoint.
func (m *OmnichainMinter) submitToHorizon(ctx context.Context, envelopeB64 string) (string, error) {
	endpoint := m.horizonURL + "/transactions"

	formData := url.Values{}
	formData.Set("tx", envelopeB64)

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		strings.NewReader(formData.Encode()),
	)
	if err != nil {
		return "", fmt.Errorf("building horizon request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("horizon HTTP request: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading horizon response: %w", err)
	}

	var result horizonSubmitResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("decoding horizon response (status=%d): %w", resp.StatusCode, err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		reason := extractHorizonError(&result, resp.StatusCode)
		return "", fmt.Errorf("horizon rejected mint transaction: %s", reason)
	}

	if result.Hash == "" {
		return "", fmt.Errorf("horizon returned empty transaction hash")
	}

	return result.Hash, nil
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// failDeposit marks the deposit as failed with the given reason, persists the
// update, and returns a wrapped error for the caller to log.
func (m *OmnichainMinter) failDeposit(deposit *models.CrossChainDeposit, reason string) error {
	deposit.Status = models.DepositStatusFailed
	deposit.FailureReason = reason
	deposit.UpdatedAt = time.Now().UTC()
	if updateErr := m.store.Update(deposit); updateErr != nil {
		log.Printf("[omnichain-minter] failed to persist failure for deposit=%s: %v",
			deposit.ID, updateErr)
	}
	log.Printf("[omnichain-minter] deposit=%s failed: %s", deposit.ID, reason)
	return fmt.Errorf("mint failed for deposit %s: %s", deposit.ID, reason)
}
