/**
 * Migration runner tests — `lib/migrate/index.mjs`.
 *
 *   npm test
 *
 * The pure tests always run. The database tests run only when
 * TEST_DATABASE_URL is set, e.g.
 *
 *   docker run -d --name nn-migrate-test -p 55437:5432 \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=ninetynine -e POSTGRES_USER=ninetynine \
 *     postgres:17-alpine
 *   until docker exec nn-migrate-test psql -U ninetynine -d ninetynine -c 'SELECT 1'; do sleep 1; done
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55437/ninetynine \
 *     node --experimental-strip-types --test test/migrate.test.ts
 *
 * A DEDICATED variable, not DATABASE_URL, for the reason the other files give:
 * these tests CREATE and DROP whole schemas and must never be able to do that
 * to a real instance by inheriting the app's environment.
 *
 * Unlike the other database tests these do NOT run against the migrated schema
 * — they build throwaway schemas of their own and drop them again, because the
 * thing under test is what happens to a database that has not been migrated
 * yet. That also keeps them from colliding with the files that do share one.
 *
 * `lib/migrate/` is plain .mjs, so it imports directly: no variable-specifier
 * dance is needed, and there are no types to erase.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  MIGRATION_FILENAME, MigrationError, baselineMigrations, checksum, describePlan,
  loadMigrations, parseMigrationName, planMigrations, runMigrations,
} from "../lib/migrate/index.mjs";

/* ------------------------------------------------------------------ *
 * Pure: filenames
 * ------------------------------------------------------------------ */

describe("parseMigrationName", () => {
  it("accepts the shape the directory actually uses", () => {
    assert.deepEqual(parseMigrationName("0001_auth.sql"), { version: "0001", label: "auth" });
    assert.deepEqual(parseMigrationName("0006_collection_values_fallback.sql"), {
      version: "0006",
      label: "collection_values_fallback",
    });
  });

  it("returns null for everything that is not a migration", () => {
    for (const name of [
      "README.md",
      "0001_auth.sql.bak",
      ".0001_auth.sql.swp",
      "0001-auth.sql",      // hyphen, not underscore
      "001_auth.sql",       // three digits sorts wrong against 0010
      "00001_auth.sql",
      "0001_.sql",
      "0001_Auth.sql",      // uppercase: two files could differ only by case
      "auth.sql",
      "0001_auth.SQL",
      "",
    ]) {
      assert.equal(parseMigrationName(name), null, `expected null for ${JSON.stringify(name)}`);
    }
  });

  it("fixes the width at four digits so string order is version order", () => {
    // The whole scheme rests on plain string sorting — it is what
    // /docker-entrypoint-initdb.d uses too. Ten migrations in, a three-digit
    // name would sort before a two-digit one and run in the wrong order.
    const names = ["0002_b.sql", "0010_j.sql", "0001_a.sql", "0009_i.sql"];
    assert.deepEqual(
      names.sort().map((n) => parseMigrationName(n)!.version),
      ["0001", "0002", "0009", "0010"],
    );
    assert.equal(MIGRATION_FILENAME.test("0010_j.sql"), true);
  });
});

