/**
 * Migration runner.
 *
 * `db/migrations/` is mounted into `/docker-entrypoint-initdb.d`, which Postgres
 * runs on FIRST init only. Once `data/db` exists the directory is ignored, so
 * every schema change after the first deploy had to be applied by hand with
 * psql — against a database holding real collection data, with nothing
 * recording what had already run. This is the thing that replaces that.
 *
 * Plain `.mjs` with its own pg client passed in, matching lib/scryfall/: the
 * scripts run under bare `node` with no TypeScript loader, so nothing here may
 * import a `.ts` module.
 *
 * Two properties the design is built around:
 *
 * 1. **Postgres has transactional DDL.** Each migration and the row recording
 *    it commit together or not at all, so a migration that fails halfway leaves
 *    neither half-applied schema nor a lying ledger. Databases without this
 *    need a "dirty" flag and manual repair; we get to skip that entirely.
 *
 * 2. **An applied migration is immutable.** Its checksum is stored, and editing
 *    the file after it has run is an error rather than a silent no-op — the
 *    failure being a developer who "fixes" 0003, sees it work on their fresh
 *    database, and ships a schema the production box will never have.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * `NNNN_label.sql`. The numeric prefix is what orders them, so it is fixed
 * width — `10_x.sql` would sort before `9_x.sql` under the plain string sort
 * used everywhere here and in `/docker-entrypoint-initdb.d`.
 */
export const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

/** The table is itself never a migration — it has to exist before one can run. */
export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  label       TEXT        NOT NULL,
  checksum    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER     NOT NULL
)`;

/**
 * Key for `pg_advisory_lock`. Arbitrary but fixed: two runners racing (a deploy
 * script and a hand-run command, say) would otherwise both see the same pending
 * list and both try to apply it, and the loser dies on a duplicate object
 * rather than politely waiting.
 */
export const LOCK_KEY = 990099;

export function checksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Parse a migration filename, or return null for anything else in the
 * directory. Null rather than throwing because the directory legitimately holds
 * other things — a README, an editor's swap file — and a runner that refuses to
 * start because someone left a `.sql.bak` behind is a runner people work around.
 */
export function parseMigrationName(filename) {
  const m = MIGRATION_FILENAME.exec(filename);
  return m ? { version: m[1], label: m[2] } : null;
}

/** Read and hash every migration in `dir`, in version order. */
export async function loadMigrations(dir) {
  const entries = await readdir(dir);
  const found = [];

  for (const filename of entries.sort()) {
    const parsed = parseMigrationName(filename);
    if (!parsed) continue;
    const sql = await readFile(path.join(dir, filename), "utf8");
    found.push({ ...parsed, filename, sql, checksum: checksum(sql) });
  }

  const seen = new Map();
  for (const m of found) {
    const clash = seen.get(m.version);
    // Two files claiming one version is unresolvable: whichever ran first wins
    // on one machine and loses on another. Caught here rather than by a
    // primary-key violation three migrations later.
    if (clash) throw new Error(`duplicate migration version ${m.version}: ${clash.filename} and ${m.filename}`);
    seen.set(m.version, m);
  }

  return found;
}

/**
 * Compare what is on disk with what the database says it has run.
 *
 * Returns every category rather than throwing on the bad ones, so a caller can
 * report all the problems at once. `--status` wants to *show* a changed
 * checksum; `migrate` wants to refuse because of it.
 *
 * @param {{ version: string, label: string, checksum: string }[]} onDisk
 * @param {{ version: string, label: string, checksum: string }[]} applied
 * @param {{ allowOutOfOrder?: boolean }} [options]
 */
export function planMigrations(onDisk, applied, { allowOutOfOrder = false } = {}) {
  const appliedBy = new Map(applied.map((row) => [row.version, row]));
  const onDiskBy = new Map(onDisk.map((m) => [m.version, m]));

  const pending = [];
  const changed = [];
  for (const m of onDisk) {
    const row = appliedBy.get(m.version);
    if (!row) pending.push(m);
    else if (row.checksum !== m.checksum) changed.push({ ...m, appliedChecksum: row.checksum });
  }

  // Applied, but the file is gone. Not fatal on its own — the schema it created
  // is still there — but it means the directory can no longer rebuild this
  // database from scratch, which is the whole point of keeping them.
  const missing = applied
    .filter((row) => !onDiskBy.has(row.version))
    .map((row) => ({ version: row.version, label: row.label }));

  // A pending migration that sorts BEFORE something already applied. Two
  // branches each adding an 0007 produce exactly this, and applying the loser
  // afterwards runs it against schema its author never saw.
  const highestApplied = applied.map((r) => r.version).sort().at(-1) ?? null;
  const outOfOrder = allowOutOfOrder || highestApplied === null
    ? []
    : pending.filter((m) => m.version < highestApplied);

  return { pending, changed, missing, outOfOrder };
}

/* ------------------------------------------------------------------ *
 * Database side
 * ------------------------------------------------------------------ */

export async function ensureMigrationsTable(db) {
  await db.query(MIGRATIONS_TABLE_SQL);
}

export async function hasMigrationsTable(db) {
  const { rows } = await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
  return rows[0].present === true;
}

/**
 * Is this database empty of OUR schema?
 *
 * Deliberately not "empty of everything": Postgres ships extensions and a
 * `public` schema, and a database someone created by hand may already carry
 * something harmless. What matters is whether migration 0001 has run, so this
 * asks about its first table.
 */
export async function schemaIsEmpty(db) {
  const { rows } = await db.query("SELECT to_regclass('public.users') IS NULL AS empty");
  return rows[0].empty === true;
}

export async function readApplied(db) {
  const { rows } = await db.query(
    "SELECT version, label, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version",
  );
  return rows;
}

/**
 * Apply one migration and record it, in a single transaction.
 *
 * The recording INSERT is inside the same transaction as the migration's own
 * SQL on purpose. Split them and a crash in between leaves schema that the
 * ledger denies, which the next run will try to apply again.
 */
export async function applyMigration(db, migration) {
  const started = Date.now();
  await db.query("BEGIN");
  try {
    await db.query(migration.sql);
    await db.query(
      `INSERT INTO schema_migrations (version, label, checksum, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.label, migration.checksum, Date.now() - started],
    );
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw new Error(`migration ${migration.version}_${migration.label} failed: ${err.message}`, { cause: err });
  }
  return Date.now() - started;
}

