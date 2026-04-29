-- =============================================================================
-- Lumina-Core: Supabase PostgreSQL Schema
-- Protocol 23 compliant · Zero-Trust · Immutable audit trail
-- =============================================================================
-- All tables use Row-Level Security (RLS).  Policies are defined below.
-- Timestamps are always stored as UTC.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), crypt()
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";  -- query telemetry

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

CREATE TYPE handshake_status AS ENUM (
    'initiated',   -- Pi browser sent the /auth/pi-handshake request
    'verified',    -- Pi Platform confirmed the access token
    'failed',      -- Verification failed (bad token, uid mismatch, etc.)
    'expired'      -- JWT issued but subsequently expired without vault creation
);

CREATE TYPE vault_status AS ENUM (
    'active',      -- Vault is operational
    'locked',      -- Temporarily locked (e.g., suspicious activity)
    'closed'       -- Permanently closed; no further operations permitted
);

CREATE TYPE sig_event_type AS ENUM (
    'proposal_created',   -- Owner submitted a release proposal
    'agent_signed',       -- Lumina Agent countersigned
    'executed',           -- Release executed on-chain
    'cancelled'           -- Owner cancelled the proposal
);

-- ---------------------------------------------------------------------------
-- Table: users
-- Stores the minimal Pi Network identity record for each authenticated user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    pi_uid          TEXT          NOT NULL UNIQUE,          -- Pi Network UID
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  users              IS 'Pi Network identities authenticated by Lumina-Core.';
COMMENT ON COLUMN users.pi_uid       IS 'Immutable Pi Network user identifier.';

