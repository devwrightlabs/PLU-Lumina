// Package models defines the canonical data structures used across the
// Lumina-Core backend, including multi-sig transaction management and
// cross-chain deposit processing.
package models

import "time"

// ─── Chain & Asset identifiers ────────────────────────────────────────────────

// ChainID identifies a supported external EVM-compatible blockchain.
type ChainID string

const (
	// ChainEthereum is the Ethereum Mainnet.
	ChainEthereum ChainID = "ETH"
	// ChainBSC is Binance Smart Chain.
	ChainBSC ChainID = "BSC"
	// ChainPolygon is the Polygon PoS network.
	ChainPolygon ChainID = "MATIC"
)

// AssetSymbol identifies the external asset being deposited.
type AssetSymbol string

const (
	AssetETH   AssetSymbol = "ETH"
	AssetBTC   AssetSymbol = "BTC"
	AssetUSDT  AssetSymbol = "USDT"
	// AssetBNB is the native asset of Binance Smart Chain.
	AssetBNB   AssetSymbol = "BNB"
	// AssetMATIC is the native asset of the Polygon PoS network.
	AssetMATIC AssetSymbol = "MATIC"
)

// WrappedAsset maps each supported external asset to the Soroban token symbol
// that will be minted inside the user's Lumina Multi-Sig Vault on Pi Network.
// Trustless equivalence: 1 deposited unit ↔ 1 minted wrapped unit.
var WrappedAsset = map[AssetSymbol]string{
	AssetETH:  "piETH",
	AssetBTC:  "piBTC",
	AssetUSDT: "piUSDT",
}

// ─── Deposit lifecycle ────────────────────────────────────────────────────────

// DepositStatus represents the lifecycle state of a cross-chain deposit.
type DepositStatus string

const (
	// DepositStatusPending means the one-time address has been generated and
	// shared with the user; no on-chain transfer has been detected yet.
	DepositStatusPending DepositStatus = "pending"

	// DepositStatusDetected means the listener has seen an inbound transfer on
	// the external chain but the confirmation threshold has not been reached.
	// The deposit stays in this state until MinConfirmations blocks accumulate,
	// guarding against chain re-organisations.
	DepositStatusDetected DepositStatus = "detected"

	// DepositStatusConfirmed means the external transfer has accumulated the
	// required number of on-chain confirmations and is safe to process.
	DepositStatusConfirmed DepositStatus = "confirmed"

	// DepositStatusMinting means the Soroban mint transaction has been
	// submitted to the Pi Network Horizon RPC and is awaiting on-chain
	// inclusion.
	DepositStatusMinting DepositStatus = "minting"

	// DepositStatusMinted means the wrapped asset has been successfully
	// credited to the user's 2-of-2 Multi-Sig Vault on Pi Network.
	DepositStatusMinted DepositStatus = "minted"

	// DepositStatusFailed means the deposit entered an unrecoverable error
	// state.  FailureReason contains the diagnostic message.
	DepositStatusFailed DepositStatus = "failed"

	// DepositStatusExpired means the address window elapsed without any
	// detected transfer; the address is decommissioned.
	DepositStatusExpired DepositStatus = "expired"
)

// ─── CrossChainDeposit ────────────────────────────────────────────────────────

