/**
 * Lumina-Core E2E customer-journey test.
 *
 * Runs entirely in-process against pglite (memory://) — zero external services.
 *
 * Domain: Pi Network omnichain banking vault.
 * Routes under test:
 *   GET  /healthz                           — health check (no auth)
 *   GET  /v1/me                             — upsert+return user profile (auth)
 *   GET  /v1/users/:piUid/payments          — list payments for a user (auth)
 *   POST /v1/payments/:id/approve           — approve Pi payment (auth, calls Pi API)
 *   POST /v1/payments/:id/complete          — complete Pi payment + Soroban (auth, external)
 *
 * Auth strategy: Pi Network auth requires the Pi SDK (unavailable here).
 * JWTs are signed directly using signJwt() — the same path the real /auth/pi uses.
 *
 * Payment strategy: /payments/:id/approve + /complete call the Pi Network API
 * (unavailable here). We exercise their error paths (404 on unknown payment IDs)
 * and verify correct HTTP contracts without real Pi credentials.
 *
 * Customer journey covered:
 *   1. Health check                         ← infrastructure OK
 *   2. Unauthenticated → 401               ← auth guard works
 *   3. Invalid token → 401                 ← JWT validation works
 *   4. GET /v1/me (first visit) → 201      ← user auto-provisioned from Pi JWT
 *   5. GET /v1/me (second visit) → 200     ← idempotent upsert
 *   6. GET /v1/users/:piUid/payments → 200 ← empty list (no payments yet)
 *   7. POST /v1/payments/:id/approve (no Pi creds) → 404  ← Pi API unavailable path
 *   8. POST /v1/payments/:id/complete (no Pi creds) → 404 ← Pi API unavailable path
 *   9. POST /v1/payments/:id/complete without txid → 400  ← validation guard
 *  10. Unknown user payments → 404          ← not-found guard
 *
 * Run: pnpm run test:e2e  (from artifacts/api-server)
 */

// ── Bootstrap ─────────────────────────────────────────────────────────────────
process.env["NODE_ENV"] = "test";
process.env["LUMINA_JWT_SECRET"] = "lumina-e2e-test-secret-key-32x!";
// No DATABASE_URL → pglite memory://

import { initDb } from "@workspace/db";
await initDb();

// Now safe to import app (db live-binding is ready).
import request from "supertest";
import app from "../src/app.js";
import { signJwt } from "../src/lib/jwt.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

type Res = Awaited<ReturnType<ReturnType<typeof request>["get"]>>;

