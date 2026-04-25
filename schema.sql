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
CREATE RULE handshake_no_update AS ON UPDATE TO handshake_history DO INSTEAD NOTHING;
CREATE RULE handshake_no_delete AS ON DELETE TO handshake_history DO INSTEAD NOTHING;

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
CREATE RULE sig_events_no_update AS ON UPDATE TO sig_events DO INSTEAD NOTHING;
CREATE RULE sig_events_no_delete AS ON DELETE TO sig_events DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS)
-- ---------------------------------------------------------------------------
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE handshake_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE vaults            ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_balances    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sig_events        ENABLE ROW LEVEL SECURITY;

-- Service role (backend) has full access; anon/authenticated roles are blocked
-- by default until explicit policies are added per-endpoint requirement.

-- users: backend service role only
CREATE POLICY users_service_all ON users
    USING (auth.role() = 'service_role');

-- handshake_history: backend service role only (append-only enforced by rules above)
CREATE POLICY handshake_service_all ON handshake_history
    USING (auth.role() = 'service_role');

-- vaults: service role full access; authenticated user can read their own vaults
CREATE POLICY vaults_service_all ON vaults
    USING (auth.role() = 'service_role');

-- vault_balances: service role full access
CREATE POLICY vault_balances_service_all ON vault_balances
    USING (auth.role() = 'service_role');

-- sig_events: service role full access (append-only enforced by rules above)
CREATE POLICY sig_events_service_all ON sig_events
    USING (auth.role() = 'service_role');
