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
  /** Stellar-wrapped USDT handled by the Lumina bridge. */
  piUSDT: string;
}

// ─── Phase 13: Cross-Chain Deposit Types ──────────────────────────────────────

/** Supported external EVM-compatible chains for omnichain deposits. */
export type CrossChainID = "ETH" | "BSC" | "MATIC";

/** Supported external assets that can be bridged into the Lumina vault. */
export type CrossChainAsset = "ETH" | "BTC" | "USDT";

/**
 * Lifecycle states of a cross-chain deposit, mirroring the Go backend's
 * DepositStatus type.  The omnichain listener advances deposits through
 * these states automatically.
 */
export type CrossChainDepositStatus =
  | "pending"    // Address generated; awaiting inbound transfer
  | "detected"   // Transfer seen on external chain; accumulating confirmations
  | "confirmed"  // Reorg-safe confirmation depth reached
  | "minting"    // Soroban mint_wrapped transaction submitted to Pi Network
  | "minted"     // Wrapped asset credited to the user's vault
  | "failed"     // Non-retryable error; see failureReason
  | "expired";   // Address TTL elapsed without a deposit

/** Response returned by POST /deposit/address. */
export interface DepositAddressResponse {
  depositId: string;
  depositAddress: string;
  chain: CrossChainID;
  asset: CrossChainAsset;
  wrappedAsset: string;
  /** Unix timestamp (seconds) after which the address is decommissioned. */
  expiresAt: number;
  status: CrossChainDepositStatus;
  /**
   * The reorg-safe confirmation depth configured on the backend listener.
   * Derived from EVM_MIN_CONFIRMATIONS (default 12).  Display this value in
   * the UI instead of a hardcoded constant.
   */
  minConfirmations: number;
}

/** Response returned by GET /deposit/:id/status. */
export interface DepositStatusResponse {
  depositId: string;
  status: CrossChainDepositStatus;
  chain: CrossChainID;
  asset: CrossChainAsset;
  depositAddress: string;
  actualAmount?: string;
  confirmations?: number;
  externalTxHash?: string;
  sorobanTxHash?: string;
  failureReason?: string;
  updatedAt: number;
}

/** In-flight cross-chain deposit tracked in the Zustand store. */
export interface CrossChainDepositState {
  depositId: string;
  chain: CrossChainID;
  asset: CrossChainAsset;
  depositAddress: string;
  wrappedAsset: string;
  status: CrossChainDepositStatus;
  /** How many external-chain confirmations have been observed so far. */
  confirmations: number;
  /** The reorg-safe confirmation depth required by the backend listener. */
  minConfirmations: number;
  externalTxHash: string | null;
  sorobanTxHash: string | null;
  failureReason: string | null;
  updatedAt: string;
}
