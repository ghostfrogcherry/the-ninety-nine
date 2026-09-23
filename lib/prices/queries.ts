/**
 * The SQL behind `/collections/[id]/prices`, and the loaders that run it.
 *
 * Three schema facts drive every query here:
 *
 *  - `card_price_history` is keyed on (scryfall_id, finish, recorded_on).
 *    `finish` is not decoration: foil and non-foil of ONE printing are separate
 *    rows at genuinely different prices — Involuntary Cooldown (BRO) 53 is
 *    $0.35 plain and $0.49 foil in the fixture. Every join here matches on
 *    finish as well as id. Matching on id alone silently drops the foil half of
 *    the 16 printings a real collection holds twice, and prices the survivors
 *    off the wrong ladder.
 *
 *  - A snapshot is written per REFRESH, not per day, and `recorded_on` is the
 *    date of the import that WROTE those prices, not the date they were copied
 *    (see SNAPSHOT_PRICES_SQL in lib/scryfall/sql.mjs). A card with no row on a
 *    given date has not become worthless — it simply was not re-observed, and
 *    the snapshot skips rows whose prices are all NULL. So every price lookup
 *    here is "the most recent row at or before this date", never "the row on
 *    this date". Carrying forward is the difference between a collection that
 *    holds its value through a quiet week and one that appears to crash to $0.
 *
 *  - `usd` is nullable and NULL is normal, not an error: exactly one card in a
 *    real 1457-card collection has no Scryfall price at all. Unpriced holdings
 *    are counted and surfaced rather than coerced to zero, because a total that
 *    quietly swallows them is a total nobody can reconcile against the card
 *    list.
 *
 * Ownership is NOT re-checked inside these. The page proves the collection
 * belongs to the caller first (`WHERE id = $1 AND user_id = $2`; 404 for both
 * "not yours" and "not real", so ids cannot be enumerated) and passes the
 * verified id down. `collectionId` reaches an int4 column, so it must come from
 * `parseCollectionId`: 2147483648 raises 22003 and surfaces as a 500, not a 404.
 *
 * Typed against a structural `Queryable` rather than importing `pg`, so this is
 * importable from a server component and from a test holding a bare client —
 * the same trick as lib/deck/index.ts. It is also what keeps the no-runtime-
 * imports rule in ./index.ts affordable: the one dependency these loaders
 * genuinely have is a parameter, not an import.
 */

// Explicit `.ts` — see the rule in ./index.ts. An extensionless specifier here
// typechecks and then fails under --experimental-strip-types, which resolves
// nothing.
import { parseMoney, toSeries, type SeriesPoint, type SnapshotRow } from "./series.ts";
import { toMovers, type Mover, type MoverRow } from "./movers.ts";

/* ------------------------------------------------------------------ *
 * Minimal pg-shaped interface (see lib/deck/index.ts)
 * ------------------------------------------------------------------ */

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

/**
 * Every holding, collapsed to the key prices are actually recorded against.
 *
 * GROUP BY (scryfall_id, finish) rather than one row per `collection_cards`
 * row: that table is unique on (collection_id, scryfall_id, finish, LANGUAGE),
 * so an English and a Japanese copy of one printing in one finish are two rows
 * — and `card_price_history` holds a single price covering both. Summing the
 * quantities first means each holding is looked up once and counted once;
 * leaving the rows split would double-count that printing in every "how many
 * holdings are priced" figure on the page.
 */
const HOLDINGS_CTE = `
holdings AS (
  SELECT cc.scryfall_id, cc.finish, SUM(cc.quantity)::int AS quantity
    FROM collection_cards cc
   WHERE cc.collection_id = $1
   GROUP BY cc.scryfall_id, cc.finish
)`;

/**
 * Value of the collection at every snapshot date, using the most recent price
 * at or before each date.
 *
 * The LATERAL is the carry-forward: it takes the newest row at or before the
 * date being valued, so a card the weekly refresh had nothing new to say about
 * keeps its last observed price instead of dropping out of the sum. Matching
 * `finish` inside the lateral is what keeps a foil valued as a foil.
 *
 * The date list is scoped to this collection's own holdings, so a collection is
 * never handed a data point on a date when nothing it owns was priced.
 *
 * $2 is the inclusive lower bound; NULL means everything ever recorded.
 */
