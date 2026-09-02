#!/usr/bin/env node
/**
 * Weekly Scryfall bulk refresh.
 *
 *   docker compose --profile refresh run --rm scryfall-refresh
 *   node scripts/refresh-scryfall.mjs [--force] [--bulk-type=default_cards]
 *
 * Environment:
 *   DATABASE_URL         required
 *   SCRYFALL_DATA_DIR    download directory (default /data/scryfall)
 *   SCRYFALL_USER_AGENT  overrides the default descriptive UA
 *
 * Flags:
 *   --force              import even if Scryfall's updated_at has not moved
 *   --bulk-type=NAME     default_cards | oracle_cards | unique_artwork | ...
 *   --data-dir=PATH      overrides SCRYFALL_DATA_DIR
 *   --batch-size=N       rows per INSERT (default 1000)
 *   --no-prune           keep superseded downloads instead of deleting them
 *
 * Exit codes: 0 on success OR on an up-to-date early exit, 1 on failure — so a
 * cron mail only arrives when something actually broke.
 *
 * This file stays a thin wrapper. It uses its own pg Pool rather than
 * lib/db/index.ts because it runs as plain .mjs under `node` with no TypeScript
 * loader; DATABASE_URL is the same variable that module reads, so the two agree.
 */

import pg from "pg";

import { DEFAULT_DATA_DIR, runRefresh } from "../lib/scryfall/refresh.mjs";

function parseArgs(argv) {
  const options = { force: false, prune: true };
  for (const arg of argv) {
    if (arg === "--force") options.force = true;
    else if (arg === "--no-prune") options.prune = false;
    else if (arg.startsWith("--bulk-type=")) options.bulkType = arg.slice(12);
    else if (arg.startsWith("--data-dir=")) options.dataDir = arg.slice(11);
    else if (arg.startsWith("--batch-size=")) options.batchSize = Number(arg.slice(13));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.batchSize !== undefined && !Number.isInteger(options.batchSize)) {
    throw new Error("--batch-size must be an integer");
  }
  return options;
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // The refresh holds one long-lived transaction; it never needs more.
    max: 2,
    // The single upsert transaction can legitimately run for many minutes.
    statement_timeout: 0,
  });

  try {
    const result = await runRefresh({
      pool,
      log,
      bulkType: options.bulkType,
      dataDir: options.dataDir ?? process.env.SCRYFALL_DATA_DIR ?? DEFAULT_DATA_DIR,
      force: options.force,
      prune: options.prune,
      batchSize: options.batchSize,
    });
    return result;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`[${new Date().toISOString()}] refresh failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
