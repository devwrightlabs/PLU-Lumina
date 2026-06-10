import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
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
  } catch {
    res.status(401).json({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
  }
}