// CrossChainDeposit tracks a single omnichain deposit from address generation
// through EVM confirmation to Soroban vault minting.
//
// Zero-reorg guarantee: the listener never advances a deposit past
// DepositStatusDetected until at least MinConfirmations blocks have been
// observed above DetectedBlock on the external chain.
type CrossChainDeposit struct {
	// ID is a unique, collision-resistant identifier for this deposit record.
	ID string `json:"id"`

	// VaultID is the target Lumina 2-of-2 Multi-Sig Vault that receives the
	// minted wrapped asset.
	VaultID string `json:"vault_id"`

	// OwnerUID is the Pi Network UID of the depositing user.
	OwnerUID string `json:"owner_uid"`

	// Chain identifies the external EVM-compatible blockchain.
	Chain ChainID `json:"chain"`

	// Asset is the external asset being deposited (e.g. ETH, USDT).
	Asset AssetSymbol `json:"asset"`

	// DepositAddress is the one-time EVM address generated for this deposit.
	// The user must send funds exclusively to this address.
	DepositAddress string `json:"deposit_address"`

	// ContractAddress is the ERC-20 token contract on the external chain.
	// Empty for native-asset (ETH / BNB / MATIC) deposits.
	ContractAddress string `json:"contract_address,omitempty"`

	// ExpectedAmount is the user-declared intended deposit amount (informational).
	ExpectedAmount string `json:"expected_amount,omitempty"`

	// ActualAmount is the confirmed on-chain transfer value in the external
	// asset's smallest unit (e.g. wei for ETH, micro-USDT for USDT).
	ActualAmount string `json:"actual_amount,omitempty"`

	// ExternalTxHash is the transaction hash on the external chain that
	// carries the inbound transfer to DepositAddress.
	ExternalTxHash string `json:"external_tx_hash,omitempty"`

	// DetectedBlock is the block number on the external chain where the
	// inbound transfer was first observed.
	DetectedBlock int64 `json:"detected_block,omitempty"`

	// Confirmations is the count of blocks mined above DetectedBlock at the
	// time of the last listener reconciliation cycle.
	Confirmations int `json:"confirmations,omitempty"`

	// Status is the current lifecycle state of the deposit.
	Status DepositStatus `json:"status"`

	// SorobanTxHash is the Stellar transaction hash assigned after the
	// mint_wrapped call is submitted to the Pi Network.
	SorobanTxHash string `json:"soroban_tx_hash,omitempty"`

	// FailureReason contains the diagnostic message when Status is
	// DepositStatusFailed.
	FailureReason string `json:"failure_reason,omitempty"`

	// ExpiresAt is the deadline after which an undetected deposit is marked
	// expired and the address is decommissioned.
	ExpiresAt time.Time `json:"expires_at"`

	// CreatedAt is the UTC timestamp when the deposit record was created.
	CreatedAt time.Time `json:"created_at"`

	// UpdatedAt is the UTC timestamp of the most recent state transition.
	UpdatedAt time.Time `json:"updated_at"`
}

// ─── HTTP request / response types ───────────────────────────────────────────

// DepositAddressRequest is the JSON body for POST /deposit/address.
type DepositAddressRequest struct {
	// VaultID identifies the user's Lumina vault that receives the minted asset.
	VaultID string `json:"vault_id"`
	// Chain is the source external blockchain (e.g. "ETH", "BSC").
	Chain ChainID `json:"chain"`
	// Asset is the external asset to deposit (e.g. "USDT", "ETH").
	Asset AssetSymbol `json:"asset"`
	// ExpectedAmount is the intended deposit quantity (optional, informational).
	ExpectedAmount string `json:"expected_amount,omitempty"`
}

// DepositAddressResponse is returned after successful address generation.
type DepositAddressResponse struct {
	DepositID        string        `json:"deposit_id"`
	DepositAddress   string        `json:"deposit_address"`
	Chain            ChainID       `json:"chain"`
	Asset            AssetSymbol   `json:"asset"`
	WrappedAsset     string        `json:"wrapped_asset"`
	ExpiresAt        int64         `json:"expires_at"`
	Status           DepositStatus `json:"status"`
	// MinConfirmations is the reorg-safe block depth required before the
	// omnichain listener advances this deposit to confirmed status.
	// The frontend should display this value rather than hardcoding a constant.
	MinConfirmations int           `json:"min_confirmations"`
}

// DepositStatusResponse is returned by GET /deposit/{depositID}/status.
type DepositStatusResponse struct {
	DepositID      string        `json:"deposit_id"`
	Status         DepositStatus `json:"status"`
	Chain          ChainID       `json:"chain"`
	Asset          AssetSymbol   `json:"asset"`
	DepositAddress string        `json:"deposit_address"`
	ActualAmount   string        `json:"actual_amount,omitempty"`
	Confirmations  int           `json:"confirmations,omitempty"`
	ExternalTxHash string        `json:"external_tx_hash,omitempty"`
	SorobanTxHash  string        `json:"soroban_tx_hash,omitempty"`
	FailureReason  string        `json:"failure_reason,omitempty"`
	UpdatedAt      int64         `json:"updated_at"`
}
