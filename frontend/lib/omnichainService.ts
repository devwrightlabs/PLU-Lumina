/**
 * omnichainService.ts — Phase 13 frontend service layer for the Lumina
 * Omnichain Relayer.
 *
 * Provides two typed async functions that bind the Next.js UI to the Go
 * backend's Phase 13 deposit endpoints:
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  requestDepositAddress(params)                                      │
 *  │  → POST /deposit/address                                            │
 *  │  ← { depositId, depositAddress, chain, asset, wrappedAsset, ... }  │
 *  │                                                                     │
 *  │  pollDepositStatus(depositId, jwt)                                  │
 *  │  → GET /deposit/:id/status                                          │
 *  │  ← { status, confirmations, sorobanTxHash, ... }                   │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 * Trustless execution guarantee: the backend derives the deposit address
 * deterministically from the master seed and the deposit ID, and the
 * omnichain listener verifies the on-chain transfer independently before
 * triggering the Soroban mint.  The frontend never controls fund routing —
 * it only presents the address to the user and tracks status.
 */

import type {
  CrossChainID,
  CrossChainAsset,
  DepositAddressResponse,
  DepositStatusResponse,
} from "@/types/lumina";

// ─── Request parameter types ──────────────────────────────────────────────────

export interface RequestDepositAddressParams {
  /** Target vault that receives the minted wrapped asset. */
  vaultId: string;
  /** External EVM chain the user is depositing from. */
  chain: CrossChainID;
  /** External asset the user intends to deposit. */
  asset: CrossChainAsset;
  /**
   * Optional: the amount the user intends to send (informational; the backend
   * verifies the actual on-chain amount independently).
   */
  expectedAmount?: string;
  /** Lumina JWT issued by the Pi handshake endpoint. */
  jwt: string;
}

// ─── Service errors ───────────────────────────────────────────────────────────

export class OmnichainServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OmnichainServiceError";
  }
}

// ─── requestDepositAddress ────────────────────────────────────────────────────

/**
 * Requests a unique, one-time EVM deposit address from the backend for the
 * given chain and asset.
 *
 * The returned address is valid for 24 hours.  Users must send funds to this
 * exact address; the omnichain listener monitors it and mints the wrapped
 * equivalent once the required confirmation depth is reached.
 *
 * @throws {OmnichainServiceError} on non-2xx HTTP responses or network errors.
 */
export async function requestDepositAddress(
  params: RequestDepositAddressParams,
): Promise<DepositAddressResponse> {
  const backendUrl = process.env.NEXT_PUBLIC_LUMINA_API_URL;
  if (!backendUrl) {
    throw new OmnichainServiceError(
      "NEXT_PUBLIC_LUMINA_API_URL is not set — check your environment configuration.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/deposit/address`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Lumina JWT authorizes the backend to act on the user's behalf;
        // the JWT sub claim is used to associate the deposit with the Pi UID.
        Authorization: `Bearer ${params.jwt}`,
      },
      body: JSON.stringify({
        vault_id: params.vaultId,
        chain: params.chain,
        asset: params.asset,
        expected_amount: params.expectedAmount ?? "",
      }),
    });
  } catch (err) {
    throw new OmnichainServiceError(
      `Network error requesting deposit address: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail += `: ${body.error}`;
    } catch {
      // Ignore JSON parse failures on error responses.
    }
    throw new OmnichainServiceError(
      `Failed to generate deposit address — ${detail}`,
      res.status,
    );
  }

  // The backend JSON response uses snake_case; map to camelCase for the UI.
  const raw = (await res.json()) as {
    deposit_id: string;
    deposit_address: string;
    chain: CrossChainID;
    asset: CrossChainAsset;
    wrapped_asset: string;
    expires_at: number;
    status: string;
    min_confirmations: number;
  };

  return {
    depositId: raw.deposit_id,
    depositAddress: raw.deposit_address,
    chain: raw.chain,
    asset: raw.asset,
    wrappedAsset: raw.wrapped_asset,
    expiresAt: raw.expires_at,
    status: raw.status as DepositAddressResponse["status"],
    minConfirmations: raw.min_confirmations,
  };
}

// ─── pollDepositStatus ────────────────────────────────────────────────────────

/**
 * Fetches the current lifecycle status of a cross-chain deposit.
 *
 * The UI should call this function on a polling interval (e.g. every 15 s)
 * after displaying the deposit address, stopping once status reaches
 * "minted", "failed", or "expired".
 *
 * @throws {OmnichainServiceError} on non-2xx HTTP responses or network errors.
 */
export async function pollDepositStatus(
  depositId: string,
  jwt: string,
): Promise<DepositStatusResponse> {
  const backendUrl = process.env.NEXT_PUBLIC_LUMINA_API_URL;
  if (!backendUrl) {
    throw new OmnichainServiceError(
      "NEXT_PUBLIC_LUMINA_API_URL is not set — check your environment configuration.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/deposit/${encodeURIComponent(depositId)}/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new OmnichainServiceError(
      `Network error polling deposit status: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail += `: ${body.error}`;
    } catch {
      // Ignore JSON parse failures on error responses.
    }
    throw new OmnichainServiceError(
      `Failed to fetch deposit status — ${detail}`,
      res.status,
    );
  }

  const raw = (await res.json()) as {
    deposit_id: string;
    status: string;
    chain: CrossChainID;
    asset: CrossChainAsset;
    deposit_address: string;
    actual_amount?: string;
    confirmations?: number;
    external_tx_hash?: string;
    soroban_tx_hash?: string;
    failure_reason?: string;
    updated_at: number;
  };

  return {
    depositId: raw.deposit_id,
    status: raw.status as DepositStatusResponse["status"],
    chain: raw.chain,
    asset: raw.asset,
    depositAddress: raw.deposit_address,
    actualAmount: raw.actual_amount,
    confirmations: raw.confirmations,
    externalTxHash: raw.external_tx_hash,
    sorobanTxHash: raw.soroban_tx_hash,
    failureReason: raw.failure_reason,
    updatedAt: raw.updated_at,
  };
}

// ─── isTerminalStatus ─────────────────────────────────────────────────────────

/**
 * Returns true when the deposit has reached a terminal state — either
 * successfully minted or an unrecoverable failure/expiry.  Callers should
 * stop polling once this returns true.
 */
export function isTerminalStatus(
  status: DepositStatusResponse["status"],
): boolean {
  return status === "minted" || status === "failed" || status === "expired";
}