describe("checksum", () => {
  it("is stable, and changes when a single byte does", () => {
    const a = checksum("SELECT 1;\n");
    assert.equal(a, checksum("SELECT 1;\n"));
    assert.notEqual(a, checksum("SELECT 1; \n"));
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("matches sha256sum over the same bytes", () => {
    // The initdb hook (db/init/zzz_record_baseline.sh) hashes with sha256sum.
    // If these two ever disagree, every fresh install reports all its
    // migrations as edited-since-applied on the first run.
    assert.equal(
      checksum("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Pure: the plan
 * ------------------------------------------------------------------ */

const m = (version: string, label = "x", sql = `-- ${version}`) => ({
  version, label, filename: `${version}_${label}.sql`, sql, checksum: checksum(sql),
});
const appliedRow = (mig: ReturnType<typeof m>) => ({
  version: mig.version, label: mig.label, checksum: mig.checksum,
});

describe("planMigrations", () => {
  it("calls everything pending against an empty ledger", () => {
    const disk = [m("0001"), m("0002")];
    const plan = planMigrations(disk, []);
    assert.deepEqual(plan.pending.map((p) => p.version), ["0001", "0002"]);
    assert.deepEqual(plan.changed, []);
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(plan.outOfOrder, []);
  });

  it("calls nothing pending when the ledger matches disk", () => {
    const disk = [m("0001"), m("0002")];
    const plan = planMigrations(disk, disk.map(appliedRow));
    assert.deepEqual(plan.pending, []);
  });

  it("flags a migration edited after it was applied", () => {
    const disk = [m("0001", "x", "-- edited")];
    const plan = planMigrations(disk, [appliedRow(m("0001", "x", "-- original"))]);
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.changed.map((c) => c.version), ["0001"]);
    assert.equal(plan.changed[0].appliedChecksum, checksum("-- original"));
  });

  it("flags a migration recorded as applied that is no longer on disk", () => {
    const plan = planMigrations([m("0001")], [appliedRow(m("0001")), appliedRow(m("0002"))]);
    assert.deepEqual(plan.missing, [{ version: "0002", label: "x" }]);
    assert.deepEqual(plan.pending, []);
  });

  it("flags a pending migration that sorts before one already applied", () => {
    // Two branches each adding an 0007, merged. The loser would otherwise run
    // against schema its author never saw.
    const plan = planMigrations([m("0007"), m("0008")], [appliedRow(m("0008"))]);
    assert.deepEqual(plan.outOfOrder.map((p) => p.version), ["0007"]);
    assert.deepEqual(plan.pending.map((p) => p.version), ["0007"]);
  });

  it("does not flag out-of-order when asked not to", () => {
    const plan = planMigrations([m("0007"), m("0008")], [appliedRow(m("0008"))], { allowOutOfOrder: true });
    assert.deepEqual(plan.outOfOrder, []);
  });

  it("does not call a normal next migration out of order", () => {
    const plan = planMigrations([m("0001"), m("0002")], [appliedRow(m("0001"))]);
    assert.deepEqual(plan.outOfOrder, []);
    assert.deepEqual(plan.pending.map((p) => p.version), ["0002"]);
  });

  it("reports every problem at once rather than the first", () => {
    const plan = planMigrations(
      [m("0001", "x", "-- edited"), m("0007")],
      [appliedRow(m("0001", "x", "-- original")), appliedRow(m("0008"))],
    );
    const lines = describePlan(plan);
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => l.includes("changed after being applied")));
    assert.ok(lines.some((l) => l.includes("out of order")));
    assert.ok(lines.some((l) => l.includes("no longer on disk")));
  });
});

/* ------------------------------------------------------------------ *
 * Pure: reading the directory
 * ------------------------------------------------------------------ */

describe("loadMigrations", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(path.join(tmpdir(), "nn-mig-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads in version order and ignores everything that is not a migration", async () => {
    await writeFile(path.join(dir, "0002_second.sql"), "-- two");
    await writeFile(path.join(dir, "0001_first.sql"), "-- one");
    await writeFile(path.join(dir, "README.md"), "not a migration");
    await writeFile(path.join(dir, "0003_third.sql.bak"), "not a migration either");

    const found = await loadMigrations(dir);
    assert.deepEqual(found.map((f) => f.version), ["0001", "0002"]);
    assert.equal(found[0].sql, "-- one");
    assert.equal(found[0].checksum, checksum("-- one"));
  });

  it("refuses two files claiming the same version", async () => {
    const clash = await mkdtemp(path.join(tmpdir(), "nn-mig-clash-"));
    await writeFile(path.join(clash, "0001_one.sql"), "-- a");
    await writeFile(path.join(clash, "0001_other.sql"), "-- b");
    await assert.rejects(() => loadMigrations(clash), /duplicate migration version 0001/);
    await rm(clash, { recursive: true, force: true });
  });

  it("reads the real migrations directory", async () => {
    // Guards the directory itself: a file added with a name the runner cannot
    // parse is silently not a migration, which is the quiet failure here.
    const real = path.join(import.meta.dirname, "..", "db", "migrations");
    const found = await loadMigrations(real);
    assert.ok(found.length >= 6, `expected at least 6 migrations, got ${found.length}`);
    assert.equal(found[0].version, "0001");
    assert.deepEqual(
      found.map((f) => f.version),
      [...found.map((f) => f.version)].sort(),
      "migrations must be returned in version order",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Against a real Postgres
 * ------------------------------------------------------------------ */

const DB_URL = process.env.TEST_DATABASE_URL;

describe("migration runner against postgres", { skip: DB_URL ? false : "TEST_DATABASE_URL not set" }, () => {
  let pool: import("pg").Pool;
  let pg: typeof import("pg");

  /**
   * Each test gets its own schema, created and dropped around it, with
   * search_path pointed at it. The runner's own queries use unqualified names
   * and `to_regclass('public.users')`, so the schema is named `public` inside a
   * dedicated DATABASE instead — the only way to give it a genuinely empty
   * `public` without disturbing the one the other test files share.
   */
  const dbs: string[] = [];
  async function scratchDb(): Promise<import("pg").Client> {
    const name = `nn_mig_${Date.now().toString(36)}_${dbs.length}`;
    await pool.query(`CREATE DATABASE ${name}`);
    dbs.push(name);
    const url = new URL(DB_URL!);
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  const DIR = path.join(import.meta.dirname, "..", "db", "migrations");

  before(async () => {
    pg = (await import("pg")).default as unknown as typeof import("pg");
    pool = new pg.Pool({ connectionString: DB_URL });
  });

  after(async () => {
    for (const name of dbs) {
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    }
    await pool.end();
  });

  it("applies the real migrations to an empty database, then is a no-op", async () => {
    const db = await scratchDb();
    try {
      const first = await runMigrations(db, { dir: DIR });
      assert.ok(first.applied.length >= 6);

      // By name, not by count. A count has to be edited by whoever adds the
      // next migration, and they find out by watching this fail for a reason
      // that has nothing to do with the runner — which is exactly how the
      // injection guard in filters.test.ts broke when this table arrived.
      // What the assertion means is "the migrations built their schema", so
      // it names one table from the first migration, one from the last, and
      // the ledger the runner itself created.
      const wanted = ["users", "decks", "card_price_history", "schema_migrations"];
      const { rows: tables } = await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name = ANY($1::text[])`,
        [wanted],
      );
      assert.deepEqual(tables.map((r: { table_name: string }) => r.table_name).sort(), [...wanted].sort());

      const second = await runMigrations(db, { dir: DIR });
      assert.deepEqual(second.applied, [], "a second run must apply nothing");
    } finally {
      await db.end();
    }
  });

  it("records a checksum the initdb hook would agree with", async () => {
    const db = await scratchDb();
    try {
      await runMigrations(db, { dir: DIR });
      const onDisk = await loadMigrations(DIR);
      const { rows } = await db.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
      for (const row of rows) {
        const file = onDisk.find((f) => f.version === row.version)!;
        assert.equal(row.checksum, file.checksum);
      }
    } finally {
      await db.end();
    }
  });

  it("refuses a database that has schema but no ledger, and names the fix", async () => {
    const db = await scratchDb();
    try {
      // Stand in for /docker-entrypoint-initdb.d: apply the files by hand,
      // exactly as the postgres image does, recording nothing.
      for (const mig of await loadMigrations(DIR)) await db.query(mig.sql);

      await assert.rejects(
        () => runMigrations(db, { dir: DIR }),
        (err: Error) => {
          assert.ok(err instanceof MigrationError);
          assert.match(err.message, /schema but no schema_migrations/);
          assert.match(err.message, /--baseline=/);
          return true;
        },
      );
    } finally {
      await db.end();
    }
  });

  it("adopts an initdb-built database with --baseline, running nothing", async () => {
    const db = await scratchDb();
    try {
      for (const mig of await loadMigrations(DIR)) await db.query(mig.sql);

      const result = await runMigrations(db, { dir: DIR, baseline: true });
      assert.ok(result.baselined.length >= 6);

      // The proof it ran nothing: re-running the real migrations would have
      // died on a duplicate table, and the ledger now says there is nothing to do.
      const after = await runMigrations(db, { dir: DIR });
      assert.deepEqual(after.applied, []);
    } finally {
      await db.end();
    }
  });

  it("leaves later migrations pending when --baseline is pinned to a version", async () => {
    const db = await scratchDb();
    try {
      const onDisk = await loadMigrations(DIR);
      const cut = onDisk[onDisk.length - 2].version;
      for (const mig of onDisk) await db.query(mig.sql);

      const result = await baselineMigrationsThroughRunner(db, DIR, cut);
      assert.equal(result.baselined.at(-1)!.version, cut);

      const { rows } = await db.query("SELECT count(*)::int AS n FROM schema_migrations");
      assert.equal(rows[0].n, onDisk.length - 1, "the last migration must not have been adopted");
    } finally {
      await db.end();
    }
  });

  async function baselineMigrationsThroughRunner(db: import("pg").Client, dir: string, upTo: string) {
    return runMigrations(db, { dir, baseline: true, baselineUpTo: upTo });
  }

  it("rejects a --baseline version that is not on disk", async () => {
    const db = await scratchDb();
    try {
      await assert.rejects(
        () => runMigrations(db, { dir: DIR, baseline: true, baselineUpTo: "9999" }),
        /not in the migrations directory/,
      );
    } finally {
      await db.end();
    }
  });

  it("rolls the schema back when a migration fails, and records nothing", async () => {
    const db = await scratchDb();
    const dir = await mkdtemp(path.join(tmpdir(), "nn-mig-fail-"));
    try {
      await writeFile(path.join(dir, "0001_good.sql"), "CREATE TABLE a (id int);");
      // Valid until the last statement. Postgres has transactional DDL, so the
      // CREATE TABLE before the error must vanish with it.
      await writeFile(path.join(dir, "0002_bad.sql"), "CREATE TABLE b (id int);\nSELECT nonexistent_fn();");

      await assert.rejects(() => runMigrations(db, { dir }), /migration 0002_bad failed/);

      const { rows } = await db.query("SELECT to_regclass('public.a') AS a, to_regclass('public.b') AS b");
      assert.notEqual(rows[0].a, null, "0001 committed and must survive");
      assert.equal(rows[0].b, null, "0002 rolled back, so its table must be gone");

      const { rows: ledger } = await db.query("SELECT version FROM schema_migrations ORDER BY version");
      assert.deepEqual(ledger.map((r) => r.version), ["0001"], "a failed migration must not be recorded");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.end();
    }
  });

  it("refuses to run when an applied migration has been edited", async () => {
    const db = await scratchDb();
    const dir = await mkdtemp(path.join(tmpdir(), "nn-mig-edit-"));
    try {
      await writeFile(path.join(dir, "0001_one.sql"), "CREATE TABLE a (id int);");
      await runMigrations(db, { dir });

      await writeFile(path.join(dir, "0001_one.sql"), "CREATE TABLE a (id int, extra text);");
      await writeFile(path.join(dir, "0002_two.sql"), "CREATE TABLE c (id int);");

      await assert.rejects(
        () => runMigrations(db, { dir }),
        (err: Error) => {
          assert.match(err.message, /changed after being applied/);
          return true;
        },
      );
      // And it refused wholesale: the pending 0002 must not have slipped through.
      const { rows } = await db.query("SELECT to_regclass('public.c') AS c");
      assert.equal(rows[0].c, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.end();
    }
  });

  it("does not apply anything on a dry run", async () => {
    const db = await scratchDb();
    try {
      const result = await runMigrations(db, { dir: DIR, dryRun: true });
      assert.ok(result.wouldApply!.length >= 6);
      assert.deepEqual(result.applied, []);
      const { rows } = await db.query("SELECT to_regclass('public.users') AS users");
      assert.equal(rows[0].users, null, "dry run must create no tables");
    } finally {
      await db.end();
    }
  });
});
