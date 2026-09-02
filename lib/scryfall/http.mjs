/**
 * HTTP access to Scryfall, with the headers and pacing their API terms require.
 *
 * Scryfall asks every client to:
 *   - send a descriptive User-Agent (a default `node`/`curl` UA can be blocked),
 *   - send an explicit Accept header,
 *   - stay at or under ~10 requests/second.
 *
 * A refresh makes exactly two requests (the bulk index, then one file), so the
 * rate limit is never in play — but the pacing is enforced anyway so it cannot
 * be violated by a future caller or a retry loop.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";

/**
 * Scryfall wants a UA that identifies the application, not the HTTP library.
 * Override with SCRYFALL_USER_AGENT if this ever needs a contact address.
 */
export const DEFAULT_USER_AGENT =
  "ninetynine/0.1 (self-hosted MTG collection tracker; +https://github.com/ghostfrogcherry/ninetynine)";

/** 10 req/s is the documented ceiling; 100ms between requests sits exactly on it. */
const MIN_REQUEST_INTERVAL_MS = 100;

let lastRequestAt = 0;

async function pace() {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

function userAgent() {
  return process.env.SCRYFALL_USER_AGENT || DEFAULT_USER_AGENT;
}

async function request(url, accept, fetchImpl) {
  await pace();
  const response = await (fetchImpl ?? fetch)(url, {
    headers: { "User-Agent": userAgent(), Accept: accept },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

/**
 * Fetch /bulk-data and pick out one entry.
 *
 * The download URL field is NOT stable across Scryfall's own history. As of
 * 2026-09 an entry carries `jsonl_download_uri` (gzipped JSON Lines) and
 * `download_uri` — the plain JSON array documented for years — is gone; the
 * `.json` array files themselves now 404. Both keys are read, preferring
 * whichever is present, so this keeps working across another such change.
 *
 * @returns {Promise<{type: string, updatedAt: string, downloadUri: string,
 *   compressedSize: number|null, entry: Record<string, any>}>}
 */
export async function fetchBulkEntry(bulkType = "default_cards", options = {}) {
  const url = options.bulkDataUrl ?? BULK_DATA_URL;
  const response = await request(url, "application/json", options.fetchImpl);
  const payload = await response.json();

  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(`unexpected /bulk-data payload: no 'data' array at ${url}`);
  }

  const entry = payload.data.find((item) => item && item.type === bulkType);
  if (!entry) {
    const available = payload.data.map((item) => item && item.type).join(", ");
    throw new Error(`no '${bulkType}' entry in bulk data (available: ${available})`);
  }

  const downloadUri = entry.download_uri ?? entry.jsonl_download_uri;
  if (typeof downloadUri !== "string" || !downloadUri) {
    throw new Error(
      `'${bulkType}' entry has neither download_uri nor jsonl_download_uri ` +
        `(keys: ${Object.keys(entry).join(", ")})`,
    );
  }
  if (typeof entry.updated_at !== "string" || !entry.updated_at) {
    throw new Error(`'${bulkType}' entry has no updated_at`);
  }

  return {
    type: bulkType,
    updatedAt: entry.updated_at,
    downloadUri,
    compressedSize: entry.compressed_size ?? entry.size ?? null,
    entry,
  };
}

/** Keep Scryfall's own dated filename, stripped of anything path-like. */
export function bulkFileName(downloadUri, bulkType) {
  let base = "";
  try {
    base = path.basename(new URL(downloadUri).pathname);
  } catch {
    base = "";
  }
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "");
  return safe || `${bulkType}.data`;
}

/**
 * Download a bulk file into `dataDir`, streaming straight to disk.
 *
 * Written to a `.part` file and renamed on completion, so an interrupted run can
 * never leave a truncated file that a later run would happily half-parse.
 *
 * An existing complete file of the expected size is reused: re-running after a
 * database failure should not re-pull ~78MB.
 *
 * @returns {Promise<{filePath: string, bytes: number, reused: boolean}>}
 */
export async function downloadBulkFile(downloadUri, dataDir, options = {}) {
  const { bulkType = "default_cards", expectedSize = null, log = () => {}, fetchImpl } = options;

  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, bulkFileName(downloadUri, bulkType));

  if (expectedSize) {
    try {
      const existing = await stat(filePath);
      if (existing.size === expectedSize) {
        log(`reusing existing download ${filePath} (${existing.size} bytes)`);
        return { filePath, bytes: existing.size, reused: true };
      }
    } catch {
      // Not present; fall through and download.
    }
  }

  const partPath = `${filePath}.part`;
  const response = await request(downloadUri, "*/*", fetchImpl);
  if (!response.body) throw new Error(`GET ${downloadUri} returned no body`);

  log(`downloading ${downloadUri} -> ${filePath}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partPath));
  } catch (error) {
    await unlink(partPath).catch(() => {});
    throw error;
  }

  const written = await stat(partPath);
  if (expectedSize && written.size !== expectedSize) {
    await unlink(partPath).catch(() => {});
    throw new Error(
      `download truncated: expected ${expectedSize} bytes, got ${written.size}`,
    );
  }

  await rename(partPath, filePath);
  return { filePath, bytes: written.size, reused: false };
}
