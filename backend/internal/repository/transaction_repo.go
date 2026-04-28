// Package repository provides the data-access layer for Lumina-Core.
// It follows the Repository Pattern: all database interactions are isolated
// behind interfaces so that the service layer is never coupled to a concrete
// storage technology.
package repository

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/devwrightlabs/plu-lumina/backend/internal/models"
)

// ─── Interface ────────────────────────────────────────────────────────────────

// TransactionRepository defines the contract that any persistence backend must
// fulfil.  The pgx implementation below satisfies this interface; future
// implementations (e.g. an in-memory mock for tests) need only satisfy the
// same method set.
type TransactionRepository interface {
	// Insert persists a newly created MultiSigTransaction.  Returns an error if
	// a record with the same ID already exists (conflicts are non-retryable).
	Insert(ctx context.Context, tx *models.MultiSigTransaction) error

	// Update overwrites the mutable columns of an existing transaction row
	// (status, owner_signature, agent_signature, tx_hash, failure_reason,
	// updated_at).  Returns ErrNotFound if txID is unknown.
	Update(ctx context.Context, tx *models.MultiSigTransaction) error

	// GetByID retrieves the transaction identified by txID.
	// Returns ErrNotFound if the record does not exist.
	GetByID(ctx context.Context, txID string) (*models.MultiSigTransaction, error)

	// ListByStatus returns all transactions currently in the given lifecycle
	// state, ordered by initiated_at ascending (oldest first).
	ListByStatus(ctx context.Context, status models.TxStatus) ([]*models.MultiSigTransaction, error)

	// Close tears down the underlying connection pool.  Must be called once
	// during graceful shutdown.
	Close()
}

// ErrNotFound is returned by GetByID / Update when the requested transaction
// does not exist in the database.
var ErrNotFound = errors.New("transaction not found")

// ─── pgx Implementation ───────────────────────────────────────────────────────

// pgxTransactionRepo is the production implementation backed by a pgxpool
// connection pool.  pgxpool is safe for concurrent use and handles automatic
// reconnection on transient connection drops.
type pgxTransactionRepo struct {
	pool *pgxpool.Pool
}

// NewPgxTransactionRepo constructs a pgxTransactionRepo connected to the
// Supabase/PostgreSQL instance whose URL is provided by the DATABASE_URL
// environment variable.
//
// The function blocks until an initial connection can be established (or the
// context is cancelled).  Use a context with a reasonable timeout to avoid
// indefinitely stalling startup:
//
//	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
//	defer cancel()
//	repo, err := repository.NewPgxTransactionRepo(ctx)
func NewPgxTransactionRepo(ctx context.Context) (TransactionRepository, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return nil, fmt.Errorf("DATABASE_URL environment variable is required")
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing DATABASE_URL: %w", err)
	}

	// Conservative pool settings suitable for a Supabase free-tier or
	// production PgBouncer connection; raise MaxConns in a dedicated instance.
	cfg.MaxConns = 10
	cfg.MinConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("creating pgx pool: %w", err)
	}

	// Ping to surface misconfigured credentials early.
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	log.Println("[db] connected to PostgreSQL (pgxpool)")
	return &pgxTransactionRepo{pool: pool}, nil
}

// Close drains and closes the underlying connection pool.
func (r *pgxTransactionRepo) Close() {
	r.pool.Close()
	log.Println("[db] pgxpool closed")
}

// ─── Insert ───────────────────────────────────────────────────────────────────

// Insert persists a new transaction row inside an explicit transaction so that
// a partial write (e.g. on a connection drop mid-statement) is fully rolled
// back.
func (r *pgxTransactionRepo) Insert(ctx context.Context, tx *models.MultiSigTransaction) error {
	const q = `
		INSERT INTO multisig_transactions
			(id, vault_id, owner_uid, tx_envelope_xdr, recipient, amount,
			 status, owner_signature, agent_signature, tx_hash,
			 failure_reason, initiated_at, updated_at)
		VALUES
			($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`

	dbtx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		if err != nil {
			if rbErr := dbtx.Rollback(ctx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
				log.Printf("[db] rollback error on Insert: %v", rbErr)
			}
		}
	}()

	_, err = dbtx.Exec(ctx, q,
		tx.ID,
		tx.VaultID,
		tx.OwnerUID,
		tx.TxEnvelopeXDR,
		tx.Recipient,
		tx.Amount,
		string(tx.Status),
		tx.OwnerSignature,
		tx.AgentSignature,
		tx.TxHash,
		tx.FailureReason,
		tx.InitiatedAt,
		tx.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert multisig_transactions: %w", err)
	}

	if err = dbtx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Insert: %w", err)
	}
	return nil
}

