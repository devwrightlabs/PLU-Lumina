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
	"github.com/devwrightlabs/plu-lumina/backend/internal/repository"
)

// ─── Environment variable names ───────────────────────────────────────────────

const (
	// EnvHorizonURL is the Stellar Horizon REST API base URL.
	EnvHorizonURL = "STELLAR_HORIZON_URL"

	// EnvAMMContractAddress is the deployed Soroban AMM contract address.
	EnvAMMContractAddress = "AMM_CONTRACT_ADDRESS"

	// EnvNetworkPassphrase is the Stellar network passphrase used to
	// distinguish Mainnet from Testnet in transaction signing.
	EnvNetworkPassphrase = "STELLAR_NETWORK_PASSPHRASE"
)

// ─── AMMOperation ─────────────────────────────────────────────────────────────

// AMMOperation identifies the Soroban contract function to invoke.
type AMMOperation string

const (
	// AMMOperationSwap performs a direct token swap via the AMM contract.
	AMMOperationSwap AMMOperation = "swap"

	// AMMOperationAddLiquidity deposits a token pair into the AMM pool and
	// mints LP tokens to the caller.
	AMMOperationAddLiquidity AMMOperation = "add_liquidity"

	// AMMOperationRemoveLiquidity burns LP tokens and returns the underlying
	// token pair to the caller.
	AMMOperationRemoveLiquidity AMMOperation = "remove_liquidity"
)

// ─── Parameter types ──────────────────────────────────────────────────────────

// SwapParams holds the parameters required to build a token swap envelope.
type SwapParams struct {
	// TokenIn is the Stellar asset code (or contract address) for the input token.
	TokenIn string
	// TokenOut is the Stellar asset code (or contract address) for the output token.
	TokenOut string
	// AmountIn is the sell quantity, expressed as a decimal string with 7 dp
	// (Stellar stroop precision), e.g. "100.0000000".
	AmountIn string
	// MinAmountOut is the minimum acceptable output (slippage guard), same format.
	MinAmountOut string
	// Recipient is the Stellar address that will receive the TokenOut.
	Recipient string
}

// LiquidityParams holds the parameters required to build an add-liquidity envelope.
type LiquidityParams struct {
	// TokenA is the first token of the liquidity pair.
	TokenA string
	// TokenB is the second token of the liquidity pair.
	TokenB string
	// AmountA is the desired deposit amount for TokenA (decimal string, 7 dp).
	AmountA string
	// AmountB is the desired deposit amount for TokenB (decimal string, 7 dp).
	AmountB string
	// MinLPTokens is the minimum acceptable LP token output (slippage guard).
	MinLPTokens string
	// Recipient receives the minted LP tokens.
	Recipient string
}

// horizonSubmitTimeout is the http.Client-level hard deadline for a single
// Stellar Horizon transaction-submission request.  It acts as a backstop for
// callers that pass a context without a deadline.
const horizonSubmitTimeout = 30 * time.Second

// ─── Internal Soroban envelope representation ─────────────────────────────────

// sorobanCallEnvelope is the structured representation of a Soroban
// invoke_host_function call.  It is JSON-marshalled and then standard-base64
// encoded before being stored in the MultiSigTransaction.TxEnvelopeXDR field.
//
// In a deployment that integrates the full Stellar Go SDK this type would be
// replaced with actual XDR binary encoding; using a typed JSON envelope here
// preserves full auditability and schema clarity while remaining independent
// of the SDK import.
type sorobanCallEnvelope struct {
	ContractAddress   string           `json:"contract_address"`
	FunctionName      string           `json:"function_name"`
	Args              []sorobanCallArg `json:"args"`
	NetworkPassphrase string           `json:"network_passphrase"`
}

// sorobanCallArg is a single typed argument to a Soroban function call.
type sorobanCallArg struct {
	// Type is the Soroban value type, e.g. "address", "i128", "u64".
	Type string `json:"type"`
	// Value is the string representation of the argument value.
	Value string `json:"value"`
}

// ─── Horizon response types ───────────────────────────────────────────────────

// horizonSubmitResponse is the minimal subset of the Stellar Horizon
// POST /transactions response that AMMService requires.
type horizonSubmitResponse struct {
	Hash       string `json:"hash"`
	Successful bool   `json:"successful"`
	// ErrorResultXDR is populated by Horizon on submission failure.
	ErrorResultXDR string `json:"error_result_xdr,omitempty"`
	// Extras carries the Horizon error detail envelope on failure.
	Extras *struct {
		ResultCodes *struct {
			Transaction string   `json:"transaction,omitempty"`
			Operations  []string `json:"operations,omitempty"`
		} `json:"result_codes,omitempty"`
	} `json:"extras,omitempty"`
}

// ─── AMMService ───────────────────────────────────────────────────────────────

