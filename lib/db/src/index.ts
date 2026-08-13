/**
 * db.ts — driver-switched database module (mirrors the Pibazaar/BazaarWork pattern).
 *
 * When DATABASE_URL starts with postgres(ql):// → real pg pool (production).
 * Otherwise → in-process PGlite (dev / test). No top-level side effects that
 * throw; call initDb() once before any route handler accesses `db` or `pool`.
 *
 * ESM live-binding semantics: callers that do `import { db } from '@workspace/db'`
 * will always read the current value because we export `db` and `pool` as
 * reassignable `let` bindings.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

const _url = process.env.DATABASE_URL ?? "";
export const dbKind: "pg" | "pglite" = /^postgres(ql)?:\/\//i.test(_url)
  ? "pg"
  : "pglite";

// Sentinel values — replaced by initDb() before any route runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- sentinel; replaced before use
export let db: NodePgDatabase<typeof schema> = null as any;
export let pool: Pool | null = null;

/** Call once at startup, before any route touches `db` or `pool`. */
export async function initDb(): Promise<void> {
  if (dbKind === "pg") {
    const { default: pg } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const p = new pg.Pool({ connectionString: _url });
    pool = p;
    db = drizzle(p, { schema }) as NodePgDatabase<typeof schema>;
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");

    let dataDir: string;
    if (_url.startsWith("pglite://")) {
      dataDir = _url.slice("pglite://".length) || "memory://";
    } else if (_url.startsWith("file:")) {
      dataDir = _url.slice("file:".length) || ".data/pglite";
    } else if (process.env.NODE_ENV === "test") {
      dataDir = "memory://";
    } else {
      dataDir = ".data/pglite";
    }

    if (!dataDir.startsWith("memory://")) {
      await mkdir(dataDir, { recursive: true });
    }

    const client = new PGlite(dataDir);
    pool = null;
    // Cast: PgliteDatabase satisfies NodePgDatabase for our Drizzle queries.
    db = drizzle(client, {
      schema,
    }) as unknown as NodePgDatabase<typeof schema>;
    await ensureSchema();
  }
}

/**
 * Run SQL migration files from the `../drizzle/` folder (pglite only).
 * Production applies migrations externally via drizzle-kit push.
 */
export async function ensureSchema(): Promise<void> {
  if (dbKind !== "pglite") return;

  const __dir = dirname(fileURLToPath(import.meta.url));
  // __dir = …/lib/db/src/  →  ../drizzle = …/lib/db/drizzle/
  const migrationsDir = join(__dir, "..", "drizzle");

  let files: string[];
  try {
    const all = await readdir(migrationsDir);
    files = all.filter((f) => f.endsWith(".sql")).sort();
  } catch {
    console.warn("[db] No ./drizzle directory found; skipping schema bootstrap.");
    return;
  }

  for (const file of files) {
    const raw = await readFile(join(migrationsDir, file), "utf8");
    const statements = raw.split("--> statement-breakpoint");
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        await db.execute(sql.raw(trimmed));
      } catch (err) {
        const msg = String(err);
        const causeMsg =
          err instanceof Error && err.cause ? String(err.cause) : "";
        // Ignore "already exists" / "duplicate" errors on repeated schema runs.
        if (
          /already exists|duplicate/i.test(msg) ||
          /already exists|duplicate/i.test(causeMsg)
        )
          continue;
        throw err;
      }
    }
  }
  console.log("[db] Schema ensured via pglite migration.");
}

export * from "./schema";
