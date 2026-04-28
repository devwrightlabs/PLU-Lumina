// Package workers contains long-running background processes for Lumina-Core.
// Workers are designed to run as goroutines started during server startup and
// cancelled cleanly via context on graceful shutdown.
package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
	"github.com/devwrightlabs/plu-lumina/backend/internal/repository"
)

// ─── Timing constants ─────────────────────────────────────────────────────────

const (
	// defaultPollInterval is the normal cadence between reconciliation cycles
	// when no errors are occurring.
	defaultPollInterval = 15 * time.Second

	// minBackoff is the initial back-off applied after the first recoverable
	// error in a reconciliation cycle.
	minBackoff = 5 * time.Second

	// maxBackoff is the upper bound for exponential back-off so that a
	// prolonged Horizon outage does not hold the goroutine indefinitely.
	maxBackoff = 5 * time.Minute

	// txConfirmationTimeout is the maximum duration (measured from UpdatedAt)
	// that the listener will wait for a submitted transaction to appear on
	// the Stellar network before declaring it permanently unconfirmed.
	txConfirmationTimeout = 30 * time.Minute

	// horizonRequestTimeout is the per-request hard deadline for Horizon API
	// calls.  It is intentionally shorter than defaultPollInterval so that a
	// slow Horizon node cannot consume an entire reconciliation cycle.
	horizonRequestTimeout = 10 * time.Second
)

// ─── Horizon response type ────────────────────────────────────────────────────

// horizonTransactionResponse is the minimal subset of the Stellar Horizon
// GET /transactions/{hash} response required by ChainListener.
type horizonTransactionResponse struct {
	Hash       string `json:"hash"`
	Successful bool   `json:"successful"`
	Ledger     int64  `json:"ledger"`
	// Extras carries result codes when Successful is false.
	Extras *struct {
		ResultCodes *struct {
			Transaction string   `json:"transaction,omitempty"`
			Operations  []string `json:"operations,omitempty"`
		} `json:"result_codes,omitempty"`
	} `json:"extras,omitempty"`
}

// ─── horizonNotFoundError ─────────────────────────────────────────────────────

// horizonNotFoundError is returned when Horizon responds with HTTP 404 for a
// transaction lookup.  It is distinct from general network errors so the
// listener can apply a grace period before marking a transaction as failed.
type horizonNotFoundError struct{ hash string }

func (e *horizonNotFoundError) Error() string {
	return fmt.Sprintf("transaction %s not found on Horizon", e.hash)
}

// isHorizonNotFound reports whether err wraps a horizonNotFoundError.
func isHorizonNotFound(err error) bool {
	if err == nil {
		return false
	}
	_, ok := err.(*horizonNotFoundError)
	return ok
}

// ─── Config ───────────────────────────────────────────────────────────────────

// Config holds the configuration for ChainListener construction.
type Config struct {
	// HorizonURL is the base URL of the Stellar Horizon REST API.
	// Required; example: "https://horizon-testnet.stellar.org"
	HorizonURL string

	// PollInterval overrides the normal reconciliation cadence.
	// Defaults to defaultPollInterval when zero.
	PollInterval time.Duration
}

// ─── ChainListener ────────────────────────────────────────────────────────────

// ChainListener is a background worker that polls the Stellar Horizon API to
// reconcile the Supabase transaction state with confirmed on-chain events.
//
// Concurrency model:
//   - Run is designed to be launched as a single goroutine.  All
//     reconciliation work is serialised internally; the goroutine exits cleanly
//     when the supplied context is cancelled.
//
// Resilience strategy:
//  1. Each reconciliation cycle runs under a derived context bounded by the
//     poll interval, so a hung Horizon API call cannot block the loop
//     indefinitely.
//  2. Transient Horizon or database errors trigger exponential back-off
//     (minBackoff → … → maxBackoff) before the next attempt; the ticker is
//     reset so normal cadence resumes automatically on recovery.
//  3. Individual per-transaction errors are logged without aborting the rest
//     of the cycle, ensuring a single bad record cannot stall state updates
//     for all other in-flight transactions.
//  4. Network drops mid-cycle do not corrupt database state because each
//     repository.Update call uses an explicit database transaction.
type ChainListener struct {
	repo         repository.TransactionRepository
	horizonURL   string
	pollInterval time.Duration
	httpClient   *http.Client
}

