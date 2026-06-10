import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  StrKey,
} from "@stellar/stellar-sdk";
import { LUMINA_CONTRACTS, PI_NETWORK_CONFIG } from "./contracts";

const PI_STROOPS_PER_PI = 1_000_000;

function getServer(): rpc.Server {
  return new rpc.Server(PI_NETWORK_CONFIG.sorobanRpcUrl, { allowHttp: false });
}

function isStellarAccountAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

export interface VaultBalanceResult {
  balanceStroops: bigint | null;
  error: string | null;
}

export interface DepositSimulationResult {
  success: boolean;
  minFee: string | null;
  error: string | null;
  skipped: boolean;
}

export async function readVaultBalance(
  userAddress: string,
): Promise<VaultBalanceResult> {
  if (!isStellarAccountAddress(userAddress)) {
    return { balanceStroops: null, error: "Not a valid Stellar account address" };
  }

  const server = getServer();

  try {
    const contract = new Contract(LUMINA_CONTRACTS.VAULT);

    const account = await server.getAccount(userAddress).catch(() => null);
    if (!account) {
      return { balanceStroops: null, error: "User account not found on Pi Network" };
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: PI_NETWORK_CONFIG.networkPassphrase,
    })
      .addOperation(
        contract.call("balance", nativeToScVal(userAddress, { type: "address" })),
      )
      .setTimeout(10)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simResult)) {
      return { balanceStroops: null, error: simResult.error };
    }

    const returnVal = (simResult as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) {
      return { balanceStroops: 0n, error: null };
    }

    const native = scValToNative(returnVal) as bigint;
    return { balanceStroops: native, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { balanceStroops: null, error: message };
  }
}

export async function simulateVaultDeposit(
  userAddress: string,
  amountPi: number,
  dummyTxId = "simulate",
): Promise<DepositSimulationResult> {
  if (!isStellarAccountAddress(userAddress)) {
    return { success: false, minFee: null, error: null, skipped: true };
  }

  const server = getServer();

  try {
    const account = await server.getAccount(userAddress).catch(() => null);
    if (!account) {
      return { success: false, minFee: null, error: "User account not found on Pi Network", skipped: false };
    }

    const contract = new Contract(LUMINA_CONTRACTS.VAULT);
    const amountStroops = BigInt(Math.round(amountPi * PI_STROOPS_PER_PI));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: PI_NETWORK_CONFIG.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "deposit",
          nativeToScVal(amountStroops, { type: "i128" }),
          nativeToScVal(dummyTxId,    { type: "string" }),
        ),
      )
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simResult)) {
      return { success: false, minFee: null, error: simResult.error, skipped: false };
    }

    const minFee = (simResult as rpc.Api.SimulateTransactionSuccessResponse).minResourceFee ?? null;
    return { success: true, minFee: minFee ?? null, error: null, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, minFee: null, error: message, skipped: false };
  }
}

export function stroopsToPi(stroops: bigint): string {
  const pi = Number(stroops) / PI_STROOPS_PER_PI;
  return pi.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
