/**
 * pi-sdk.d.ts — Ambient type declarations for the Pi Network Browser SDK.
 *
 * The Pi Network SDK is injected by the Pi Browser runtime as `window.Pi`.
 * These declarations mirror the official SDK v2.0 API surface and enable
 * strict TypeScript checking on all Pi SDK interactions without importing
 * a runtime module (the SDK is a browser global, not an npm package).
 *
 * See: https://github.com/pi-apps/pi-platform-docs
 */

export {};

declare global {
  interface Window {
    /** Pi Browser SDK — present only when running inside the Pi Browser WebView. */
    Pi: PiSDK;
  }

  // ─── SDK Instance ──────────────────────────────────────────────────────────

  interface PiSDK {
    /**
     * Initialize the SDK.  Must be called once before any other SDK method.
     * Sandbox mode routes payments through the Pi Testnet so no real π is spent.
     */
    init(config: PiInitConfig): void;

    /**
     * Trigger the Pi Browser's native authentication overlay.
     * Returns a resolved auth result containing the user identity and an
     * access token that must be verified server-side via the Pi Platform API.
     *
     * `onIncompletePaymentFound` is called when the user has a payment that
     * was started but never completed; the app must handle or cancel it before
     * creating a new payment.
     */
    authenticate(
      scopes: PiScope[],
      onIncompletePaymentFound: (payment: PiPaymentDTO) => void,
    ): Promise<PiAuthResult>;

    /**
     * Open the Pi Wallet payment overlay.
     * The payment lifecycle is driven entirely through the `callbacks` object;
     * the function itself returns void — all state changes are async.
     */
    createPayment(
      paymentData: PiPaymentData,
      callbacks: PiPaymentCallbacks,
    ): void;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  interface PiInitConfig {
    /** Pi SDK version string — use "2.0". */
    version: string;
    /**
     * When true, payments are routed to the Pi Testnet.
     * Must be `false` in production (Pi Mainnet).
     */
    sandbox?: boolean;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /**
   * OAuth-style permission scopes the app may request from the user.
   * - `username`       : read the user's Pi username and UID.
   * - `payments`       : initiate and track payment transactions.
   * - `wallet_address` : read the user's Stellar wallet address.
   */
  type PiScope = "username" | "payments" | "wallet_address";

  interface PiAuthResult {
    user: {
      uid: string;
      username: string;
    };
    /** Short-lived access token — verify via Pi Platform API on the backend. */
    accessToken: string;
  }

  // ─── Payments ─────────────────────────────────────────────────────────────

  interface PiPaymentData {
    /** Amount of π to transfer.  Must be a positive number. */
    amount: number;
    /** Human-readable memo displayed inside the Pi Wallet overlay. */
    memo: string;
    /**
     * Arbitrary developer-defined metadata echoed back on every server
     * callback.  Lumina uses this to bind payments to Soroban vault txIds.
     */
    metadata: Record<string, unknown>;
  }

  /** Full payment record returned by the Pi Platform on callback events. */
  interface PiPaymentDTO {
    identifier: string;
    user_uid: string;
    amount: number;
    memo: string;
    metadata: Record<string, unknown>;
    from_address: string;
    to_address: string;
    direction: "user_to_app" | "app_to_user";
    created_at: string;
    network: string;
    status: {
      developer_approved: boolean;
      transaction_verified: boolean;
      developer_completed: boolean;
      cancelled: boolean;
      user_cancelled: boolean;
    };
    transaction: {
      txid: string;
      verified: boolean;
      _link: string;
    } | null;
  }

  interface PiPaymentCallbacks {
    /**
     * Fired when the Pi Wallet overlay is ready for the developer to approve
     * the payment server-side.  Call POST /v1/payments/:id/approve before
     * returning to allow the payment to proceed.
     */
    onReadyForServerApproval: (paymentId: string) => void;

    /**
     * Fired after the Pi blockchain confirms the transaction.  Call
     * POST /v1/payments/:id/complete to finalise the payment and trigger
     * the Soroban vault deposit and Lumina Agent counter-signature.
     */
    onReadyForServerCompletion: (paymentId: string, txid: string) => void;

    /** Fired when the user cancels the payment in the Pi Wallet overlay. */
    onCancel: (paymentId: string) => void;

    /** Fired on any unrecoverable SDK or network error. */
    onError: (error: Error, payment?: PiPaymentDTO) => void;
  }
}