// AMMService formats and submits AMM operations as 2-of-2 multi-sig
// transactions.  It consumes the signed XDR envelopes produced by Phases 5
// and 6, packages them with Soroban contract call data, and submits them to
// the Stellar Horizon API for on-chain execution against the AMM contract.
//
// All credentials and endpoint URLs are read exclusively from environment
// variables at construction time; no secrets are ever hard-coded.
type AMMService struct {
	repo              repository.TransactionRepository
	horizonURL        string
	contractAddress   string
	networkPassphrase string
	httpClient        *http.Client
}

// NewAMMService constructs an AMMService, reading EnvHorizonURL,
// EnvAMMContractAddress, and EnvNetworkPassphrase from the process
// environment.  Returns an error if any required variable is absent.
func NewAMMService(repo repository.TransactionRepository) (*AMMService, error) {
	if repo == nil {
		return nil, fmt.Errorf("repository must not be nil")
	}

	horizonURL := os.Getenv(EnvHorizonURL)
	if horizonURL == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvHorizonURL)
	}

	contractAddr := os.Getenv(EnvAMMContractAddress)
	if contractAddr == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvAMMContractAddress)
	}

	networkPassphrase := os.Getenv(EnvNetworkPassphrase)
	if networkPassphrase == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvNetworkPassphrase)
	}

	return &AMMService{
		repo:              repo,
		horizonURL:        strings.TrimRight(horizonURL, "/"),
		contractAddress:   contractAddr,
		networkPassphrase: networkPassphrase,
		httpClient: &http.Client{
			// horizonSubmitTimeout is a hard backstop; callers supply a context
			// deadline for coarser per-operation timeouts.
			Timeout:   horizonSubmitTimeout,
			Transport: http.DefaultTransport,
		},
	}, nil
}

// ─── Envelope builders ────────────────────────────────────────────────────────

// BuildSwapEnvelope formats a token swap into a base64-encoded Soroban
// invoke_host_function call envelope.  The returned string is suitable for
// use as the TxEnvelopeXDR field when initiating a new multi-sig transaction.
func (s *AMMService) BuildSwapEnvelope(params SwapParams) (string, error) {
	if params.TokenIn == "" || params.TokenOut == "" ||
		params.AmountIn == "" || params.MinAmountOut == "" ||
		params.Recipient == "" {
		return "", fmt.Errorf("all SwapParams fields are required")
	}

	env := sorobanCallEnvelope{
		ContractAddress:   s.contractAddress,
		FunctionName:      string(AMMOperationSwap),
		NetworkPassphrase: s.networkPassphrase,
		Args: []sorobanCallArg{
			{Type: "address", Value: params.TokenIn},
			{Type: "address", Value: params.TokenOut},
			{Type: "i128", Value: params.AmountIn},
			{Type: "i128", Value: params.MinAmountOut},
			{Type: "address", Value: params.Recipient},
		},
	}
	return marshalEnvelope(env)
}

// BuildAddLiquidityEnvelope formats a liquidity deposit into a base64-encoded
// Soroban invoke_host_function call envelope.
func (s *AMMService) BuildAddLiquidityEnvelope(params LiquidityParams) (string, error) {
	if params.TokenA == "" || params.TokenB == "" ||
		params.AmountA == "" || params.AmountB == "" ||
		params.MinLPTokens == "" || params.Recipient == "" {
		return "", fmt.Errorf("all LiquidityParams fields are required")
	}

	env := sorobanCallEnvelope{
		ContractAddress:   s.contractAddress,
		FunctionName:      string(AMMOperationAddLiquidity),
		NetworkPassphrase: s.networkPassphrase,
		Args: []sorobanCallArg{
			{Type: "address", Value: params.TokenA},
			{Type: "address", Value: params.TokenB},
			{Type: "i128", Value: params.AmountA},
			{Type: "i128", Value: params.AmountB},
			{Type: "i128", Value: params.MinLPTokens},
			{Type: "address", Value: params.Recipient},
		},
	}
	return marshalEnvelope(env)
}

// BuildRemoveLiquidityEnvelope formats a liquidity withdrawal into a
// base64-encoded Soroban invoke_host_function call envelope.
func (s *AMMService) BuildRemoveLiquidityEnvelope(params LiquidityParams) (string, error) {
	if params.TokenA == "" || params.TokenB == "" ||
		params.AmountA == "" || params.AmountB == "" ||
		params.MinLPTokens == "" || params.Recipient == "" {
		return "", fmt.Errorf("all LiquidityParams fields are required")
	}

	env := sorobanCallEnvelope{
		ContractAddress:   s.contractAddress,
		FunctionName:      string(AMMOperationRemoveLiquidity),
		NetworkPassphrase: s.networkPassphrase,
		Args: []sorobanCallArg{
			{Type: "address", Value: params.TokenA},
			{Type: "address", Value: params.TokenB},
			{Type: "i128", Value: params.AmountA},
			{Type: "i128", Value: params.AmountB},
			{Type: "i128", Value: params.MinLPTokens},
			{Type: "address", Value: params.Recipient},
		},
	}
	return marshalEnvelope(env)
}

