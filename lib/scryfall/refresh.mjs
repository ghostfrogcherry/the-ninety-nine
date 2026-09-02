/**
 * The weekly Scryfall bulk refresh, end to end.
 *
 * Sequence:
 *   1. GET /bulk-data, find the requested entry, read its download URI and
 *      `updated_at`.
 *   2. If `updated_at` has not moved since the last successful run, STOP —
 *      without downloading. This is the guard that stops a cron job re-pulling
 *      and re-parsing hundreds of MB every week for no change.
 *   3. Download to SCRYFALL_DATA_DIR.
 *   4. In ONE transaction: snapshot the outgoing prices into card_price_history,
 *      then stream-parse the file and upsert every card in batches.
 *   5. Record the outcome in scryfall_bulk_imports.
 *
 * The whole import is one transaction so a mid-file failure cannot leave the
 * mirror half old and half new, and cannot lose a price snapshot whose source
 * rows have already been overwritten.
 *
 * Takes a pg pool as an argument rather than importing lib/db: this runs from a
 * plain .mjs script with no TypeScript loader, and the tests inject a throwaway
 * pool.
 */

import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { CARD_COLUMNS, toCardRow } from "./card-row.mjs";
import { downloadBulkFile, fetchBulkEntry } from "./http.mjs";
import {
  buildCardUpsert,
  DEFAULT_BATCH_SIZE,
  LAST_SUCCESSFUL_IMPORT_SQL,
  MAX_BATCH_SIZE,
  SNAPSHOT_PRICES_SQL,
} from "./sql.mjs";
import { streamCardsFromFile } from "./stream.mjs";

export const DEFAULT_DATA_DIR = "/data/scryfall";

/** How many per-card failures to spell out before summarising. */
const MAX_LOGGED_SKIPS = 20;
/** Progress line cadence during the upsert. */
const PROGRESS_EVERY = 25_000;

