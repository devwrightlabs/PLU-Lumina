import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { logger } from "./logger";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    logger.warn(
      {
        event: "unauthorized_request",
        reason: "missing_token",
        method: req.method,
        path: req.path,
        ip: req.ip,
      },
      "401 Unauthorized — missing Bearer token",
    );
    res.status(401).json({ error: "Missing authorization token", code: "UNAUTHORIZED" });
    return;
  }

  const token = auth.slice(7);
  const secret = process.env["LUMINA_JWT_SECRET"];
  if (!secret) {
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  try {
    jwt.verify(token, secret, { issuer: "lumina" });
    next();
  } catch (err) {
    const reason =
      err instanceof jwt.TokenExpiredError ? "token_expired"
      : err instanceof jwt.JsonWebTokenError ? "token_invalid"
      : "token_unknown";

    logger.warn(
      {
        event: "unauthorized_request",
        reason,
        method: req.method,
        path: req.path,
        ip: req.ip,
      },
      `401 Unauthorized — ${reason}`,
    );
    res.status(401).json({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
  }
}