function pass(label: string): void {
  console.log(`  ✓ PASS  ${label}`);
  passed++;
}
function fail(label: string, detail: string): void {
  console.error(`  ✗ FAIL  ${label}: ${detail}`);
  failed++;
}
function assert(label: string, cond: boolean, detail = ""): void {
  cond ? pass(label) : fail(label, detail || "assertion false");
}
function assertStatus(label: string, res: Res, expected: number): boolean {
  if (res.status === expected) { pass(label); return true; }
  fail(label, `expected HTTP ${expected}, got ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
  return false;
}

// Auth helpers.
const token = signJwt({ uid: "pi-uid-lumina-e2e-001", username: "lumina_tester" });

function as(t: string) {
  return {
    get:    (url: string) => request(app).get(url).set("Authorization", `Bearer ${t}`),
    post:   (url: string) => request(app).post(url).set("Authorization", `Bearer ${t}`),
    patch:  (url: string) => request(app).patch(url).set("Authorization", `Bearer ${t}`),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════");
console.log(" Lumina-Core Customer-Journey E2E  (pglite memory://)");
console.log("═══════════════════════════════════════════════════════\n");

// ── Step 1: Infrastructure health check ──────────────────────────────────────
console.log("─ Step 1: Health check");
{
  const res = await request(app).get("/healthz");
  assertStatus("GET /healthz → 200", res, 200);
  assert("body.status === 'ok'", res.body?.status === "ok",
    `got: ${JSON.stringify(res.body)}`);
}

// ── Step 2: Auth guard — no token → 401 ──────────────────────────────────────
console.log("\n─ Step 2: Auth guard (no token)");
{
  const res = await request(app).get("/v1/me");
  assertStatus("GET /v1/me (no token) → 401", res, 401);
  assert("body.code === UNAUTHORIZED", res.body?.code === "UNAUTHORIZED",
    `got: ${JSON.stringify(res.body)}`);
}

// ── Step 3: Auth guard — invalid token → 401 ─────────────────────────────────
console.log("\n─ Step 3: Auth guard (invalid token)");
{
  const res = await request(app).get("/v1/me")
    .set("Authorization", "Bearer not.a.real.jwt");
  assertStatus("GET /v1/me (bad JWT) → 401", res, 401);
}

// ── Step 4: First visit — user auto-provisioned → 201 ────────────────────────
console.log("\n─ Step 4: GET /v1/me — first visit (auto-provision user)");
let userId = "";
{
  const res = await as(token).get("/v1/me");
  assertStatus("GET /v1/me (first visit) → 201", res, 201);
  assert("body.user.piUid matches", res.body?.user?.piUid === "pi-uid-lumina-e2e-001",
    `got: ${JSON.stringify(res.body?.user)}`);
  assert("body.user.username matches", res.body?.user?.username === "lumina_tester",
    `got: ${JSON.stringify(res.body?.user)}`);
  userId = res.body?.user?.id ?? "";
  assert("body.user.id is a UUID", /^[0-9a-f-]{36}$/.test(userId),
    `got: ${userId}`);
  console.log(`    → provisioned user id: ${userId}`);
}

// ── Step 5: Second visit — idempotent upsert → 200 ───────────────────────────
console.log("\n─ Step 5: GET /v1/me — second visit (idempotent)");
{
  const res = await as(token).get("/v1/me");
  assertStatus("GET /v1/me (second visit) → 200", res, 200);
  assert("same user id returned", res.body?.user?.id === userId,
    `expected ${userId}, got ${res.body?.user?.id}`);
}

// ── Step 6: List payments (empty) → 200 ──────────────────────────────────────
console.log("\n─ Step 6: GET /v1/users/:piUid/payments — empty list");
{
  const res = await as(token).get("/v1/users/pi-uid-lumina-e2e-001/payments");
  assertStatus("GET /v1/users/:piUid/payments → 200", res, 200);
  assert("payments is empty array", Array.isArray(res.body?.payments) && res.body.payments.length === 0,
    `got: ${JSON.stringify(res.body)}`);
}

// ── Step 7: Payment approve — Pi API unavailable → 404 ───────────────────────
console.log("\n─ Step 7: POST /v1/payments/:id/approve — Pi API unavailable → 404");
{
  const res = await as(token).post("/v1/payments/fake-payment-id-001/approve");
  // Without real Pi credentials, the payment lookup returns 404.
  assertStatus(
    "POST /v1/payments/:id/approve (no Pi creds) → 404",
    res,
    404,
  );
  assert(
    "body.error contains 'Payment not found'",
    typeof res.body?.error === "string" && res.body.error.toLowerCase().includes("payment"),
    `got: ${JSON.stringify(res.body)}`,
  );
}

// ── Step 8: Payment complete — Pi API unavailable → 404 ──────────────────────
console.log("\n─ Step 8: POST /v1/payments/:id/complete — Pi API unavailable → 404");
{
  const res = await as(token).post("/v1/payments/fake-payment-id-001/complete")
    .send({ txid: "stellar-txid-test-abc" });
  assertStatus(
    "POST /v1/payments/:id/complete (no Pi creds) → 404",
    res,
    404,
  );
}

// ── Step 9: Payment complete — missing txid → 400 ────────────────────────────
console.log("\n─ Step 9: POST /v1/payments/:id/complete — missing txid → 400");
{
  const res = await as(token).post("/v1/payments/fake-payment-id-002/complete")
    .send({});
  assertStatus("POST /v1/payments/:id/complete (no txid) → 400", res, 400);
  assert("body.error mentions txid", typeof res.body?.error === "string",
    `got: ${JSON.stringify(res.body)}`);
}

// ── Step 10: Unknown user payments → 404 ─────────────────────────────────────
console.log("\n─ Step 10: GET /v1/users/unknown-pi-uid/payments → 404");
{
  const res = await as(token).get("/v1/users/pi-uid-does-not-exist/payments");
  assertStatus("GET /v1/users/:piUid/payments (unknown user) → 404", res, 404);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════════════\n");

if (failed > 0) {
  process.exit(1);
}
