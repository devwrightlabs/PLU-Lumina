import type {
  CrossChainID,
  CrossChainAsset,
  DepositAddressResponse,
  DepositStatusResponse,
} from "../types/lumina";

export interface RequestDepositAddressParams {
  vaultId: string;
  chain: CrossChainID;
  asset: CrossChainAsset;
  expectedAmount?: string;
  jwt: string;
}

export class OmnichainServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OmnichainServiceError";
  }
}

export async function requestDepositAddress(
  params: RequestDepositAddressParams,
): Promise<DepositAddressResponse> {
  const backendUrl = import.meta.env.VITE_LUMINA_API_URL;
  if (!backendUrl) {
    throw new OmnichainServiceError(
      "VITE_LUMINA_API_URL is not set — check your environment configuration.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/deposit/address`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
      // ignore
    }
    throw new OmnichainServiceError(
      `Failed to generate deposit address — ${detail}`,
      res.status,
    );
  }

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

export async function pollDepositStatus(
  depositId: string,
  jwt: string,
): Promise<DepositStatusResponse> {
  const backendUrl = import.meta.env.VITE_LUMINA_API_URL;
  if (!backendUrl) {
    throw new OmnichainServiceError(
      "VITE_LUMINA_API_URL is not set — check your environment configuration.",
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
      // ignore
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

export function isTerminalStatus(
  status: DepositStatusResponse["status"],
): boolean {
  return status === "minted" || status === "failed" || status === "expired";
}
