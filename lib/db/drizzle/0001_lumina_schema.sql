-- Lumina-Core schema — used by ensureSchema() for pglite (dev/test).
-- Production uses drizzle-kit push. This file must be idempotent (CREATE IF NOT EXISTS).

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'approved', 'confirmed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "users" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pi_uid"          text UNIQUE,
  "username"        text NOT NULL UNIQUE,
  "wallet_address"  text,
  "is_verified"     boolean NOT NULL DEFAULT false,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payments" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pi_payment_id"    text NOT NULL UNIQUE,
  "user_id"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "amount_pi"        numeric(18,7) NOT NULL,
  "memo"             text NOT NULL DEFAULT '',
  "status"           payment_status NOT NULL DEFAULT 'pending',
  "pi_txid"          text,
  "soroban_tx_hash"  text,
  "soroban_error"    text,
  "contract_address" text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "payments_user_idx"   ON "payments" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" ("status");
