#!/usr/bin/env node
/**
 * Apply pending database migrations.
 *
 *   docker compose --profile migrate run --rm migrate
 *   node scripts/migrate.mjs [--status] [--dry-run] [--baseline[=VERSION]]
 *
 * Environment:
 *   DATABASE_URL   required
 *
 * Flags:
 *   --status               list applied and pending migrations, change nothing
 *   --dry-run              name what would be applied, apply nothing
 *   --baseline[=VERSION]   record migrations as applied WITHOUT running them,
 *                          for a database built by /docker-entrypoint-initdb.d
 *                          before this runner existed. With no VERSION it
 *                          adopts everything on disk.
 *   --allow-out-of-order   permit a pending migration that sorts before one
 *                          already applied. Two branches each adding an 0007
 *                          make this happen; think before reaching for it.
 *   --dir=PATH             migrations directory (default db/migrations)
 *
 * Exit codes: 0 on success, 1 on failure. A state needing a human decision —
 * an edited migration, an unbaselined database — exits 1 with an explanation
 * and no stack trace, because the stack would say nothing the message does not.
 *
 * Like scripts/refresh-scryfall.mjs this stays a thin wrapper and uses its own
 * pg client rather than lib/db/index.ts, which is TypeScript and unreachable
 * from bare `node`. DATABASE_URL is the same variable that module reads.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  MigrationError, loadMigrations, planMigrations, readApplied, runMigrations,
  hasMigrationsTable,
} from "../lib/migrate/index.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = path.join(REPO_ROOT, "db", "migrations");

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIR };
  for (const arg of argv) {
    if (arg === "--status") options.status = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--allow-out-of-order") options.allowOutOfOrder = true;
    else if (arg === "--baseline") options.baseline = true;
    else if (arg.startsWith("--baseline=")) {
      options.baseline = true;
      options.baselineUpTo = arg.slice(11);
    } else if (arg.startsWith("--dir=")) options.dir = path.resolve(arg.slice(6));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.status && options.baseline) throw new Error("--status and --baseline do different things; pick one");
  return options;
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

/** `--status`: report, change nothing, and do not create the ledger table. */
async function showStatus(client, dir) {
  const onDisk = await loadMigrations(dir);

  if (!(await hasMigrationsTable(client))) {
    log(`no schema_migrations table — ${onDisk.length} migration(s) on disk, none recorded`);
    for (const m of onDisk) log(`  pending  ${m.version}_${m.label}`);
    return;
  }

  const applied = await readApplied(client);
  const plan = planMigrations(onDisk, applied);
  const appliedBy = new Map(applied.map((r) => [r.version, r]));

  for (const m of onDisk) {
    const row = appliedBy.get(m.version);
    if (!row) log(`  pending  ${m.version}_${m.label}`);
    else if (row.checksum !== m.checksum) log(`  CHANGED  ${m.version}_${m.label} — edited since it was applied`);
    else log(`  applied  ${m.version}_${m.label}  ${row.applied_at.toISOString()}`);
  }
  for (const m of plan.missing) log(`  MISSING  ${m.version}_${m.label} — recorded as applied, not on disk`);

  log(`${applied.length} applied, ${plan.pending.length} pending`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) throw new MigrationError("DATABASE_URL is not set");

  // A Client, not a Pool: the advisory lock runMigrations takes lives on one
  // connection, and a Pool would run the next query on a different one.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    if (options.status) {
      await showStatus(client, options.dir);
      return;
    }

    const result = await runMigrations(client, { ...options, log });

    if (result.baselined.length) {
      log(`baselined ${result.baselined.length} migration(s) — nothing was executed`);
      log("run again without --baseline to apply anything still pending");
    } else if (result.wouldApply?.length) {
      log(`${result.wouldApply.length} migration(s) would be applied`);
    } else if (result.applied.length) {
      log(`applied ${result.applied.length} migration(s)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof MigrationError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err.stack ?? err.message}\n`);
  }
  process.exitCode = 1;
});