// NewChainListener constructs a ChainListener from explicit configuration.
// Returns an error if repo is nil or Config.HorizonURL is empty.
func NewChainListener(repo repository.TransactionRepository, cfg Config) (*ChainListener, error) {
	if repo == nil {
		return nil, fmt.Errorf("repository must not be nil")
	}
	if cfg.HorizonURL == "" {
		return nil, fmt.Errorf("Config.HorizonURL is required")
	}

	interval := cfg.PollInterval
	if interval <= 0 {
		interval = defaultPollInterval
	}

	return &ChainListener{
		repo:         repo,
		horizonURL:   strings.TrimRight(cfg.HorizonURL, "/"),
		pollInterval: interval,
		httpClient: &http.Client{
			Timeout:   horizonRequestTimeout,
			Transport: http.DefaultTransport,
		},
	}, nil
}

// NewChainListenerFromEnv is a convenience constructor that reads STELLAR_HORIZON_URL
// from the process environment.  Returns an error if the variable is absent.
func NewChainListenerFromEnv(repo repository.TransactionRepository) (*ChainListener, error) {
	horizonURL := os.Getenv("STELLAR_HORIZON_URL")
	if horizonURL == "" {
		return nil, fmt.Errorf("STELLAR_HORIZON_URL environment variable is required")
	}
	return NewChainListener(repo, Config{HorizonURL: horizonURL})
}

// ─── Run ──────────────────────────────────────────────────────────────────────

