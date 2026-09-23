/**
 * A throwaway, freshly migrated database for each test file that needs one.
 *
 * Running the database tests needs only a server and a role that may create
 * databases — no schema, no migrations, nothing seeded:
 *
 *   docker run -d --name nn-test -p 55432:5432 \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_USER=ninetynine postgres:17-alpine
 *   # the image runs a TEMPORARY server during init and then restarts, so
 *   # pg_isready can pass before the real one exists. Poll the PUBLISHED port,
 *   # which the init-phase server never binds.
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55432/postgres npm test
 *
 * In a file:
 *
 *   const db = await createTestDatabase("deck");
 *   pool = new pg.Pool({ connectionString: db.url, max: 4 });
 *   ...
 *   await pool.end();
 *   await db.drop();
 *
 * Why this exists: every database-backed file used to share the one database
 * TEST_DATABASE_URL names, and seeded the same fixture ids into the same
 * tables. Run in parallel they deleted each other's rows mid-assertion; run
 * serially they still handed each other their leftovers, so each file had to
 * remember to scrub every row it wrote — including the ones in
 * `scryfall_cards`, `card_price_history` and `verification_token` that hang off
 * no user and so reach no cascade. Three files were fixed for forgetting, and
 * the failure each time was a DIFFERENT file going red on the next run. With a
 * database per file there is nothing to leak into: whatever a file writes goes
 * away with its database, whether or not its author thought about it. It is
 * also why the `test` script no longer passes --test-concurrency=1, which
 * existed only to keep those files from racing on the one database.
 *
 * The isolation is per FILE, not per test. Tests inside one file still share
 * its database and run in order, so a test that needs a table empty of its
 * neighbours' rows still arranges that itself (scryfall.test.ts clearing
 * card_price_history is the example).
 *
 * TEST_DATABASE_URL is now only the maintenance connection used to CREATE and
 * DROP these databases; no test writes to the database it names (health.test.ts
 * runs `SELECT 1` against it, and nothing else touches it). Its role
 * therefore needs CREATEDB (initdb's superuser and the postgres image's
 * POSTGRES_USER both have it). It is still the only opt-in: unset, every
 * database test skips, and DATABASE_URL is never consulted, so the suite cannot
 * reach a real instance by inheriting the app's environment.
 *
 * The schema comes from running the real migrations, through the real runner,
 * not from a hand-maintained test schema — a test schema is one more thing that
 * drifts from production without anything failing.
 *
 * Named `_db.ts`, not `*.test.ts`, so the `test/*.test.ts` glob in the `test`
 * script does not run it as a test file.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

import pg from "pg";

import { runMigrations } from "../lib/migrate/index.mjs";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** For `describe(..., { skip: SKIP_WITHOUT_DATABASE })`. */
export const SKIP_WITHOUT_DATABASE: false | string = TEST_DATABASE_URL ? false : "TEST_DATABASE_URL not set";

const MIGRATIONS = path.join(import.meta.dirname, "..", "db", "migrations");

/**
 * Every database this helper creates starts with this, so a run that was killed
 * before its `after` hooks ran leaves something recognisable. Those are safe to
 * drop by hand: `SELECT datname FROM pg_database WHERE datname LIKE 'nn_test_%'`.
 */
export const TEST_DATABASE_PREFIX = "nn_test_";

export interface TestDatabase {
  /** The database's name, e.g. `nn_test_deck_4821_1a2b3c4d`. */
  readonly name: string;
  /** TEST_DATABASE_URL with the database swapped for this one. */
  readonly url: string;
  /**
   * Drop the database. WITH (FORCE), so a pool the file forgot to end — or a
   * client a failed test left checked out — cannot keep it alive and make
   * teardown hang; that is exactly the path where cleanup matters most.
   */
  drop(): Promise<void>;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  // A short-lived Client per call rather than a module-level pool: a pool left
  // open keeps the test process's event loop alive after its last test, and
  // node:test then waits on it instead of exiting.
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Create a uniquely named database and, unless told not to, migrate it.
 *
 * `label` goes into the name so a leftover says which file made it. The pid and
 * random suffix are what make it unique: two files, or two runs of one file,
 * never land on the same name, even from two checkouts against one server.
 *
 * `migrate: false` is for test/migrate.test.ts, whose subject is what the
 * runner does to a database it has not touched yet.
 */
export async function createTestDatabase(
  label: string,
  { migrate = true }: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) {
    // The describe should have been skipped; reaching here means a file forgot
    // SKIP_WITHOUT_DATABASE, and a clear message beats a pg connection error.
    throw new Error("TEST_DATABASE_URL is not set; database tests should have been skipped");
  }

  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);
  // Built only from [a-z0-9_] and kept well under Postgres's 63-byte identifier
  // limit — past it the name is silently truncated, and two files whose names
  // collide after truncation would share a database again.
  const name = `${TEST_DATABASE_PREFIX}${slug}_${process.pid}_${randomBytes(4).toString("hex")}`;

  // CREATE DATABASE takes no bind parameters and cannot run in a transaction;
  // the name is safe to interpolate because this function built it.
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name}`)).catch((err: { code?: string }) => {
    // 42501 is insufficient_privilege. Said plainly, because the role that
    // used to be enough — one that could write to an existing database — is
    // exactly the one that now fails here, on every file at once.
    if (err.code === "42501") {
      throw new Error(`the TEST_DATABASE_URL role cannot create databases; grant it CREATEDB`, { cause: err });
    }
    throw err;
  });

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;

  const db: TestDatabase = {
    name,
    url: url.toString(),
    drop: () => withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }),
  };

  if (migrate) {
    // A Client, not a Pool: runMigrations holds an advisory lock on one
    // connection (see lib/migrate/index.mjs).
    const client = new pg.Client({ connectionString: db.url });
    try {
      await client.connect();
      await runMigrations(client, { dir: MIGRATIONS });
    } catch (err) {
      // Do not leak the database on the way out: the caller never got a
      // handle to drop it with.
      await client.end().catch(() => {});
      await db.drop().catch(() => {});
      throw err;
    }
    await client.end();
  }

  return db;
}
