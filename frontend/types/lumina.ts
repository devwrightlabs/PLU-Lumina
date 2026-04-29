/**
 * lumina.ts — Core domain types shared across the Lumina frontend.
 *
 * These types mirror the backend's Go structs and the Soroban contract's
 * data schemas, ensuring end-to-end type safety without code generation.
 */

// ─── Pi Network Session ───────────────────────────────────────────────────────

/** Status of the Pi SDK injection and wallet handshake. */
export type PiConnectionStatus =
  | "idle"        // No connection attempted yet
  | "connecting"  // Pi SDK initializing / Pi Browser handshake in progress
  | "connected"   // Active, authenticated Pi session
  | "error";      // Auth failed or SDK not available

export interface PiUser {
  uid: string;
  username: string;
}

export interface PiSession {
  status: PiConnectionStatus;
  user: PiUser | null;
  /** JWT issued by the Lumina-Core backend after Pi auth verification. */
  luminaJwt: string | null;
}

// ─── 2-of-2 Multi-Sig State ───────────────────────────────────────────────────

export type MultiSigTxStatus =
  | "pending_owner"   // Waiting for the vault owner's signature
  | "pending_agent"   // Owner signed; waiting for the Lumina Agent signature
  | "broadcasting"    // Both sigs collected; XDR envelope being submitted
  | "confirmed"       // On-chain confirmation received
  | "failed";         // Submission or validation failed

export interface MultiSigTransaction {
  txId: string;
  status: MultiSigTxStatus;
  /** ISO-8601 timestamp of the last status update. */
  updatedAt: string;
  /** Stellar XDR envelope, base64-encoded. Populated after owner signs. */
  xdrEnvelope: string | null;
}

// ─── Omnichain Asset Balances ─────────────────────────────────────────────────

/**
 * Tracks balances for every asset that Lumina manages.
 * Balances are stored as strings to preserve precision (Stellar uses int64
 * stroops; other chains may use arbitrary decimal places).
 */
export interface OmnichainBalances {
  /** Native Pi balance in π (string to avoid floating-point drift). */
  pi: string;
  /** Stellar-wrapped Bitcoin handled by the Lumina bridge. */
  piBTC: string;
  /** Stellar-wrapped Ethereum handled by the Lumina bridge. */
  piETH: string;
}