// ─── Update ───────────────────────────────────────────────────────────────────

// Update writes the mutable state columns for an existing transaction inside
// an explicit transaction.  Returns ErrNotFound if no row with the given ID
// exists.
func (r *pgxTransactionRepo) Update(ctx context.Context, tx *models.MultiSigTransaction) error {
	const q = `
		UPDATE multisig_transactions
		SET
			status          = $2,
			owner_signature = $3,
			agent_signature = $4,
			tx_hash         = $5,
			failure_reason  = $6,
			updated_at      = $7
		WHERE id = $1`

	dbtx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		if err != nil {
			if rbErr := dbtx.Rollback(ctx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
				log.Printf("[db] rollback error on Update: %v", rbErr)
			}
		}
	}()

	var tag pgconn.CommandTag
	tag, err = dbtx.Exec(ctx, q,
		tx.ID,
		string(tx.Status),
		tx.OwnerSignature,
		tx.AgentSignature,
		tx.TxHash,
		tx.FailureReason,
		tx.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("update multisig_transactions: %w", err)
	}
	if tag.RowsAffected() == 0 {
		err = ErrNotFound
		return err
	}

	if err = dbtx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Update: %w", err)
	}
	return nil
}

// ─── GetByID ──────────────────────────────────────────────────────────────────

// GetByID retrieves a single transaction by its primary-key ID.
// Returns ErrNotFound if no matching row exists.
func (r *pgxTransactionRepo) GetByID(ctx context.Context, txID string) (*models.MultiSigTransaction, error) {
	const q = `
		SELECT id, vault_id, owner_uid, tx_envelope_xdr, recipient, amount,
		       status, owner_signature, agent_signature, tx_hash,
		       failure_reason, initiated_at, updated_at
		FROM   multisig_transactions
		WHERE  id = $1`

	row := r.pool.QueryRow(ctx, q, txID)
	return scanRow(row)
}

// ─── ListByStatus ─────────────────────────────────────────────────────────────

// ListByStatus returns all transactions in the given state, oldest first.
// Returns an empty slice (not an error) when no rows match.
func (r *pgxTransactionRepo) ListByStatus(ctx context.Context, status models.TxStatus) ([]*models.MultiSigTransaction, error) {
	const q = `
		SELECT id, vault_id, owner_uid, tx_envelope_xdr, recipient, amount,
		       status, owner_signature, agent_signature, tx_hash,
		       failure_reason, initiated_at, updated_at
		FROM   multisig_transactions
		WHERE  status = $1
		ORDER  BY initiated_at ASC`

	rows, err := r.pool.Query(ctx, q, string(status))
	if err != nil {
		return nil, fmt.Errorf("query multisig_transactions by status: %w", err)
	}
	defer rows.Close()

	var results []*models.MultiSigTransaction
	for rows.Next() {
		tx, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		results = append(results, tx)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating multisig_transactions rows: %w", err)
	}
	return results, nil
}

// ─── Shared scan helper ───────────────────────────────────────────────────────

// scanner is the common subset of pgx.Row and pgx.Rows that exposes Scan.
type scanner interface {
	Scan(dest ...any) error
}

// scanRow maps a single database row into a MultiSigTransaction.  It is shared
// by GetByID (pgx.Row) and ListByStatus (pgx.Rows).
func scanRow(s scanner) (*models.MultiSigTransaction, error) {
	var (
		tx         models.MultiSigTransaction
		statusStr  string
		amountStr  string
	)

	err := s.Scan(
		&tx.ID,
		&tx.VaultID,
		&tx.OwnerUID,
		&tx.TxEnvelopeXDR,
		&tx.Recipient,
		&amountStr,
		&statusStr,
		&tx.OwnerSignature,
		&tx.AgentSignature,
		&tx.TxHash,
		&tx.FailureReason,
		&tx.InitiatedAt,
		&tx.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("scanning multisig_transactions row: %w", err)
	}

	tx.Status = models.TxStatus(statusStr)
	tx.Amount = amountStr
	return &tx, nil
}
