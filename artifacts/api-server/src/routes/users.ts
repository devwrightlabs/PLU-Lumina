import { Router, type Request, type Response } from "express";
import { db, usersTable, paymentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyJwt } from "../lib/jwt";
import { logger } from "../lib/logger";

const router = Router();

/**
 * GET /v1/me
 * Returns the authenticated user's profile. Creates a local user record on
 * first visit (based on the Pi UID in the JWT), mirroring real Pi auth flow.
 */
router.get("/v1/me", async (req: Request, res: Response): Promise<void> => {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token", code: "UNAUTHORIZED" });
    return;
  }
  const token = auth.slice(7);

  let payload: { uid: string; username: string };
  try {
    payload = verifyJwt(token);
  } catch {
    res.status(401).json({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
    return;
  }

  try {
    // Upsert: find existing user by pi_uid or insert on first call.
    const existing = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.piUid, payload.uid))
      .limit(1);

    if (existing.length > 0) {
      res.json({ user: existing[0] });
      return;
    }

    const [created] = await db
      .insert(usersTable)
      .values({ piUid: payload.uid, username: payload.username })
      .returning();

    logger.info({ piUid: payload.uid, username: payload.username }, "New user record created");
    res.status(201).json({ user: created });
  } catch (err) {
    logger.error({ err }, "/v1/me DB error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /v1/users/:piUid/payments
 * Returns recent confirmed payments for a user (auth required).
 */
router.get("/v1/users/:piUid/payments", async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.piUid, req.params["piUid"] as string))
      .limit(1);

    if (user.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const payments = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.userId, user[0]!.id))
      .limit(20);

    res.json({ payments });
  } catch (err) {
    logger.error({ err }, "/v1/users/:piUid/payments DB error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
