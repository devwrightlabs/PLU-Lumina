// Package services contains the core business logic for Lumina-Core backend
// operations.
package services

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
)

// ─── Configuration ────────────────────────────────────────────────────────────

const (
	// EnvDepositSeed is the hex-encoded 32-byte master entropy seed used to
	// derive unique, deterministic deposit addresses per request.
	// Required when the omnichain relayer is active.
	//
	// Production note: in a full deployment this seed should be backed by an
	// HSM or secrets manager, and address derivation should use secp256k1 HD
	// wallet key derivation (BIP-44) via go-ethereum's crypto package.  The
	// SHA-256 derivation used here preserves the deterministic address-per-
	// deposit property and is sufficient for address tracking / monitoring;
	// the private key material for sweeping deposited funds must be managed
	// separately by the key-management service.
	EnvDepositSeed = "OMNICHAIN_DEPOSIT_SEED"

	// depositAddressTTL is the duration a deposit address stays valid before
	// it is marked expired and monitoring is suspended.
	depositAddressTTL = 24 * time.Hour
)

// ─── DepositStore ─────────────────────────────────────────────────────────────

// DepositStore manages the lifecycle of cross-chain deposit records using an
// in-memory store protected by a RWMutex.
//
// Concurrency model mirrors TransactionService: all state-mutating operations
// hold the write lock for the minimum read-validate-write window to eliminate
// TOCTOU races.  Read-only queries use a shared read lock.
//
// A production deployment replaces the in-memory map with a PostgreSQL-backed
// repository (see schema.sql for the crosschain_deposits DDL added in Phase 13).
type DepositStore struct {
	mu         sync.RWMutex
	deposits   map[string]*models.CrossChainDeposit
	masterSeed []byte // 32-byte entropy used for deterministic address derivation
}

// NewDepositStore constructs a DepositStore, reading EnvDepositSeed from the
// process environment.  Returns an error if the variable is absent or malformed.
func NewDepositStore() (*DepositStore, error) {
	seedHex := os.Getenv(EnvDepositSeed)
	if seedHex == "" {
		return nil, fmt.Errorf("%s environment variable is required", EnvDepositSeed)
	}

	seed, err := hex.DecodeString(seedHex)
	if err != nil {
		return nil, fmt.Errorf("decoding %s: %w", EnvDepositSeed, err)
	}
	if len(seed) < 32 {
		return nil, fmt.Errorf("%s must be at least 32 bytes (64 hex chars)", EnvDepositSeed)
	}

	return &DepositStore{
		deposits:   make(map[string]*models.CrossChainDeposit),
		masterSeed: seed[:32],
	}, nil
}

// ─── Address derivation ───────────────────────────────────────────────────────

// deriveDepositAddress produces a unique 20-byte EVM-format address for a
// deposit record.  The derivation is deterministic: SHA-256(masterSeed ‖ id).
//
// In a production HSM-backed deployment this function is replaced by proper
// secp256k1 HD wallet key derivation so the address has a corresponding
// spendable private key managed by the sweep service.
func (s *DepositStore) deriveDepositAddress(depositID string) string {
	h := sha256.New()
	h.Write(s.masterSeed)
	h.Write([]byte(depositID))
	digest := h.Sum(nil)
	// Take the last 20 bytes to match Ethereum's keccak(pubkey)[12:] convention.
	return "0x" + hex.EncodeToString(digest[12:])
}

// deriveDepositID generates a collision-resistant deposit ID from the owner
// UID, vault ID, chain, asset, and nanosecond timestamp.
func deriveDepositID(ownerUID, vaultID string, chain models.ChainID, asset models.AssetSymbol, ts time.Time) string {
	h := sha256.New()
	h.Write([]byte("lumina-deposit-v1:"))
	h.Write([]byte(ownerUID))
	h.Write([]byte(":"))
	h.Write([]byte(vaultID))
	h.Write([]byte(":"))
	h.Write([]byte(chain))
	h.Write([]byte(":"))
	h.Write([]byte(asset))
	h.Write([]byte(":"))
	h.Write([]byte(fmt.Sprintf("%d", ts.UnixNano())))
	// Mix in random bytes so two requests at the same nanosecond diverge.
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		log.Panicf("failed to generate deposit ID nonce: %v", err)
	}
	h.Write(nonce[:])
	first := h.Sum(nil)

	h2 := sha256.New()
	h2.Write(first)
	return fmt.Sprintf("%x", h2.Sum(nil))
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

