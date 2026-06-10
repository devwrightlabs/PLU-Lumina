import {
  Contract,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { logger } from "./logger";
import { NETWORK_CONFIG } from "./networkConfig";

export interface SorobanDepositParams {
  amountStroops: string;
  piTxId: string;
}

export interface SorobanDepositResult {
  sorobanTxHash: string | null;
  error: string | null;
}

export async function invokeSorobanDeposit(
  params: SorobanDepositParams,
): Promise<SorobanDepositResult> {
  const operatorSecret = process.env["PI_VAULT_OPERATOR_SECRET"];
  if (!operatorSecret) {
    logger.warn("PI_VAULT_OPERATOR_SECRET not set — skipping Soroban deposit call");
    return { sorobanTxHash: null, error: "Operator key not configured" };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(operatorSecret);
  } catch {
    logger.error("PI_VAULT_OPERATOR_SECRET is not a valid Stellar secret key");
    return { sorobanTxHash: null, error: "Invalid operator key" };
  }

  const {
    sorobanRpcUrl,
    networkPassphrase,
    vaultContract: contractAddress,
    vaultDepositFunction: functionName,
  } = NETWORK_CONFIG;

  const server = new rpc.Server(sorobanRpcUrl, { allowHttp: false });

  try {
    const account = await server.getAccount(keypair.publicKey());

    const contract = new Contract(contractAddress);

    const amountScVal = nativeToScVal(BigInt(params.amountStroops), { type: "i128" });
    const txIdScVal   = nativeToScVal(params.piTxId,                { type: "string" });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call(functionName, amountScVal, txIdScVal))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simResult)) {
      logger.warn(
        { error: simResult.error, contractAddress },
        "Soroban simulation failed",
      );
      return { sorobanTxHash: null, error: `Simulation error: ${simResult.error}` };
    }

    const preparedTx = rpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(keypair);

    const sendResult = await server.sendTransaction(preparedTx);

    if (sendResult.status === "ERROR") {
      logger.warn({ status: sendResult.status, contractAddress }, "Soroban send failed");
      return { sorobanTxHash: null, error: `Send error: ${sendResult.status}` };
    }

    const txHash = sendResult.hash;
    logger.info({ txHash, contractAddress }, "Soroban deposit submitted");

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 3_000));
      const getResult = await server.getTransaction(txHash);
      if (getResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        logger.info({ txHash }, "Soroban deposit confirmed");
        return { sorobanTxHash: txHash, error: null };
      }
      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        logger.warn({ txHash }, "Soroban deposit failed on-chain");
        return { sorobanTxHash: txHash, error: "Transaction failed on-chain" };
      }
    }

    logger.warn({ txHash }, "Soroban deposit confirmation timed out — still pending");
    return { sorobanTxHash: txHash, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, contractAddress }, "Soroban invocation error");
    return { sorobanTxHash: null, error: message };
  }
}
