/**
 * Health check tests — lib/health/index.ts.
 *
 *   npm test
 *
 * The pure tests always run and use a fake `Queryable`, which is what lets them
 * pin the timeout path without waiting on a real stalled database. The database
 * tests run only when TEST_DATABASE_URL is set; see test/_db.ts.
 *
 * They are the one place that connects to the database TEST_DATABASE_URL
 * names rather than a throwaway one: they need a live server, not a schema,
 * and write nothing — `SELECT 1` and `pg_sleep` only — so there is nothing a
 * throwaway database would isolate, only pools to close.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { SKIP_WITHOUT_DATABASE, TEST_DATABASE_URL } from "./_db.ts";

// Same variable-specifier idiom as test/filters.test.ts: types from the
// extensionless path, values from the real `.ts` file under type stripping.
import type * as HealthModule from "../lib/health";
import type { Queryable } from "../lib/health";

const healthSpecifier = "../lib/health/index.ts";
const { HEALTH_TIMEOUT_MS, checkDatabase, healthStatus } =
  (await import(healthSpecifier)) as typeof HealthModule;

const answers = (): Queryable => ({ query: async () => ({ rows: [{ "?column?": 1 }] }) });
const rejects = (): Queryable => ({ query: async () => { throw new Error("password authentication failed for user \"ninetynine\""); } });
const never = (): Queryable => ({ query: () => new Promise(() => {}) });

describe("checkDatabase", () => {
  it("is ok when the query answers", async () => {
    assert.deepEqual(await checkDatabase(answers(), 50), { ok: true });
  });

  it("runs the cheapest possible query, and nothing that reads a table", async () => {
    const seen: string[] = [];
    await checkDatabase({ query: async (text) => { seen.push(text); return { rows: [] }; } }, 50);
    assert.deepEqual(seen, ["SELECT 1"]);
  });

  it("reports an error, not the error's text", async () => {
    const result = await checkDatabase(rejects(), 50);
    assert.deepEqual(result, { ok: false, reason: "error" });
    // The driver's message names the role. Nothing of it may survive into
    // anything the route could be tempted to put in a response body.
    assert.ok(!JSON.stringify(result).includes("ninetynine"));
  });

  it("treats a driver that throws synchronously as a failed check, not a crash", async () => {
    const result = await checkDatabase({ query: () => { throw new TypeError("boom"); } }, 50);
    assert.deepEqual(result, { ok: false, reason: "error" });
  });

  it("gives up on a query that never answers, at the timeout rather than never", async () => {
    const started = Date.now();
    const result = await checkDatabase(never(), 40);
    const took = Date.now() - started;
    assert.deepEqual(result, { ok: false, reason: "timeout" });
    assert.ok(took >= 35 && took < 1_000, `took ${took}ms`);
  });

  it("survives the query failing AFTER the timeout has already answered", async () => {
    // An unhandled late rejection takes down the server being checked. Today
    // Promise.race and the early catch both prevent it; this pins that for
    // whoever replaces the race with a hand-rolled timeout.
    const late: Queryable = {
      query: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 30)),
    };
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);
    try {
      assert.deepEqual(await checkDatabase(late, 5), { ok: false, reason: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(unhandled, null);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("defaults to a timeout the compose healthcheck's own 5s cannot pre-empt", () => {
    // Compose kills the probe at 5s. If this ran longer the app would never get
    // to answer 503, and a slow database would look exactly like a dead server.
    assert.ok(HEALTH_TIMEOUT_MS > 0 && HEALTH_TIMEOUT_MS < 5_000);
  });
});

describe("healthStatus", () => {
  it("is 200 for ok and 503 for either failure", () => {
    assert.equal(healthStatus({ ok: true }), 200);
    assert.equal(healthStatus({ ok: false, reason: "error" }), 503);
    assert.equal(healthStatus({ ok: false, reason: "timeout" }), 503);
  });
});

/* ================================================================== *
 * Database
 * ================================================================== */

const DB_URL = TEST_DATABASE_URL;

describe("checkDatabase against postgres", { skip: SKIP_WITHOUT_DATABASE }, () => {
  let pool: pg.Pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  });

  after(async () => {
    await pool?.end();
  });

  it("is ok against a real server", async () => {
    assert.deepEqual(await checkDatabase(pool), { ok: true });
  });

  it("times out on a real query that is slower than the budget", async () => {
    // Drives the real driver down the timeout path. The sleep still finishes
    // in the background and returns its client, so `pool.end()` in `after`
    // is not left waiting on it.
    const slow: Queryable = { query: () => pool.query("SELECT pg_sleep(0.3)") };
    assert.deepEqual(await checkDatabase(slow, 50), { ok: false, reason: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it("fails cleanly when nothing is listening", async () => {
    // Port 1 on loopback: refused immediately, never a real server.
    const url = new URL(DB_URL!);
    url.port = "1";
    const dead = new pg.Pool({ connectionString: url.toString(), max: 1 });
    // A pool emits 'error' for idle-client failures; without a listener that
    // is an uncaught exception rather than a failed check.
    dead.on("error", () => {});
    try {
      assert.deepEqual(await checkDatabase(dead, 1_000), { ok: false, reason: "error" });
    } finally {
      await dead.end();
    }
  });
});