// CreateDeposit generates a unique deposit address and records a new
// CrossChainDeposit in the pending state.
func (s *DepositStore) CreateDeposit(
	ownerUID, vaultID string,
	chain models.ChainID,
	asset models.AssetSymbol,
	contractAddress, expectedAmount string,
) (*models.CrossChainDeposit, error) {
	if ownerUID == "" || vaultID == "" {
		return nil, fmt.Errorf("ownerUID and vaultID are required")
	}
	if _, ok := models.WrappedAsset[asset]; !ok {
		return nil, fmt.Errorf("unsupported asset %q", asset)
	}

	now := time.Now().UTC()
	id := deriveDepositID(ownerUID, vaultID, chain, asset, now)
	addr := s.deriveDepositAddress(id)

	deposit := &models.CrossChainDeposit{
		ID:              id,
		VaultID:         vaultID,
		OwnerUID:        ownerUID,
		Chain:           chain,
		Asset:           asset,
		DepositAddress:  addr,
		ContractAddress: contractAddress,
		ExpectedAmount:  expectedAmount,
		Status:          models.DepositStatusPending,
		ExpiresAt:       now.Add(depositAddressTTL),
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	s.mu.Lock()
	s.deposits[id] = deposit
	s.mu.Unlock()

	// ⚠ Address recovery notice: the SHA-256 based derivation used here
	// produces a valid-format EVM address for monitoring purposes only.
	// Funds sent to this address CANNOT be recovered without a separate
	// secp256k1 HD wallet sweep service that owns the corresponding private
	// key.  In production, replace deriveDepositAddress with go-ethereum's
	// crypto.GenerateKey() + HD wallet derivation and ensure the sweep
	// service indexes this key before presenting the address to users.
	log.Printf("[deposit-store][WARN] sweep service must be operational and indexing deposit keys before presenting address to users id=%s chain=%s asset=%s addr=%s vault=%s",
		id, chain, asset, addr, vaultID)
	log.Printf("[deposit-store] created id=%s chain=%s asset=%s addr=%s vault=%s",
		id, chain, asset, addr, vaultID)
	return copyDeposit(deposit), nil
}

// GetByID retrieves a deposit record by its primary-key ID.
// Returns an error if no matching record exists.
func (s *DepositStore) GetByID(id string) (*models.CrossChainDeposit, error) {
	s.mu.RLock()
	d, ok := s.deposits[id]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("deposit %s not found", id)
	}
	return copyDeposit(d), nil
}

// Update writes a mutated deposit record back into the store.
// Returns an error if the record does not exist.
func (s *DepositStore) Update(d *models.CrossChainDeposit) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.deposits[d.ID]; !ok {
		return fmt.Errorf("deposit %s not found", d.ID)
	}
	cp := *d
	s.deposits[d.ID] = &cp
	return nil
}

// ListPending returns all deposits whose status is pending or detected —
// i.e. those the omnichain listener should actively monitor.
func (s *DepositStore) ListPending() []*models.CrossChainDeposit {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []*models.CrossChainDeposit
	for _, d := range s.deposits {
		if d.Status == models.DepositStatusPending ||
			d.Status == models.DepositStatusDetected {
			cp := copyDeposit(d)
			result = append(result, cp)
		}
	}
	return result
}

// ExpireStale marks any deposit that is still in the pending state and has
// passed its ExpiresAt deadline as expired.  Called periodically by the
// omnichain listener to prevent stale address monitoring.
func (s *DepositStore) ExpireStale() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	count := 0
	for _, d := range s.deposits {
		if d.Status == models.DepositStatusPending && now.After(d.ExpiresAt) {
			d.Status = models.DepositStatusExpired
			d.UpdatedAt = now
			count++
			log.Printf("[deposit-store] deposit %s expired (addr=%s)", d.ID, d.DepositAddress)
		}
	}
	return count
}

// copyDeposit returns a shallow copy so callers cannot mutate stored records.
func copyDeposit(d *models.CrossChainDeposit) *models.CrossChainDeposit {
	cp := *d
	return &cp
}
