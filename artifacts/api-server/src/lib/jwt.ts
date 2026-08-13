import jwt from "jsonwebtoken";

export interface LuminaJwtPayload {
  uid: string;
  username: string;
}

/** Sign a Lumina JWT with the configured secret. Mirrors the /auth/pi sign path. */
export function signJwt(payload: LuminaJwtPayload): string {
  const secret = process.env["LUMINA_JWT_SECRET"];
  if (!secret) throw new Error("LUMINA_JWT_SECRET is not set");
  return jwt.sign(payload, secret, { expiresIn: "24h", issuer: "lumina" });
}

/** Verify and decode a Lumina JWT. Returns the payload or throws on failure. */
export function verifyJwt(token: string): LuminaJwtPayload {
  const secret = process.env["LUMINA_JWT_SECRET"];
  if (!secret) throw new Error("LUMINA_JWT_SECRET is not set");
  return jwt.verify(token, secret, { issuer: "lumina" }) as LuminaJwtPayload;
}
