import { Router, type IRouter } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/v1/auth/pi", async (req, res) => {
  const { accessToken } = req.body as { accessToken?: string };

  if (!accessToken || typeof accessToken !== "string") {
    res.status(400).json({ error: "accessToken is required" });
    return;
  }

  try {
    const piRes = await fetch("https://api.minepi.com/v2/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!piRes.ok) {
      logger.warn({ status: piRes.status }, "Pi Network rejected access token");
      res.status(401).json({ error: "Pi Network could not verify the access token" });
      return;
    }

    const piUser = (await piRes.json()) as { uid: string; username: string };

    const secret = process.env["LUMINA_JWT_SECRET"];
    if (!secret) {
      logger.error("LUMINA_JWT_SECRET is not set");
      res.status(500).json({ error: "Server misconfiguration" });
      return;
    }

    const luminaJwt = jwt.sign(
      { uid: piUser.uid, username: piUser.username },
      secret,
      { expiresIn: "24h", issuer: "lumina" },
    );

    res.json({ jwt: luminaJwt, uid: piUser.uid, username: piUser.username });
  } catch (err) {
    logger.error({ err }, "Pi auth endpoint error");
    res.status(502).json({ error: "Failed to contact Pi Network" });
  }
});

export default router;