// Run starts the blockchain event listener loop and blocks until ctx is
// cancelled.  It must be invoked in a dedicated goroutine:
//
//	listenerCtx, cancel := context.WithCancel(context.Background())
//	defer cancel()
//	go listener.Run(listenerCtx)
func (l *ChainListener) Run(ctx context.Context) {
	log.Printf("[chain-listener] started (poll_interval=%s horizon=%s)",
		l.pollInterval, l.horizonURL)

	ticker := time.NewTicker(l.pollInterval)
	defer ticker.Stop()

	currentBackoff := time.Duration(0)

	for {
		select {
		case <-ctx.Done():
			log.Println("[chain-listener] context cancelled; stopping")
			return

		case <-ticker.C:
			// Each cycle gets its own bounded context so a slow Horizon
			// response cannot hold the ticker goroutine indefinitely.
			cycleCtx, cycleCancel := context.WithTimeout(ctx, l.pollInterval)
			err := l.reconcile(cycleCtx)
			cycleCancel()

			if err != nil {
				currentBackoff = nextBackoff(currentBackoff)
				log.Printf("[chain-listener] reconcile error (backing off %s): %v",
					currentBackoff, err)
				ticker.Reset(currentBackoff)
			} else {
				if currentBackoff > 0 {
					log.Println("[chain-listener] connection recovered; resuming normal poll cadence")
				}
				currentBackoff = 0
				ticker.Reset(l.pollInterval)
			}
		}
	}
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

// reconcile performs one full reconciliation cycle.
//
// It queries the repository for every transaction currently in the
// TxStatusExecuted state, then checks each one that has a recorded TxHash
// against the Stellar Horizon API to verify the on-chain outcome.  Transactions
// whose on-chain result disagrees with the stored state (e.g. failed on-chain
// but recorded as executed) are updated in the database.
func (l *ChainListener) reconcile(ctx context.Context) error {
	txns, err := l.repo.ListByStatus(ctx, models.TxStatusExecuted)
	if err != nil {
		return fmt.Errorf("listing executed transactions: %w", err)
	}

	if len(txns) == 0 {
		return nil
	}

	log.Printf("[chain-listener] reconciling %d executed transaction(s)", len(txns))

	for _, tx := range txns {
		// Skip transactions that were "executed" via the Phase 5 in-memory path
		// without a real on-chain submission; they have no TxHash to query.
		if tx.TxHash == "" {
			continue
		}

		if err := l.reconcileTransaction(ctx, tx); err != nil {
			// Log per-transaction errors without aborting the cycle; one bad
			// record must not prevent reconciliation of all others.
			log.Printf("[chain-listener] error reconciling tx=%s: %v", tx.ID, err)
		}
	}

	return nil
}

// reconcileTransaction verifies the on-chain status of a single transaction
// and updates the repository when the on-chain outcome differs from the stored state.
func (l *ChainListener) reconcileTransaction(ctx context.Context, tx *models.MultiSigTransaction) error {
	onChain, err := l.fetchHorizonTransaction(ctx, tx.TxHash)
	if err != nil {
		if isHorizonNotFound(err) {
			return l.handleNotFound(ctx, tx)
		}
		return fmt.Errorf("querying horizon for tx=%s hash=%s: %w", tx.ID, tx.TxHash, err)
	}

	if onChain.Successful {
		// On-chain confirmation matches DB state; nothing to do.
		log.Printf("[chain-listener] tx=%s confirmed (ledger=%d)", tx.ID, onChain.Ledger)
		return nil
	}

	// Transaction found on the ledger but marked as failed on-chain.
	reason := buildOnChainFailureReason(onChain)
	tx.Status = models.TxStatusFailed
	tx.FailureReason = reason
	tx.UpdatedAt = time.Now().UTC()

	if err := l.repo.Update(ctx, tx); err != nil {
		return fmt.Errorf("persisting on-chain failure for tx=%s: %w", tx.ID, err)
	}

	log.Printf("[chain-listener] tx=%s marked failed: %s", tx.ID, reason)
	return nil
}

// handleNotFound is called when a submitted transaction's hash cannot be
// located on the Stellar network.
//
// Transactions that are within the txConfirmationTimeout grace period are left
// in the executed state; they will be re-checked on the next cycle.  Once the
// grace period expires the transaction is declared permanently unconfirmed and
// marked failed so operators can take remediation action.
func (l *ChainListener) handleNotFound(ctx context.Context, tx *models.MultiSigTransaction) error {
	age := time.Since(tx.UpdatedAt)
	if age < txConfirmationTimeout {
		log.Printf("[chain-listener] tx=%s hash=%s not yet on-chain (age=%s); deferring",
			tx.ID, tx.TxHash, age.Round(time.Second))
		return nil
	}

	reason := fmt.Sprintf(
		"not confirmed on Stellar after %s (hash=%s)",
		txConfirmationTimeout, tx.TxHash,
	)
	tx.Status = models.TxStatusFailed
	tx.FailureReason = reason
	tx.UpdatedAt = time.Now().UTC()

	if err := l.repo.Update(ctx, tx); err != nil {
		return fmt.Errorf("persisting confirmation timeout for tx=%s: %w", tx.ID, err)
	}

	log.Printf("[chain-listener] tx=%s timed out waiting for on-chain confirmation", tx.ID)
	return nil
}

// ─── Horizon API client ───────────────────────────────────────────────────────

// fetchHorizonTransaction calls GET /transactions/{hash} on the configured
// Stellar Horizon API endpoint.
//
// Returns *horizonNotFoundError when Horizon responds with HTTP 404.
// Returns a plain error on all other non-200 responses and network failures.
func (l *ChainListener) fetchHorizonTransaction(ctx context.Context, hash string) (*horizonTransactionResponse, error) {
	endpoint := l.horizonURL + "/transactions/" + hash

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("building horizon request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := l.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("horizon HTTP request: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	if resp.StatusCode == http.StatusNotFound {
		return nil, &horizonNotFoundError{hash: hash}
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("horizon returned HTTP %d for hash %s", resp.StatusCode, hash)
	}

	var result horizonTransactionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding horizon response for hash %s: %w", hash, err)
	}

	return &result, nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// buildOnChainFailureReason produces a human-readable failure description from
// the Horizon response, preferring the structured result codes when available.
func buildOnChainFailureReason(r *horizonTransactionResponse) string {
	if r.Extras != nil && r.Extras.ResultCodes != nil {
		rc := r.Extras.ResultCodes
		if rc.Transaction != "" {
			s := "on-chain execution failed: " + rc.Transaction
			if len(rc.Operations) > 0 {
				s += " (ops: " + strings.Join(rc.Operations, ", ") + ")"
			}
			return s
		}
	}
	return fmt.Sprintf("on-chain execution failed (hash=%s)", r.Hash)
}

// nextBackoff computes the next exponential back-off duration.
//
// The progression is: 0 → minBackoff → 2×minBackoff → … → maxBackoff.
// It never exceeds maxBackoff to prevent indefinitely long quiet periods.
func nextBackoff(current time.Duration) time.Duration {
	if current <= 0 {
		return minBackoff
	}
	next := current * 2
	if next > maxBackoff {
		return maxBackoff
	}
	return next
}