export const VALUE_SERIES_SQL = `
WITH ${HOLDINGS_CTE},
snapshots AS (
  SELECT DISTINCT h.recorded_on
    FROM card_price_history h
    JOIN holdings o
      ON o.scryfall_id = h.scryfall_id
     AND o.finish      = h.finish
   WHERE $2::date IS NULL OR h.recorded_on >= $2::date
)
SELECT s.recorded_on::text                                            AS recorded_on,
       COUNT(*)::int                                                  AS holdings,
       COUNT(p.usd)::int                                              AS priced,
       COALESCE(SUM(o.quantity * p.usd), 0)::text                     AS total_usd,
       COALESCE(SUM(o.quantity) FILTER (WHERE p.usd IS NULL), 0)::int AS unpriced_cards
  FROM snapshots s
  CROSS JOIN holdings o
  LEFT JOIN LATERAL (
    SELECT h.usd
      FROM card_price_history h
     WHERE h.scryfall_id  = o.scryfall_id
       AND h.finish       = o.finish
       AND h.recorded_on <= s.recorded_on
     ORDER BY h.recorded_on DESC
     LIMIT 1
  ) p ON TRUE
 GROUP BY s.recorded_on
 ORDER BY s.recorded_on`;

export async function loadValueSeries(
  db: Queryable,
  collectionId: number,
  since: string | null,
): Promise<SeriesPoint[]> {
  const { rows } = await db.query(VALUE_SERIES_SQL, [collectionId, since]);
  return toSeries(rows as SnapshotRow[]);
}

/**
 * How far back the history goes for THIS collection.
 *
 * Cheap, and it is what lets an empty 30-day window say "there is history, just
 * not that recent" instead of "no data" — two very different messages, and only
 * one of them is true when the mirror has been refreshed twice all year.
 */
export const HISTORY_EXTENT_SQL = `
WITH ${HOLDINGS_CTE}
SELECT MIN(h.recorded_on)::text            AS first_on,
       MAX(h.recorded_on)::text            AS last_on,
       COUNT(DISTINCT h.recorded_on)::int  AS snapshots
  FROM card_price_history h
  JOIN holdings o
    ON o.scryfall_id = h.scryfall_id
   AND o.finish      = h.finish`;

export interface HistoryExtent {
  firstOn: string | null;
  lastOn: string | null;
  snapshots: number;
}

export async function loadHistoryExtent(
  db: Queryable,
  collectionId: number,
): Promise<HistoryExtent> {
  const { rows } = await db.query(HISTORY_EXTENT_SQL, [collectionId]);
  const row = rows[0] ?? {};
  return {
    firstOn: row.first_on ?? null,
    lastOn: row.last_on ?? null,
    snapshots: Number(row.snapshots) || 0,
  };
}

/**
 * Biggest movers between two snapshot dates.
 *
 * Ranked by the move across every copy owned, not by the per-card move and not
 * by percent: twelve basics that each gained 3c shift the collection more than
 * one card that doubled from $0.02, and this list exists to explain the
 * collection total. Percent rides along in its own column so a genuine
 * multiplier is still visible.
 *
 * Both ends use the same carry-forward lookup as the series, so the two views
 * cannot disagree. A holding with no price at either end is not a mover of
 * $0.00 — it is uncomparable, and it is excluded here and counted separately by
 * the page rather than being quietly dropped.
 *
 * `scryfall_cards` is LEFT JOINed because nothing FKs to it (0003): a printing
 * Scryfall has reshuffled out of the bulk file still has price history and
 * still moves, and must not vanish from this list because its name is gone.
 *
 * The two halves are ranked separately rather than by absolute size, so a week
 * where nearly everything rose still shows what fell.
 */
export const MOVERS_SQL = `
WITH ${HOLDINGS_CTE},
moved AS (
  SELECT o.scryfall_id::text AS scryfall_id,
         o.finish,
         o.quantity,
         s.name,
         s.set_code,
         s.collector_number,
         a.usd::text                    AS from_usd,
         b.usd::text                    AS to_usd,
         ((b.usd - a.usd) * o.quantity) AS delta_total
    FROM holdings o
    LEFT JOIN scryfall_cards s ON s.id = o.scryfall_id
    LEFT JOIN LATERAL (
      SELECT h.usd
        FROM card_price_history h
       WHERE h.scryfall_id  = o.scryfall_id
         AND h.finish       = o.finish
         AND h.recorded_on <= $2::date
       ORDER BY h.recorded_on DESC
       LIMIT 1
    ) a ON TRUE
    LEFT JOIN LATERAL (
      SELECT h.usd
        FROM card_price_history h
       WHERE h.scryfall_id  = o.scryfall_id
         AND h.finish       = o.finish
         AND h.recorded_on <= $3::date
       ORDER BY h.recorded_on DESC
       LIMIT 1
    ) b ON TRUE
   WHERE a.usd IS NOT NULL AND b.usd IS NOT NULL AND b.usd <> a.usd
)
(SELECT scryfall_id, finish, quantity, name, set_code, collector_number,
        from_usd, to_usd, delta_total::text AS delta_total, 'up' AS direction
   FROM moved
  WHERE delta_total > 0
  ORDER BY delta_total DESC, name NULLS LAST
  LIMIT $4)
UNION ALL
(SELECT scryfall_id, finish, quantity, name, set_code, collector_number,
        from_usd, to_usd, delta_total::text AS delta_total, 'down' AS direction
   FROM moved
  WHERE delta_total < 0
  ORDER BY delta_total ASC, name NULLS LAST
  LIMIT $4)`;