-- ---------------------------------------------------------------------------
-- Table: handshake_history
-- Immutable log of every /auth/pi-handshake attempt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handshake_history (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            REFERENCES users(id) ON DELETE SET NULL,
    pi_uid          TEXT            NOT NULL,
    status          handshake_status NOT NULL,
    ip_address      INET,                                    -- anonymised if required by policy
    user_agent      TEXT,
    jwt_issued_at   TIMESTAMPTZ,
    jwt_expires_at  TIMESTAMPTZ,
    failure_reason  TEXT,                                    -- populated only when status = 'failed'
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

COMMENT ON TABLE handshake_history IS 'Immutable audit log of Pi Network authentication handshakes.';

CREATE INDEX idx_handshake_pi_uid    ON handshake_history (pi_uid);
CREATE INDEX idx_handshake_status    ON handshake_history (status);
CREATE INDEX idx_handshake_created   ON handshake_history (created_at DESC);

-- Prevent any UPDATE or DELETE on this table — records are append-only.
CREATE OR REPLACE FUNCTION prevent_handshake_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'handshake_history is append-only; % is not allowed', TG_OP;
END;
$$;

DROP RULE IF EXISTS handshake_no_update ON handshake_history;
DROP RULE IF EXISTS handshake_no_delete ON handshake_history;
DROP TRIGGER IF EXISTS handshake_history_immutable ON handshake_history;

CREATE TRIGGER handshake_history_immutable
BEFORE UPDATE OR DELETE ON handshake_history
FOR EACH ROW
EXECUTE FUNCTION prevent_handshake_history_mutation();
-- ---------------------------------------------------------------------------
-- Table: vaults
-- Tracks each Sub-Wallet vault provisioned via /vault/create.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vaults (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id            TEXT          NOT NULL UNIQUE,       -- deterministic hex digest (SHA-256²)
    user_id             UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    owner_public_key    TEXT          NOT NULL,              -- Ed25519 public key, hex-encoded
    agent_public_key    TEXT          NOT NULL,              -- Lumina Agent Ed25519 public key
    status              vault_status  NOT NULL DEFAULT 'active',
    soroban_contract_id TEXT,                                -- Soroban contract address once deployed
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  vaults                    IS 'Sub-Wallet multi-sig vaults managed by Lumina-Core.';
COMMENT ON COLUMN vaults.vault_id           IS 'SHA-256² of (''lumina-vault-v1:'' || uid || '':'' || owner_public_key); hex-encoded.';
COMMENT ON COLUMN vaults.soroban_contract_id IS 'Populated once the Soroban MultiSigVault contract is deployed on-chain.';

CREATE INDEX idx_vaults_user_id  ON vaults (user_id);
CREATE INDEX idx_vaults_status   ON vaults (status);

-- Auto-update updated_at on every row modification.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER vaults_updated_at
BEFORE UPDATE ON vaults
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Table: vault_balances
-- Tracks the current on-chain balance snapshot for each vault token.
-- Balances are updated by the backend after each confirmed on-chain event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_balances (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id        UUID          NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    token_address   TEXT          NOT NULL,                  -- Stellar token contract address
    balance         NUMERIC(38,7) NOT NULL DEFAULT 0,
    last_synced_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (vault_id, token_address)
);

COMMENT ON TABLE  vault_balances               IS 'On-chain balance snapshot per vault per token.';
COMMENT ON COLUMN vault_balances.balance       IS 'Stored with 7 decimal places (Stellar stroops precision).';
COMMENT ON COLUMN vault_balances.last_synced_at IS 'Timestamp of the last Horizon/Soroban sync.';

CREATE INDEX idx_vault_balances_vault ON vault_balances (vault_id);

-- ---------------------------------------------------------------------------
-- Table: sig_events
-- Immutable record of every signature event for on-chain operations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sig_events (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id        UUID            NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
    tx_id           TEXT            NOT NULL,                -- proposal tx_id (32-byte hex)
    event_type      sig_event_type  NOT NULL,
    actor_address   TEXT            NOT NULL,                -- Stellar address of the signer/executor
    tx_envelope_xdr TEXT,                                    -- base64 XDR, stored for audit purposes
    tx_hash         TEXT,                                    -- Stellar transaction hash (post-execution)
    amount          NUMERIC(38,7),                           -- release amount, if applicable
    recipient       TEXT,                                    -- recipient Stellar address, if applicable
    error_message   TEXT,                                    -- populated on failed submission
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

COMMENT ON TABLE  sig_events              IS 'Immutable audit trail of every multi-sig event.';
COMMENT ON COLUMN sig_events.tx_id        IS 'Matches the tx_id used in the Soroban proposal.';
COMMENT ON COLUMN sig_events.tx_hash      IS 'Populated by the backend once the Stellar transaction is confirmed.';

CREATE INDEX idx_sig_events_vault   ON sig_events (vault_id);
CREATE INDEX idx_sig_events_tx_id   ON sig_events (tx_id);
CREATE INDEX idx_sig_events_type    ON sig_events (event_type);
CREATE INDEX idx_sig_events_created ON sig_events (created_at DESC);

-- Prevent UPDATE/DELETE — sig_events is append-only.
-- Use a trigger that raises an exception so forbidden mutations cannot
-- appear to succeed silently.
CREATE OR REPLACE FUNCTION reject_sig_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'sig_events is immutable; % is not allowed', TG_OP;
END;
$$;

DROP RULE IF EXISTS sig_events_no_update ON sig_events;
DROP RULE IF EXISTS sig_events_no_delete ON sig_events;

DROP TRIGGER IF EXISTS sig_events_reject_mutation ON sig_events;
CREATE TRIGGER sig_events_reject_mutation
BEFORE UPDATE OR DELETE ON sig_events
FOR EACH ROW
EXECUTE FUNCTION reject_sig_events_mutation();
-- ---------------------------------------------------------------------------
-- Table: multisig_transactions
-- Mutable lifecycle record for each 2-of-2 multi-sig transaction.
-- One row per transaction; status and signature columns are updated as the
-- transaction advances through its state machine.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS multisig_transactions (
    id              TEXT          PRIMARY KEY,                   -- double-SHA-256 hex digest
    vault_id        TEXT          NOT NULL,                      -- logical vault ID (hex digest)
    owner_uid       TEXT          NOT NULL,                      -- Pi Network UID
    tx_envelope_xdr TEXT          NOT NULL,                      -- base64 Stellar XDR envelope
    recipient       TEXT          NOT NULL,                      -- destination Stellar address
    amount          NUMERIC(38,7) NOT NULL,                      -- release amount (7 dp precision)
    status          TEXT          NOT NULL,                      -- TxStatus lifecycle state
    owner_signature TEXT          NOT NULL DEFAULT '',           -- hex-encoded Ed25519 owner sig
    agent_signature TEXT          NOT NULL DEFAULT '',           -- hex-encoded Ed25519 agent sig
    tx_hash         TEXT          NOT NULL DEFAULT '',           -- Stellar transaction hash
    failure_reason  TEXT          NOT NULL DEFAULT '',           -- populated on failure
    initiated_at    TIMESTAMPTZ   NOT NULL,
    updated_at      TIMESTAMPTZ   NOT NULL
);

COMMENT ON TABLE  multisig_transactions               IS '2-of-2 multi-sig transaction lifecycle records for Lumina-Core.';
COMMENT ON COLUMN multisig_transactions.vault_id      IS 'Logical vault identifier; references vaults.vault_id (not FK to avoid schema coupling at bootstrap).';
COMMENT ON COLUMN multisig_transactions.status        IS 'One of: pending_owner_sig, pending_agent_sig, ready_to_execute, executed, failed, cancelled.';
COMMENT ON COLUMN multisig_transactions.owner_signature IS 'Hex-encoded Ed25519 signature produced by the vault owner.';
COMMENT ON COLUMN multisig_transactions.agent_signature IS 'Hex-encoded Ed25519 counter-signature produced by the Lumina Agent.';

CREATE INDEX idx_multisig_tx_status     ON multisig_transactions (status);
CREATE INDEX idx_multisig_tx_vault_id   ON multisig_transactions (vault_id);
CREATE INDEX idx_multisig_tx_owner_uid  ON multisig_transactions (owner_uid);
CREATE INDEX idx_multisig_tx_initiated  ON multisig_transactions (initiated_at DESC);

-- Auto-update updated_at on every mutation (re-uses the set_updated_at function
-- defined above for the vaults table).
CREATE TRIGGER multisig_transactions_updated_at
BEFORE UPDATE ON multisig_transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS)
-- ---------------------------------------------------------------------------
ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE handshake_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vaults                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_balances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sig_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE multisig_transactions   ENABLE ROW LEVEL SECURITY;

-- Service role (backend) has full access; anon/authenticated roles are blocked
-- by default until explicit policies are added per-endpoint requirement.

-- users: backend service role only
CREATE POLICY users_service_all ON users
    USING (auth.role() = 'service_role');

-- handshake_history: backend service role only (append-only enforced by rules above)
CREATE POLICY handshake_service_all ON handshake_history
    USING (auth.role() = 'service_role');

-- vaults: service role full access
CREATE POLICY vaults_service_all ON vaults
    USING (auth.role() = 'service_role');

-- vault_balances: service role full access
CREATE POLICY vault_balances_service_all ON vault_balances
    USING (auth.role() = 'service_role');

-- sig_events: service role full access (append-only enforced by rules above)
CREATE POLICY sig_events_service_all ON sig_events
    USING (auth.role() = 'service_role');

-- multisig_transactions: backend service role only
CREATE POLICY multisig_tx_service_all ON multisig_transactions
    USING (auth.role() = 'service_role');

-- =============================================================================
-- Phase 13: Omnichain Relayer — Cross-Chain Deposit Tracking
-- =============================================================================
-- crosschain_deposits tracks every external-asset deposit from address
-- generation through EVM confirmation to Soroban vault minting.
--
-- The in-memory DepositStore used in Go (services/deposit_store.go) is the
-- primary runtime store for Phase 13; this table is the production-grade
-- persistent backend that replaces it in a full deployment.
-- =============================================================================

CREATE TYPE deposit_status AS ENUM (
    'pending',    -- Address generated; awaiting inbound EVM transfer
    'detected',   -- Transfer seen; accumulating reorg-safe confirmations
    'confirmed',  -- Confirmation threshold reached; safe to mint
    'minting',    -- Soroban mint_wrapped transaction submitted
    'minted',     -- Wrapped asset credited to the vault
    'failed',     -- Non-retryable error; see failure_reason
    'expired'     -- Address TTL elapsed without a deposit
);

CREATE TABLE IF NOT EXISTS crosschain_deposits (
    id                TEXT            NOT NULL,
    vault_id          TEXT            NOT NULL,
    owner_uid         TEXT            NOT NULL,
    chain             TEXT            NOT NULL,  -- e.g. 'ETH', 'BSC', 'MATIC'
    asset             TEXT            NOT NULL,  -- e.g. 'USDT', 'ETH', 'BTC'
    deposit_address   TEXT            NOT NULL,
    contract_address  TEXT            NOT NULL DEFAULT '',
    expected_amount   TEXT            NOT NULL DEFAULT '',
    actual_amount     TEXT            NOT NULL DEFAULT '',
    external_tx_hash  TEXT            NOT NULL DEFAULT '',
    detected_block    BIGINT          NOT NULL DEFAULT 0,
    confirmations     INTEGER         NOT NULL DEFAULT 0,
    status            deposit_status  NOT NULL DEFAULT 'pending',
    soroban_tx_hash   TEXT            NOT NULL DEFAULT '',
    failure_reason    TEXT            NOT NULL DEFAULT '',
    expires_at        TIMESTAMPTZ     NOT NULL,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT crosschain_deposits_pkey PRIMARY KEY (id)
);

-- Index on status for fast listener queries (pending + detected).
CREATE INDEX IF NOT EXISTS idx_crosschain_deposits_status
    ON crosschain_deposits (status)
    WHERE status IN ('pending', 'detected');

-- Index on vault_id for user-facing deposit history queries.
CREATE INDEX IF NOT EXISTS idx_crosschain_deposits_vault
    ON crosschain_deposits (vault_id);

-- Index on deposit_address for O(1) lookups during listener reconciliation.
CREATE INDEX IF NOT EXISTS idx_crosschain_deposits_address
    ON crosschain_deposits (deposit_address);

-- Row-Level Security.
ALTER TABLE crosschain_deposits ENABLE ROW LEVEL SECURITY;

-- crosschain_deposits: backend service role only.
CREATE POLICY crosschain_deposits_service_all ON crosschain_deposits
    USING (auth.role() = 'service_role');
