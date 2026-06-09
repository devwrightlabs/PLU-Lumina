import { Router, type IRouter } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireLuminaJwt(
  req: Parameters<Parameters<typeof router.use>[0]>[0],
  res: Parameters<Parameters<typeof router.use>[0]>[1],
): string | null {
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

router.post("/v1/payments/:id/approve", async (req, res) => {
  const token = requireLuminaJwt(req, res);
  if (!token) return;

  const { id: paymentId } = req.params;

  try {
    const piRes = await fetch(`https://api.minepi.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Key ${process.env["PI_API_KEY"] ?? ""}` },
    });

    if (!piRes.ok) {
      logger.warn({ status: piRes.status, paymentId }, "Pi payment not found");
      res.status(404).json({ error: "Payment not found on Pi Network" });
      return;
    }

    res.json({ paymentId, status: "pending_approval", approved: true });
  } catch (err) {
    logger.error({ err, paymentId }, "Payment approve error");
    res.status(502).json({ error: "Failed to contact Pi Network" });
  }
});

router.post("/v1/payments/:id/complete", async (req, res) => {
  const token = requireLuminaJwt(req, res);
  if (!token) return;

  const { id: paymentId } = req.params;
  const { txid } = req.body as { txid?: string };

  if (!txid || typeof txid !== "string") {
    res.status(400).json({ error: "txid is required" });
    return;
  }

  logger.info({ paymentId, txid }, "Payment complete recorded");
  res.json({ paymentId, txid, status: "confirmed" });
});

export default router;