function sameInstant(a, b) {
  if (a == null || b == null) return false;
  const left = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const right = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * Delete previous downloads of the same bulk type, plus abandoned `.part` files.
 *
 * Each weekly file is tens of MB; without this the data volume grows without
 * bound on a home server. Only files whose name matches Scryfall's own
 * `<bulk-type>-...` pattern are touched.
 */
async function pruneOldDownloads(dataDir, keepFileName, bulkType, log) {
  const prefix = bulkType.replace(/_/g, "-");
  let entries;
  try {
    entries = await readdir(dataDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (name === keepFileName) continue;
    const isOldDownload = name.startsWith(`${prefix}-`) || name.startsWith(`${bulkType}-`);
    const isStalePart = name.endsWith(".part");
    if (!isOldDownload && !isStalePart) continue;
    try {
      await unlink(path.join(dataDir, name));
      removed++;
      log(`removed old download ${name}`);
    } catch {
      // Best effort; a file we cannot delete must not fail the run.
    }
  }
  return removed;
}

/**
 * Stream the bulk file into scryfall_cards in batches.
 *
 * @returns {Promise<{upserted: number, skipped: number, skipReasons: string[]}>}
 */
async function upsertCards(client, filePath, batchSize, log) {
  let upserted = 0;
  let skipped = 0;
  const skipReasons = [];

  // Keyed by id: Postgres rejects an ON CONFLICT DO UPDATE that touches the same
  // row twice within ONE statement, so a duplicate id inside a batch would abort
  // the whole import. Duplicates ACROSS batches are harmless (the later batch
  // just updates), so this only has to be per-batch — no 100k-entry set needed.
  let batch = new Map();

  const flush = async () => {
    if (batch.size === 0) return;
    const rows = [...batch.values()];
    batch = new Map();
    const values = rows.flat();
    await client.query(buildCardUpsert(rows.length), values);
    upserted += rows.length;
    if (Math.floor(upserted / PROGRESS_EVERY) !== Math.floor((upserted - rows.length) / PROGRESS_EVERY)) {
      log(`upserted ${upserted} cards...`);
    }
  };

  for await (const card of streamCardsFromFile(filePath)) {
    let row;
    try {
      row = toCardRow(card);
    } catch (error) {
      skipped++;
      if (skipReasons.length < MAX_LOGGED_SKIPS) {
        const id = card && typeof card === "object" ? (card.id ?? "?") : "?";
        const name = card && typeof card === "object" ? (card.name ?? "?") : "?";
        skipReasons.push(`${id} (${name}): ${error.message}`);
      }
      continue;
    }
    batch.set(row[0], row);
    if (batch.size >= batchSize) await flush();
  }
  await flush();

  return { upserted, skipped, skipReasons };
}

/**
 * Run the refresh.
 *
 * @param {object} options
 * @param {import('pg').Pool} options.pool
 * @param {string} [options.dataDir]      defaults to SCRYFALL_DATA_DIR or /data/scryfall
 * @param {string} [options.bulkType]     defaults to 'default_cards'
 * @param {boolean} [options.force]       run even if source_updated_at is unchanged
 * @param {number} [options.batchSize]
 * @param {boolean} [options.prune]       delete superseded downloads (default true)
 * @param {string} [options.bulkDataUrl]  override the /bulk-data endpoint (tests)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{status: 'skipped'|'ok', ...}>}
 */
export async function runRefresh(options) {
  const {
    pool,
    bulkType = "default_cards",
    dataDir = process.env.SCRYFALL_DATA_DIR || DEFAULT_DATA_DIR,
    force = false,
    prune = true,
    bulkDataUrl,
    fetchImpl,
    log = () => {},
  } = options;

  if (!pool) throw new Error("runRefresh requires a pg pool");

  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE,
  );

  log(`checking ${bulkType} bulk data`);
  const entry = await fetchBulkEntry(bulkType, { bulkDataUrl, fetchImpl });
  log(`Scryfall reports ${bulkType} updated_at=${entry.updatedAt}`);

  const { rows: previous } = await pool.query(LAST_SUCCESSFUL_IMPORT_SQL, [bulkType]);
  const last = previous[0];

  if (last && sameInstant(last.source_updated_at, entry.updatedAt) && !force) {
    log(
      `up to date: import #${last.id} already loaded this exact snapshot ` +
        `(${last.card_count} cards). Nothing downloaded.`,
    );
    return {
      status: "skipped",
      reason: "source_updated_at unchanged",
      bulkType,
      sourceUpdatedAt: entry.updatedAt,
      lastImportId: last.id,
      downloaded: false,
    };
  }
  if (last && sameInstant(last.source_updated_at, entry.updatedAt) && force) {
    log("source_updated_at unchanged, but --force was given; continuing");
  }

  const { rows: created } = await pool.query(
    `INSERT INTO scryfall_bulk_imports (bulk_type, source_updated_at, download_uri, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING id`,
    [bulkType, entry.updatedAt, entry.downloadUri],
  );
  const runId = created[0].id;
  log(`started import #${runId}`);

  try {
    const download = await downloadBulkFile(entry.downloadUri, dataDir, {
      bulkType,
      expectedSize: entry.compressedSize,
      fetchImpl,
      log,
    });
    log(`have ${download.bytes} bytes at ${download.filePath}`);

    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");

      // MUST precede the upsert: scryfall_cards.prices holds only current
      // values and is about to be overwritten.
      const snapshot = await client.query(SNAPSHOT_PRICES_SQL);
      log(`snapshotted ${snapshot.rowCount} price rows into card_price_history`);

      result = await upsertCards(client, download.filePath, batchSize, log);

      await client.query("COMMIT");
      result.priceRowsSnapshotted = snapshot.rowCount;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    for (const reason of result.skipReasons) log(`skipped card: ${reason}`);
    if (result.skipped > result.skipReasons.length) {
      log(`...and ${result.skipped - result.skipReasons.length} more skipped cards`);
    }

    await pool.query(
      `UPDATE scryfall_bulk_imports
       SET status = 'ok', card_count = $2, finished_at = now(), error = NULL
       WHERE id = $1`,
      [runId, result.upserted],
    );

    if (prune) {
      await pruneOldDownloads(dataDir, path.basename(download.filePath), bulkType, log);
    }

    log(
      `import #${runId} ok: ${result.upserted} cards upserted, ` +
        `${result.skipped} skipped, ${result.priceRowsSnapshotted} price rows kept`,
    );

    return {
      status: "ok",
      bulkType,
      importId: runId,
      sourceUpdatedAt: entry.updatedAt,
      downloadUri: entry.downloadUri,
      filePath: download.filePath,
      downloaded: !download.reused,
      cardCount: result.upserted,
      skipped: result.skipped,
      priceRowsSnapshotted: result.priceRowsSnapshotted,
    };
  } catch (error) {
    // Recorded on the pool, not the (already rolled back) transaction client.
    await pool
      .query(
        `UPDATE scryfall_bulk_imports
         SET status = 'failed', finished_at = now(), error = $2
         WHERE id = $1`,
        [runId, String(error && error.stack ? error.stack : error).slice(0, 4000)],
      )
      .catch(() => {});
    throw error;
  }
}

export { CARD_COLUMNS };