// ─── On-chain submission ──────────────────────────────────────────────────────

// SubmitSignedTransaction submits a fully-signed 2-of-2 multi-sig transaction
// to the Stellar Horizon API.  The transaction must be in the ready_to_execute
// state with both OwnerSignature and AgentSignature populated (generated in
// Phases 5 and 6).
//
// On success:
//   - tx.TxHash is populated with the hash returned by Horizon.
//   - tx.Status advances to TxStatusExecuted.
//   - The record is persisted via the repository.
//
// On Horizon rejection:
//   - tx.Status is set to TxStatusFailed.
//   - tx.FailureReason records the Horizon error detail.
//   - The record is persisted via the repository.
//   - An error is returned to the caller.
func (s *AMMService) SubmitSignedTransaction(ctx context.Context, txID string) error {
	if txID == "" {
		return fmt.Errorf("txID is required")
	}

	tx, err := s.repo.GetByID(ctx, txID)
	if err != nil {
		return fmt.Errorf("fetching transaction %s: %w", txID, err)
	}

	if tx.Status != models.TxStatusReadyToExecute {
		return fmt.Errorf(
			"invalid state: expected %s, got %s",
			models.TxStatusReadyToExecute, tx.Status,
		)
	}

	// Defence-in-depth: both signatures must be present even though the state
	// machine should guarantee this by the time we reach ready_to_execute.
	if tx.OwnerSignature == "" || tx.AgentSignature == "" {
		return fmt.Errorf("transaction %s is missing one or more required signatures", txID)
	}

	txHash, err := s.submitToHorizon(ctx, tx.TxEnvelopeXDR)
	if err != nil {
		// Persist the rejection so operators can diagnose the problem.
		tx.Status = models.TxStatusFailed
		tx.FailureReason = "horizon submission failed: " + err.Error()
		tx.UpdatedAt = time.Now().UTC()
		if updateErr := s.repo.Update(ctx, tx); updateErr != nil {
			log.Printf("[amm] failed to persist submission failure tx=%s: %v", txID, updateErr)
		}
		return fmt.Errorf("submitting transaction %s to horizon: %w", txID, err)
	}

	tx.TxHash = txHash
	tx.Status = models.TxStatusExecuted
	tx.UpdatedAt = time.Now().UTC()

	if err := s.repo.Update(ctx, tx); err != nil {
		// The transaction is on-chain but we failed to update the DB.
		// Log with enough detail for a manual recovery operation.
		log.Printf("[amm] CRITICAL: tx=%s submitted (hash=%s) but DB update failed: %v",
			txID, txHash, err)
		return fmt.Errorf("persisting execution result for tx=%s: %w", txID, err)
	}

	log.Printf("[amm] submitted tx=%s horizon_hash=%s", txID, txHash)
	return nil
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// submitToHorizon posts the base64-encoded XDR envelope to the Stellar Horizon
// POST /transactions endpoint and returns the transaction hash on success.
func (s *AMMService) submitToHorizon(ctx context.Context, envelopeXDR string) (string, error) {
	endpoint := s.horizonURL + "/transactions"

	formData := url.Values{}
	formData.Set("tx", envelopeXDR)

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

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("horizon HTTP request: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading horizon response body: %w", err)
	}

	var result horizonSubmitResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("decoding horizon response (status=%d): %w", resp.StatusCode, err)
	}

	// Horizon returns 200 or 201 on success; 4xx/5xx on failure.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		reason := extractHorizonError(&result, resp.StatusCode)
		return "", fmt.Errorf("horizon rejected transaction: %s", reason)
	}

	if result.Hash == "" {
		return "", fmt.Errorf("horizon returned empty transaction hash")
	}

	return result.Hash, nil
}

// extractHorizonError builds a human-readable rejection message from a
// horizonSubmitResponse and the HTTP status code.
func extractHorizonError(r *horizonSubmitResponse, statusCode int) string {
	if r.Extras != nil && r.Extras.ResultCodes != nil {
		if r.Extras.ResultCodes.Transaction != "" {
			codes := r.Extras.ResultCodes.Transaction
			if len(r.Extras.ResultCodes.Operations) > 0 {
				codes += " ops=" + strings.Join(r.Extras.ResultCodes.Operations, ",")
			}
			return codes
		}
	}
	if r.ErrorResultXDR != "" {
		return fmt.Sprintf("HTTP %d (result_xdr=%s)", statusCode, r.ErrorResultXDR)
	}
	return fmt.Sprintf("HTTP %d", statusCode)
}

// marshalEnvelope JSON-encodes the sorobanCallEnvelope and returns the
// standard-base64 representation for use as TxEnvelopeXDR.
func marshalEnvelope(env sorobanCallEnvelope) (string, error) {
	raw, err := json.Marshal(env)
	if err != nil {
		return "", fmt.Errorf("marshalling soroban envelope: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}
