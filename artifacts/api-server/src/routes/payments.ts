import { Router } from "express";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";
import { invokeSorobanDeposit } from "../lib/sorobanClient";
import { NETWORK_CONFIG } from "../lib/networkConfig";

const router = Router();

const PI_STROOPS_PER_PI = 1_000_000;

interface CompletedPayment {
  txid: string;
  contractAddress: string;
  sorobanTxHash: string | null;
  sorobanError: string | null;
}

const completedPayments = new Map<string, CompletedPayment>();

interface PiPaymentResponse {
  identifier: string;
  user_uid: string;
  amount: number;
  memo: string;
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

async function fetchPiPayment(paymentId: string): Promise<PiPaymentResponse | null> {
  try {
    const res = await fetch(`https://api.minepi.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Key ${process.env["PI_API_KEY"] ?? ""}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as PiPaymentResponse;
  } catch {
    return null;
  }
}

function requireLuminaJwt(req: Request, res: Response): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Lumina JWT" });
    return null;
  }

  const token = auth.slice(7);
  const secret = process.env["LUMINA_JWT_SECRET"];
  if (!secret) {
    res.status(500).json({ error: "Server misconfiguration" });
    return null;
  }

  try {
    jwt.verify(token, secret, { issuer: "lumina" });
    return token;
  } catch {
    res.status(401).json({ error: "Invalid or expired Lumina JWT" });
    return null;
  }
}

router.post("/v1/payments/:id/approve", async (req: Request, res: Response) => {
  const token = requireLuminaJwt(req, res);
  if (!token) return;

  const paymentId = req.params["id"] as string;

  const payment = await fetchPiPayment(paymentId);
  if (!payment) {
    logger.warn({ paymentId }, "Pi payment not found or API error on approve");
    res.status(404).json({ error: "Payment not found on Pi Network" });
    return;
  }

  logger.info({ paymentId, amount: payment.amount }, "Payment approved");
  res.json({ paymentId, status: "pending_approval", approved: true });
});

router.post("/v1/payments/:id/complete", async (req: Request, res: Response) => {
  const token = requireLuminaJwt(req, res);
  if (!token) return;

  const paymentId = req.params["id"] as string;
  const { txid: clientTxid } = req.body as { txid?: string };

  if (!clientTxid || typeof clientTxid !== "string") {
    res.status(400).json({ error: "txid is required" });
    return;
  }

  const cached = completedPayments.get(paymentId);
  if (cached?.sorobanTxHash) {
    logger.info({ paymentId }, "Duplicate /complete — Soroban already confirmed, returning cached result");
    res.json({
      paymentId,
      txid: cached.txid,
      contractAddress: cached.contractAddress,
      sorobanTxHash: cached.sorobanTxHash,
      sorobanError: null,
      status: "confirmed",
    });
    return;
  }

  if (cached?.sorobanError) {
    logger.info({ paymentId, sorobanError: cached.sorobanError },
      "Duplicate /complete — prior Soroban call failed, retrying");
  }

  const payment = await fetchPiPayment(paymentId);
  if (!payment) {
    logger.warn({ paymentId }, "Pi payment not found during /complete");
    res.status(404).json({ error: "Payment not found on Pi Network" });
    return;
  }

  if (!payment.status.transaction_verified) {
    logger.warn({ paymentId }, "Transaction not yet verified by Pi Network");
    res.status(422).json({ error: "Transaction not yet verified on Pi Network" });
    return;
  }

  if (!payment.transaction || !payment.transaction.txid) {
    logger.warn({ paymentId }, "Payment has no on-chain transaction record");
    res.status(422).json({ error: "No on-chain transaction found for this payment" });
    return;
  }

  const verifiedTxid = payment.transaction.txid;

  if (verifiedTxid !== clientTxid) {
    logger.warn({ paymentId, verifiedTxid, clientTxid }, "txid mismatch — rejecting");
    res.status(422).json({ error: "txid does not match Pi Network record" });
    return;
  }

  const amountStroops = String(Math.round(payment.amount * PI_STROOPS_PER_PI));
  const contractAddress = NETWORK_CONFIG.vaultContract;

  logger.info({ paymentId, verifiedTxid, amountStroops, contractAddress },
    "Payment verified — invoking Soroban vault");

  const { sorobanTxHash, error: sorobanError } = await invokeSorobanDeposit({
    amountStroops,
    piTxId: verifiedTxid,
  });

  completedPayments.set(paymentId, {
    txid: verifiedTxid,
    contractAddress,
    sorobanTxHash,
    sorobanError,
  });

  if (sorobanError) {
    logger.warn({ paymentId, verifiedTxid, sorobanError },
      "Soroban deposit failed (Pi payment still confirmed; client may retry)");
  } else {
    logger.info({ paymentId, verifiedTxid, sorobanTxHash, contractAddress },
      "Soroban deposit recorded on-chain");
  }

  res.json({
    paymentId,
    txid: verifiedTxid,
    contractAddress,
    sorobanTxHash,
    sorobanError,
    status: "confirmed",
  });
});

export default router;
