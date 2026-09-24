/**
 * SQL builders for the weekly refresh: the price-history snapshot and the
 * batched card upsert.
 *
 * Both statements are assembled from module-local constants only — no value
 * from the Scryfall payload is ever interpolated into SQL text. Card data goes
 * through bound parameters exclusively.
 */

import { CARD_COLUMNS } from "./card-row.mjs";

/**
 * Which key of `scryfall_cards.prices` holds the price for each finish.
 *
 * This is the whole point of 0005_prices.sql: `usd` is the NON-FOIL price and
 * `usd_foil` is the FOIL price, and they differ (Reflections of Littjara (KHM)
 * 400 is `usd: null, usd_foil: "2.25"` — a single price per printing would
 * record it as worthless). One history row is written per finish.
 *
 * `tix` (MTGO tickets) has no per-finish variant in Scryfall's payload, so it is
 * attributed to the nonfoil row only rather than duplicated onto foil/etched.
 *
 * `eur_etched` is not currently emitted by Scryfall; looking it up simply yields
 * NULL, and the mapping is correct if it ever appears.
 *
 * Finish names match `collection_cards.finish` / `deck_cards.finish`
 * ('nonfoil' | 'foil' | 'etched'), which is what `collection_values` joins on.
 */
export const FINISH_PRICE_KEYS = {
  nonfoil: { usd: "usd", eur: "eur", tix: "tix" },
  foil: { usd: "usd_foil", eur: "eur_foil", tix: null },
  etched: { usd: "usd_etched", eur: "eur_etched", tix: null },
};

/**
 * Cast one price key to NUMERIC, guarded by a shape check.
 *
 * Scryfall ships prices as JSON STRINGS ("1.23") and any of them may be null.
 * `->>` already yields SQL NULL for a JSON null, but an unexpected non-numeric
 * string would abort the whole transaction on cast; the regex makes such a value
 * degrade to NULL instead of taking the weekly cron down.
 */
function priceExpr(key) {
  if (key === null) return "NULL::numeric(10,2)";
  return (
    `CASE WHEN prices->>'${key}' ~ '^[0-9]+(\\.[0-9]+)?$' ` +
    `THEN (prices->>'${key}')::numeric(10,2) END`
  );
}

/**
 * Snapshot the prices currently in `scryfall_cards` into `card_price_history`,
 * one row per (card, finish).
 *
 * Runs BEFORE the upsert overwrites `scryfall_cards.prices`, inside the same
 * transaction — 0005_prices.sql keeps only current values in `prices`, so
 * anything not copied out here is lost.
 *
 * `recorded_on` is the date of the import that WROTE those prices
 * (`imported_at`), not today: the values being copied were true as of that
 * import, and back-dating them keeps the history honest. Pinned to UTC so the
 * same row can never land on two different dates because a container's TZ
 * changed.
 *
 * Rows where every price is NULL are skipped — most of the ~100k mirror has no
 * recorded sale in some finish, and writing empty rows would bloat the table
 * for nothing.
 *
 * ON CONFLICT DO UPDATE, not DO NOTHING: two refreshes on the same day should
 * leave that day holding the most recently observed price, not the first.
 */
export const SNAPSHOT_PRICES_SQL = `
INSERT INTO card_price_history (scryfall_id, finish, recorded_on, usd, eur, tix)
SELECT scryfall_id, finish, recorded_on, usd, eur, tix
FROM (
${Object.entries(FINISH_PRICE_KEYS)
  .map(
    ([finish, keys]) =>
      `  SELECT id AS scryfall_id,
         '${finish}'::text AS finish,
         (imported_at AT TIME ZONE 'UTC')::date AS recorded_on,
         ${priceExpr(keys.usd)} AS usd,
         ${priceExpr(keys.eur)} AS eur,
         ${priceExpr(keys.tix)} AS tix
  FROM scryfall_cards`,
  )
  .join("\n  UNION ALL\n")}
) snapshot
WHERE usd IS NOT NULL OR eur IS NOT NULL OR tix IS NOT NULL
ON CONFLICT (scryfall_id, finish, recorded_on) DO UPDATE
  SET usd = EXCLUDED.usd,
      eur = EXCLUDED.eur,
      tix = EXCLUDED.tix
`;

/** Columns overwritten on conflict — everything except the `id` key. */
const UPDATABLE = CARD_COLUMNS.filter((column) => column !== "id");

/**
 * Build a multi-row upsert for `count` cards.
 *
 * One INSERT per card is unusable at ~100k cards (a round trip each). Batching
 * keeps it to a few dozen statements. Postgres caps a statement at 65535 bound
 * parameters, which with 22 columns is 2978 cards — see MAX_BATCH_SIZE.
 *
 * `imported_at = now()` is the transaction timestamp, so it is identical for
 * every card in a run and next week's snapshot can date the whole mirror from
 * it.
 *
 * @param {number} count number of card rows in this batch
 * @returns {string}
 */
export function buildCardUpsert(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`batch size must be a positive integer, got ${count}`);
  }
  if (count > MAX_BATCH_SIZE) {
    throw new Error(`batch of ${count} exceeds the ${MAX_BATCH_SIZE}-row parameter limit`);
  }

  const width = CARD_COLUMNS.length;
  const tuples = [];
  for (let row = 0; row < count; row++) {
    const placeholders = [];
    for (let column = 0; column < width; column++) {
      placeholders.push(`$${row * width + column + 1}`);
    }
    tuples.push(`(${placeholders.join(", ")})`);
  }

  return (
    `INSERT INTO scryfall_cards (${CARD_COLUMNS.join(", ")})\nVALUES ${tuples.join(", ")}\n` +
    `ON CONFLICT (id) DO UPDATE SET\n  ` +
    UPDATABLE.map((column) => `${column} = EXCLUDED.${column}`).join(",\n  ") +
    `,\n  imported_at = now()`
  );
}

/** Largest batch that fits inside Postgres' 65535 bound-parameter limit. */
export const MAX_BATCH_SIZE = Math.floor(65535 / CARD_COLUMNS.length);

/** Default batch size: comfortably under the cap, few enough round trips. */
export const DEFAULT_BATCH_SIZE = 1000;

/**
 * Most recent successful import of a bulk type, for the early-exit guard.
 *
 * Ordered by id, not finished_at: id is monotonic and never NULL, whereas a row
 * interrupted before its final UPDATE could carry a NULL finished_at.
 */
export const LAST_SUCCESSFUL_IMPORT_SQL = `
SELECT id, source_updated_at, card_count, finished_at
FROM scryfall_bulk_imports
WHERE bulk_type = $1 AND status = 'ok'
ORDER BY id DESC
LIMIT 1
`;
