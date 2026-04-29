// Deposit handler wiring for the Lumina-Core backend.
// Exposes the POST /deposit/address endpoint that generates a one-time EVM
// deposit address tied to the authenticated user's 2-of-2 Multi-Sig Vault.
//
// Phase 13 – Omnichain Relayer integration:
//   - POST /deposit/address  : generate a one-time deposit address
//   - GET  /deposit/:id/status : poll the deposit lifecycle state
package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/gorilla/mux"

	"github.com/devwrightlabs/plu-lumina/backend/internal/middleware"
	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
	"github.com/devwrightlabs/plu-lumina/backend/internal/services"
)

// ─── Package-level DepositStore ───────────────────────────────────────────────

var depositStore *services.DepositStore
var depositStoreOnce sync.Once

// depositMinConfirmations is the reorg-safe confirmation depth read from the
// omnichain listener at startup and returned to clients in DepositAddressResponse
// so the UI can display the correct threshold without hardcoding.
var depositMinConfirmations int

// InitDepositStore stores the shared DepositStore and the configured minimum
// confirmation count for use by deposit HTTP handlers.
// Must be called once during server startup; subsequent calls are no-ops.
func InitDepositStore(s *services.DepositStore, minConfirmations int) {
	depositStoreOnce.Do(func() {
		depositStore = s
		depositMinConfirmations = minConfirmations
	})
}

// ─── POST /deposit/address ────────────────────────────────────────────────────

// DepositAddress generates a unique one-time EVM deposit address for the
// authenticated user's vault and the requested chain/asset pair.
//
// Flow:
//  1. Extract the authenticated Pi UID from the request context.
//  2. Decode and validate the JSON request body.
//  3. Look up the ERC-20 contract address for the requested asset (if applicable)
//     from the OMNICHAIN_<ASSET>_CONTRACT environment variable.
//  4. Delegate to DepositStore.CreateDeposit to generate and persist the
//     one-time address.
//  5. Return the address along with its expiry timestamp and lifecycle status.
func DepositAddress(w http.ResponseWriter, r *http.Request) {
	if depositStore == nil {
		writeError(w, http.StatusServiceUnavailable,
			"omnichain relayer not initialised; set OMNICHAIN_DEPOSIT_SEED and EVM_RPC_URL")
		return
	}

	uid, _ := r.Context().Value(middleware.ContextKeyUID).(string)

	var req models.DepositAddressRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.VaultID == "" {
		writeError(w, http.StatusBadRequest, "vault_id is required")
		return
	}
	if req.Chain == "" {
		writeError(w, http.StatusBadRequest, "chain is required (e.g. ETH, BSC)")
		return
	}
	if req.Asset == "" {
		writeError(w, http.StatusBadRequest, "asset is required (e.g. USDT, ETH)")
		return
	}

	// Resolve the ERC-20 contract address from configuration.
	// Native assets (ETH, BNB, MATIC) have an empty contract address.
	contractAddress := resolveContractAddress(req.Chain, req.Asset)

	deposit, err := depositStore.CreateDeposit(
		uid,
		req.VaultID,
		req.Chain,
		req.Asset,
		contractAddress,
		req.ExpectedAmount,
	)
	if err != nil {
		log.Printf("[deposit] create error uid=%s vault=%s chain=%s asset=%s: %v",
			uid, req.VaultID, req.Chain, req.Asset, err)
		writeError(w, http.StatusBadRequest, "could not generate deposit address: "+err.Error())
		return
	}

	wrappedSymbol := models.WrappedAsset[deposit.Asset]

	writeJSON(w, http.StatusCreated, models.DepositAddressResponse{
		DepositID:        deposit.ID,
		DepositAddress:   deposit.DepositAddress,
		Chain:            deposit.Chain,
		Asset:            deposit.Asset,
		WrappedAsset:     wrappedSymbol,
		ExpiresAt:        deposit.ExpiresAt.Unix(),
		Status:           deposit.Status,
		MinConfirmations: depositMinConfirmations,
	})
}

// ─── GET /deposit/{depositID}/status ─────────────────────────────────────────

// DepositStatus returns the current lifecycle state of a cross-chain deposit.
//
// Flow:
//  1. Extract depositID from the URL path variables.
//  2. Retrieve the record from the DepositStore.
//  3. Return the projection safe for external consumption.
func DepositStatus(w http.ResponseWriter, r *http.Request) {
	if depositStore == nil {
		writeError(w, http.StatusServiceUnavailable,
			"omnichain relayer not initialised")
		return
	}

	depositID := mux.Vars(r)["depositID"]
	if depositID == "" {
		writeError(w, http.StatusBadRequest, "depositID path parameter is required")
		return
	}

	deposit, err := depositStore.GetByID(depositID)
	if err != nil {
		writeError(w, http.StatusNotFound, "deposit not found")
		return
	}

	writeJSON(w, http.StatusOK, models.DepositStatusResponse{
		DepositID:      deposit.ID,
		Status:         deposit.Status,
		Chain:          deposit.Chain,
		Asset:          deposit.Asset,
		DepositAddress: deposit.DepositAddress,
		ActualAmount:   deposit.ActualAmount,
		Confirmations:  deposit.Confirmations,
		ExternalTxHash: deposit.ExternalTxHash,
		SorobanTxHash:  deposit.SorobanTxHash,
		FailureReason:  deposit.FailureReason,
		UpdatedAt:      deposit.UpdatedAt.Unix(),
	})
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// resolveContractAddress returns the ERC-20 contract address for a given chain
// and asset, read from the process environment.
//
// Convention: OMNICHAIN_{CHAIN}_{ASSET}_CONTRACT
//   - OMNICHAIN_ETH_USDT_CONTRACT  → USDT on Ethereum
//   - OMNICHAIN_BSC_USDT_CONTRACT  → USDT on BSC (different contract address)
//
// Native assets (ETH, BNB, MATIC) do not have a contract address; an empty
// string is returned and the listener will use eth_getBalance instead of
// eth_getLogs.
func resolveContractAddress(chain models.ChainID, asset models.AssetSymbol) string {
	// Native asset symbols match their chain's native token; no contract needed.
	nativeAssets := map[models.ChainID]models.AssetSymbol{
		models.ChainEthereum: models.AssetETH,
		models.ChainBSC:      models.AssetBNB,
		models.ChainPolygon:  models.AssetMATIC,
	}
	if native, ok := nativeAssets[chain]; ok && native == asset {
		return ""
	}

	envKey := "OMNICHAIN_" + string(chain) + "_" + string(asset) + "_CONTRACT"
	return os.Getenv(envKey)
}
