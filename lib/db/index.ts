import { Pool } from "pg";

/**
 * Single shared connection pool.
 *
 * Cached on globalThis because Next's dev server re-evaluates modules on every
 * hot reload; without this you leak a pool per edit until Postgres refuses new
 * connections.
 */
const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool = globalForDb.pool ?? createPool();

function createPool(): Pool {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // An idle client whose server goes away (a Postgres restart, a failover)
  // emits "error" on the pool. With no listener that is an uncaughtException:
  // Next survives it, but logs the whole pg Client — user, host, database —
  // once per idle client, which reads like a crash. The pool has already
  // discarded the client; the next query simply opens a fresh one.
  p.on("error", (err) => {
    console.error(`db: idle client error (${err.message})`);
  });
  return p;
}

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export async function query<T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

/** Run a set of statements in one transaction, rolling back on any throw. */
export async function transaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