/**
 * Record migrations as applied WITHOUT running them.
 *
 * For the database that already exists. `/docker-entrypoint-initdb.d` applied
 * 0001-0006 at first init and wrote no ledger, so the runner meeting that box
 * for the first time sees six pending migrations against a schema that already
 * has all six. Running them would fail on the first CREATE TABLE; this adopts
 * them instead.
 *
 * `upTo` is the escape from the obvious trap: baselining *everything on disk*
 * is only right if nothing new has been added since the box was built. Pin it
 * to the last version that box actually received and anything later stays
 * pending, which is what you want when you upgrade and add 0007 in one go.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ version: string, label: string, checksum: string }[]} onDisk
 * @param {{ upTo?: string | null }} [options]
 */
export async function baselineMigrations(db, onDisk, { upTo = null } = {}) {
  const adopt = upTo === null ? onDisk : onDisk.filter((m) => m.version <= upTo);
  if (upTo !== null && !onDisk.some((m) => m.version === upTo)) {
    throw new Error(`--baseline=${upTo} names a version that is not in the migrations directory`);
  }

  await db.query("BEGIN");
  try {
    for (const m of adopt) {
      await db.query(
        `INSERT INTO schema_migrations (version, label, checksum, duration_ms)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (version) DO NOTHING`,
        [m.version, m.label, m.checksum],
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
  return adopt;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/** Thrown for a state a human has to resolve, so the CLI can print it without a stack. */
export class MigrationError extends Error {}

export function describePlan(plan) {
  const lines = [];
  for (const m of plan.changed) {
    lines.push(`  changed after being applied: ${m.version}_${m.label}.sql`);
  }
  for (const m of plan.outOfOrder) {
    lines.push(`  out of order: ${m.version}_${m.label}.sql sorts before a migration already applied`);
  }
  for (const m of plan.missing) {
    lines.push(`  applied but no longer on disk: ${m.version}_${m.label}.sql`);
  }
  return lines;
}

/**
 * Apply every pending migration.
 *
 * `db` is a pg Client, not a Pool: the advisory lock is held on a connection,
 * and a Pool would hand the next query to a different one that does not hold it.
 *
 * The options are spelled out in JSDoc rather than left to inference. Callers
 * are TypeScript (the tests) and TypeScript reads defaults as the whole type —
 * `baselineUpTo = null` would otherwise be inferred as `null`, making every
 * real version string a type error.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{
 *   dir: string,
 *   dryRun?: boolean,
 *   baseline?: boolean,
 *   baselineUpTo?: string | null,
 *   allowOutOfOrder?: boolean,
 *   log?: (message: string) => void,
 * }} options
 */
export async function runMigrations(db, {
  dir,
  dryRun = false,
  baseline = false,
  baselineUpTo = null,
  allowOutOfOrder = false,
  log = () => {},
} = {}) {
  const onDisk = await loadMigrations(dir);
  if (onDisk.length === 0) throw new MigrationError(`no migrations found in ${dir}`);

  await db.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const tableExists = await hasMigrationsTable(db);

    if (baseline) {
      await ensureMigrationsTable(db);
      const adopted = await baselineMigrations(db, onDisk, { upTo: baselineUpTo });
      for (const m of adopted) log(`baselined ${m.version}_${m.label}`);
      return { baselined: adopted, applied: [] };
    }

    // The database predates the ledger. Applying everything would fail on the
    // first CREATE TABLE and adopting everything silently could skip a
    // migration this box genuinely never ran, so neither is safe to guess at.
    if (!tableExists && !(await schemaIsEmpty(db))) {
      throw new MigrationError(
        "this database has schema but no schema_migrations table.\n" +
        "It was built by /docker-entrypoint-initdb.d, which keeps no record of what it ran.\n" +
        "Adopt what it applied, then run again:\n" +
        `  node scripts/migrate.mjs --baseline=${onDisk.at(-1).version}\n` +
        "Pass the last version that box actually received — not necessarily the last on disk.",
      );
    }

    await ensureMigrationsTable(db);
    const applied = await readApplied(db);
    const plan = planMigrations(onDisk, applied, { allowOutOfOrder });

    if (plan.changed.length || plan.outOfOrder.length) {
      throw new MigrationError(["refusing to migrate:", ...describePlan(plan)].join("\n"));
    }
    // Missing files cannot be repaired by this tool and do not block the run,
    // so they are a warning rather than a refusal.
    for (const m of plan.missing) log(`WARNING: ${m.version}_${m.label} is recorded as applied but is not on disk`);

    if (plan.pending.length === 0) {
      log(`up to date — ${applied.length} migration${applied.length === 1 ? "" : "s"} applied`);
      return { baselined: [], applied: [] };
    }

    if (dryRun) {
      for (const m of plan.pending) log(`would apply ${m.version}_${m.label}`);
      return { baselined: [], applied: [], wouldApply: plan.pending };
    }

    const done = [];
    for (const m of plan.pending) {
      const ms = await applyMigration(db, m);
      log(`applied ${m.version}_${m.label} in ${ms}ms`);
      done.push(m);
    }
    return { baselined: [], applied: done };
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