/** Rows per direction. Enough to tell a story, short enough to read. */
export const MOVERS_LIMIT = 8;

export async function loadMovers(
  db: Queryable,
  collectionId: number,
  from: string,
  to: string,
  limit: number = MOVERS_LIMIT,
): Promise<Mover[]> {
  // Bound, never interpolated — but still clamped, because an unchecked LIMIT
  // from a caller is a way to ask one page for 1457 rows of HTML.
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : MOVERS_LIMIT;
  const { rows } = await db.query(MOVERS_SQL, [collectionId, from, to, safeLimit]);
  return toMovers(rows as MoverRow[]);
}

/**
 * What the collection is worth RIGHT NOW, straight from the mirror.
 *
 * This is the number `collection_values` falls back to before any history
 * exists (0006), recomputed here for one reason: that view COALESCEs a missing
 * price to 0, so it cannot say how much of its own total is missing. During the
 * first week — when this is the only number on the page — "1 card has no
 * Scryfall price" is exactly the caveat that has to be visible.
 *
 * The CASE is the same finish ladder as `UNIT_PRICE_SQL` in
 * lib/collection/filters.ts and as 0006. It is repeated rather than imported
 * because this module cannot import anything at runtime (see the file header);
 * if that ladder ever changes, both copies change.
 */
export const CURRENT_VALUE_SQL = `
SELECT COUNT(*)::int                                                      AS holdings,
       COALESCE(SUM(cc.quantity), 0)::int                                 AS cards,
       COALESCE(SUM(cc.quantity * px.price), 0)::text                     AS total_usd,
       COUNT(*) FILTER (WHERE px.price IS NULL)::int                      AS unpriced_holdings,
       COALESCE(SUM(cc.quantity) FILTER (WHERE px.price IS NULL), 0)::int AS unpriced_cards
  FROM collection_cards cc
  LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
  CROSS JOIN LATERAL (
    SELECT CASE cc.finish
             WHEN 'foil'   THEN (s.prices->>'usd_foil')::numeric
             WHEN 'etched' THEN (s.prices->>'usd_etched')::numeric
             ELSE (s.prices->>'usd')::numeric
           END AS price
  ) px
 WHERE cc.collection_id = $1`;

export interface CurrentValue {
  holdings: number;
  cards: number;
  total: number;
  unpricedHoldings: number;
  unpricedCards: number;
}

export async function loadCurrentValue(
  db: Queryable,
  collectionId: number,
): Promise<CurrentValue> {
  const { rows } = await db.query(CURRENT_VALUE_SQL, [collectionId]);
  const row = rows[0] ?? {};
  return {
    holdings: Number(row.holdings) || 0,
    cards: Number(row.cards) || 0,
    total: parseMoney(row.total_usd) ?? 0,
    unpricedHoldings: Number(row.unpriced_holdings) || 0,
    unpricedCards: Number(row.unpriced_cards) || 0,
  };
}

/**
 * The mirror's refresh record, which is what dates the empty state.
 *
 * "No history yet" is only half an answer; the useful half is when that
 * changes, and that is a function of how many times the bulk import has
 * SUCCEEDED — once means the next run writes the first snapshot, zero means the
 * mirror has never been pulled at all. Failed runs are excluded for the same
 * reason `LAST_SUCCESSFUL_IMPORT_SQL` excludes them: a failure preserved
 * nothing.
 */
export const REFRESH_STATE_SQL = `
SELECT COUNT(*)::int                                     AS runs,
       (MAX(finished_at) AT TIME ZONE 'UTC')::date::text AS last_on
  FROM scryfall_bulk_imports
 WHERE status = 'ok'`;

export interface RefreshState {
  runs: number;
  lastOn: string | null;
}

export async function loadRefreshState(db: Queryable): Promise<RefreshState> {
  const { rows } = await db.query(REFRESH_STATE_SQL, []);
  const row = rows[0] ?? {};
  return { runs: Number(row.runs) || 0, lastOn: row.last_on ?? null };
}
