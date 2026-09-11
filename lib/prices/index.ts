/**
 * Price history: the reads behind `/collections/[id]/prices`, plus the pure
 * shaping and SVG geometry the page renders from.
 *
 * Everything here is either a SQL builder or a pure function of numbers, so the
 * chart is testable without a Postgres — series maths, percent change and the
 * path strings themselves are all exercised by test/prices.test.ts.
 *
 * Three schema facts drive every query below:
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
 * Every price in this app is Scryfall market (TCGplayer market, from `usd` /
 * `usd_foil`), the same source `collection_values` and the collection browser
 * use. Nothing here mixes in a retailer ladder, and nothing here is a sale
 * price.
 *
 * Typed against a structural `Queryable` rather than importing `pg`, so this is
 * importable from a server component and from a test holding a bare client —
 * the same trick as lib/deck/index.ts.
 *
 * This module deliberately imports NOTHING at runtime. test/prices.test.ts
 * loads it through Node's --experimental-strip-types, which performs no module
 * resolution: a single extensionless `import { UNIT_PRICE_SQL } from
 * "../collection/filters"` here would kill every pure test in that file with
 * ERR_MODULE_NOT_FOUND. Type-only imports are erased and are fine.
 */

/* ------------------------------------------------------------------ *
 * Minimal pg-shaped interface (see lib/deck/index.ts)
 * ------------------------------------------------------------------ */

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

export type WindowKey = "30d" | "90d" | "1y" | "all";

/** Selectable ranges. `days: null` means "everything recorded". */
export const WINDOWS: ReadonlyArray<{ key: WindowKey; label: string; days: number | null }> = [
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "1y", label: "1 year", days: 365 },
  { key: "all", label: "All", days: null },
];

const WINDOW_DAYS: Record<WindowKey, number | null> = Object.assign(
  Object.create(null) as Record<WindowKey, number | null>,
  { "30d": 30, "90d": 90, "1y": 365, all: null },
);

/** Default when no window is asked for: long enough to hold ~13 weekly
 *  snapshots, short enough that a move is still recent news. */
export const DEFAULT_WINDOW: WindowKey = "90d";

/**
 * Read the window out of a query string.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `?sort=
 * constructor` passed exactly this kind of guard on the collection browser and
 * reached ORDER BY as a 500 (see lib/collection/filters.ts). Nothing
 * user-supplied indexes a lookup table here without that check, even though
 * this one only picks a number of days.
 */
export function parseWindow(raw: string | string[] | undefined): WindowKey {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return Object.hasOwn(WINDOW_DAYS, value) ? (value as WindowKey) : DEFAULT_WINDOW;
}

export function windowDays(key: WindowKey): number | null {
  return Object.hasOwn(WINDOW_DAYS, key) ? WINDOW_DAYS[key] : null;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` -> epoch ms at UTC midnight, or NaN if it is not a plain date. */
export function dayMs(iso: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : NaN;
}

/**
 * The `>= this date` bound for a window, as a plain `YYYY-MM-DD` string.
 *
 * Pinned to UTC, exactly as `recorded_on` is when the snapshot writes it: doing
 * this in local time means a container in UTC-5 asks for a different 30 days
 * than the one that wrote the rows, and the earliest point drifts in and out of
 * the chart depending on the hour the page is loaded.
 */
export function windowStart(todayIso: string, days: number | null): string | null {
  if (days === null) return null;
  const today = dayMs(todayIso);
  if (!Number.isFinite(today) || !Number.isFinite(days)) return null;
  return new Date(today - days * DAY_MS).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Money and change
 * ------------------------------------------------------------------ */

/**
 * NUMERIC columns arrive from `pg` as strings so no cent is lost to a float on
 * the way out (`usd()` in app/_ui.tsx says the same about display). Parse once,
 * here, for arithmetic — and return null rather than NaN for "no price", so a
 * missing price can never be summed into a total as 0 by accident.
 */
export function parseMoney(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Fractional change from `from` to `to` — 0.05 is +5%.
 *
 * Null whenever the baseline cannot carry a percentage: no starting price at
 * all, or a starting price of exactly $0.00 (the fixture holds one, and real
 * bulk commons sit at 0.00 regularly). "Went from nothing to something" is an
 * infinite percentage, and +Infinity%, NaN% and a silent 0% are all lies.
 * Callers show the dollar move and a dash instead.
 */
export function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return (to - from) / Math.abs(from);
}

/** `+4.1%` / `-12.0%` / `—`. The sign is always explicit, so direction never
 *  has to be inferred from colour. */
export function formatPct(pct: number | null, digits = 1): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct * 100).toFixed(digits)}%`;
}

/** `Sep 10` — axis and table dates. Formatted in UTC so the label matches the
 *  `recorded_on` date rather than the viewer's timezone. */
export function formatDay(iso: string): string {
  const ms = dayMs(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/* ------------------------------------------------------------------ *
 * The value series
 * ------------------------------------------------------------------ */

export interface SnapshotRow extends Record<string, unknown> {
  recorded_on: string;
  total_usd: string;
  holdings: number;
  priced: number;
  unpriced_cards: number;
}

export interface SeriesPoint {
  /** `YYYY-MM-DD`, the snapshot's `recorded_on`. */
  date: string;
  /** Collection value in USD at that snapshot. */
  total: number;
  /** Distinct (printing, finish) holdings in the collection. */
  holdings: number;
  /** How many of those had a known price at that date. */
  priced: number;
  /** Physical cards contributing nothing because their price is unknown. */
  unpricedCards: number;
}

export function toSeries(rows: readonly SnapshotRow[]): SeriesPoint[] {
  return rows.map((row) => ({
    date: String(row.recorded_on),
    total: parseMoney(row.total_usd) ?? 0,
    holdings: Number(row.holdings) || 0,
    priced: Number(row.priced) || 0,
    unpricedCards: Number(row.unpriced_cards) || 0,
  }));
}

/**
 * What the page is allowed to draw.
 *
 * The honest empty states are the common case for the first fortnight of an
 * install, so they are a first-class result rather than a fallback branch:
 *
 *  - `empty`    — no snapshot covers this collection. History only starts on the
 *                 SECOND refresh (the first has no outgoing prices to preserve),
 *                 so this is what a new install sees for a week.
 *  - `single`   — one snapshot. A line needs two dated points; one point is not
 *                 a trend, and drawing it as one implies a flat stretch nobody
 *                 observed.
 *  - `unpriced` — snapshots exist but not one holding has a price in any of
 *                 them, so every total is $0.00. That is a mirror problem, not a
 *                 collection worth nothing, and a chart of zeroes says the
 *                 opposite.
 *  - `ok`       — two or more points with real money in them.
 */
export type SeriesStatus = "empty" | "single" | "unpriced" | "ok";

export function seriesStatus(points: readonly SeriesPoint[]): SeriesStatus {
  if (points.length === 0) return "empty";
  if (points.every((p) => p.priced === 0)) return "unpriced";
  return points.length === 1 ? "single" : "ok";
}

export interface SeriesSummary {
  first: SeriesPoint;
  last: SeriesPoint;
  /** Dollar change across the window. */
  delta: number;
  /** Fractional change; null when the first point is $0.00 (see pctChange). */
  pct: number | null;
  min: number;
  max: number;
  /** Physical cards with no known price at the latest point. */
  unpricedCards: number;
}

export function summarise(points: readonly SeriesPoint[]): SeriesSummary | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const totals = points.map((p) => p.total);
  return {
    first,
    last,
    delta: last.total - first.total,
    pct: pctChange(first.total, last.total),
    min: Math.min(...totals),
    max: Math.max(...totals),
    unpricedCards: last.unpricedCards,
  };
}

/**
 * Evenly spread `k` indices across `n`, always keeping both ends.
 *
 * Shared by the downsampler and the x-axis labeller so a thinned chart and its
 * date labels cannot disagree about which points exist.
 */
export function strideIndices(n: number, k: number): number[] {
  if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(k) || k <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  if (k === 1) return [0];
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) picked.add(Math.round((i * (n - 1)) / (k - 1)));
  return [...picked].sort((a, b) => a - b);
}

/**
 * Thin a long series to at most `max` points, keeping the first and the last.
 *
 * Weekly snapshots only reach ~52 points a year, so this does nothing for years
 * — but a daily cron would put 1000+ points behind an 800px plot, where they
 * stop being distinguishable marks and become a smear that also triples the
 * served HTML.
 */
export function downsample(points: readonly SeriesPoint[], max: number): SeriesPoint[] {
  if (points.length <= max) return [...points];
  return strideIndices(points.length, max).map((i) => points[i]!);
}

/* ------------------------------------------------------------------ *
 * Chart geometry — pure numbers in, SVG coordinates out
 * ------------------------------------------------------------------ */

/** Round to 2dp. Keeps generated paths short and, more usefully, keeps them
 *  stable enough for a test to assert on. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Tick values at 1 / 2 / 2.5 / 5 × 10ⁿ, inside [min, max].
 *
 * Money axes read badly on raw data bounds: "$1138.72 · $1173.19 · $1207.66" is
 * three numbers nobody can compare at a glance.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 1) return [];
  if (max <= min) return [r2(min)];

  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
    magnitude;

  const out: number[] = [];
  const firstTick = Math.ceil(min / step);
  // Counted, not `while (value <= max)`: a pathological step — a denormal
  // range, an Infinity that slipped past the guard above — must not spin
  // forever inside a request.
  for (let i = firstTick; i <= firstTick + 100; i++) {
    const value = i * step;
    if (value > max + step * 1e-9) break;
    out.push(r2(value));
  }
  return out;
}

export interface ChartOptions {
  width?: number;
  height?: number;
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
  /** Target number of y gridlines. */
  tickCount?: number;
  /** Target number of dated x labels. */
  xLabelCount?: number;
}

export interface ChartPointGeometry {
  x: number;
  y: number;
  point: SeriesPoint;
}

export interface ChartGeometry {
  width: number;
  height: number;
  plot: { x: number; y: number; w: number; h: number };
  points: ChartPointGeometry[];
  /** `M x y L x y …`. Empty for a single point — one dot is not a line. */
  linePath: string;
  yTicks: Array<{ y: number; value: number }>;
  xTicks: Array<{ x: number; date: string }>;
  /** Hit-target width per point for the hover layer, never below 24px. */
  band: number;
  /** [low, high] of the y axis. Not anchored to zero — the page says so. */
  domain: [number, number];
  /** True when the x axis fell back to index spacing (see below). */
  indexed: boolean;
}

/**
 * Turn a series into SVG coordinates.
 *
 * `null` for an empty series: the caller has to render an explanation, never an
 * axis with nothing on it.
 *
 * The x axis is proportional to TIME, not to index. A skipped weekly refresh is
 * a two-week gap in the data and has to look like one; spacing points evenly
 * would draw that fortnight as an ordinary week and overstate every slope
 * around it.
 */
export function buildChart(
  points: readonly SeriesPoint[],
  options: ChartOptions = {},
): ChartGeometry | null {
  if (points.length === 0) return null;

  const {
    width = 880,
    height = 260,
    padLeft = 68,
    padRight = 92,
    padTop = 18,
    padBottom = 26,
    tickCount = 4,
    xLabelCount = 5,
  } = options;

  const plot = {
    x: padLeft,
    y: padTop,
    w: Math.max(1, width - padLeft - padRight),
    h: Math.max(1, height - padTop - padBottom),
  };

  const totals = points.map((p) => p.total);
  const low = Math.min(...totals);
  const high = Math.max(...totals);

  // A dead-flat series (one point, or a week where nothing moved) has zero
  // range, and dividing by it puts every y at NaN and empties the path. Give it
  // a symmetric band instead, so the line sits mid-plot and reads as flat.
  const span = high - low;
  const pad = span === 0 ? Math.max(Math.abs(high) * 0.05, 1) : span * 0.08;
  const ticks = niceTicks(low - pad, high + pad, tickCount);
  const domainLow = Math.min(low - pad, ticks[0] ?? low - pad);
  const domainHigh = Math.max(high + pad, ticks[ticks.length - 1] ?? high + pad);
  const domainSpan = domainHigh - domainLow || 1;

  const times = points.map((p) => dayMs(p.date));
  const timeSpan = times[times.length - 1]! - times[0]!;
  // Index spacing is the fallback for when the dates cannot carry the axis: an
  // unparseable `recorded_on`, or every point landing on one day. Better an
  // evenly spaced chart than a path full of NaNs, which renders as nothing.
  const indexed = !times.every((t) => Number.isFinite(t)) || !(timeSpan > 0);

  const xAt = (i: number): number => {
    if (points.length === 1) return plot.x + plot.w / 2;
    if (indexed) return plot.x + (plot.w * i) / (points.length - 1);
    return plot.x + (plot.w * (times[i]! - times[0]!)) / timeSpan;
  };
  const yAt = (value: number): number =>
    plot.y + plot.h * (1 - (value - domainLow) / domainSpan);

  const geometry: ChartPointGeometry[] = points.map((point, i) => ({
    x: r2(xAt(i)),
    y: r2(yAt(point.total)),
    point,
  }));

  const linePath =
    geometry.length < 2
      ? ""
      : geometry.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");

  return {
    width,
    height,
    plot,
    points: geometry,
    linePath,
    yTicks: ticks.map((value) => ({ y: r2(yAt(value)), value })),
    xTicks: strideIndices(points.length, xLabelCount).map((i) => ({
      x: geometry[i]!.x,
      date: points[i]!.date,
    })),
    band: Math.max(24, plot.w / Math.max(1, points.length)),
    domain: [domainLow, domainHigh],
    indexed,
  };
}

/**
 * Bar lengths for the movers list, scaled to the largest move in the set.
 *
 * Magnitudes only — direction is carried by the arrow, then the sign, then the
 * colour, never by the bar. A zero or unusable magnitude gets no bar at all;
 * anything real gets at least 2px, because a 0.3px sliver reads as "no change"
 * while the number beside it says otherwise.
 */
export function barWidths(magnitudes: readonly number[], maxWidth: number): number[] {
  const usable = magnitudes.map((m) => (Number.isFinite(m) ? Math.abs(m) : 0));
  const largest = Math.max(0, ...usable);
  if (largest === 0 || !Number.isFinite(maxWidth) || maxWidth <= 0) return usable.map(() => 0);
  return usable.map((m) => (m === 0 ? 0 : Math.max(2, r2((m / largest) * maxWidth))));
}

/* ------------------------------------------------------------------ *
 * Movers
 * ------------------------------------------------------------------ */

export interface MoverRow extends Record<string, unknown> {
  scryfall_id: string;
  finish: string;
  quantity: number;
  name: string | null;
  set_code: string | null;
  collector_number: string | null;
  from_usd: string | null;
  to_usd: string | null;
  delta_total: string | null;
  direction: string;
}

export interface Mover {
  /**
   * `<scryfall_id>|<finish>` — the real identity of a holding, and the React
   * key. A printing held both plain and foil is TWO movers that can move in
   * opposite directions; keying on the id alone collapses them into one row and
   * keeps whichever was written second.
   */
  key: string;
  scryfallId: string;
  finish: string;
  quantity: number;
  /** Null only when the mirror no longer has the printing — there is no FK. */
  name: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  /** Unit price at the start of the window. */
  from: number | null;
  /** Unit price at the end of the window. */
  to: number | null;
  /** Per-card move. */
  deltaUnit: number | null;
  /** Move across every copy owned — what actually shifted the collection total. */
  deltaTotal: number;
  pct: number | null;
  direction: "up" | "down";
}

export function toMovers(rows: readonly MoverRow[]): Mover[] {
  return rows.map((row) => {
    const from = parseMoney(row.from_usd);
    const to = parseMoney(row.to_usd);
    const deltaTotal = parseMoney(row.delta_total) ?? 0;
    return {
      key: `${row.scryfall_id}|${row.finish}`,
      scryfallId: String(row.scryfall_id),
      finish: String(row.finish),
      quantity: Number(row.quantity) || 0,
      name: row.name ?? null,
      setCode: row.set_code ?? null,
      collectorNumber: row.collector_number ?? null,
      from,
      to,
      deltaUnit: from !== null && to !== null ? to - from : null,
      deltaTotal,
      pct: pctChange(from, to),
      direction: deltaTotal < 0 ? "down" : "up",
    };
  });
}

/** Split a mixed list, preserving the order SQL ranked them in. */
export function splitMovers(movers: readonly Mover[]): { up: Mover[]; down: Mover[] } {
  return {
    up: movers.filter((m) => m.direction === "up"),
    down: movers.filter((m) => m.direction === "down"),
  };
}

/**
 * What the listed movers add up to.
 *
 * Shown beside the window's total change so it is obvious how much of the swing
 * these rows explain and how much is the long tail — a top-eight list that
 * accounts for $4 of a $40 move must not read as the whole story.
 */
export function moversTotal(movers: readonly Mover[]): number {
  return movers.reduce((sum, m) => sum + m.deltaTotal, 0);
}

/* ------------------------------------------------------------------ *
 * Queries
 *
 * Ownership is NOT re-checked inside these. The page proves the collection
 * belongs to the caller first (`WHERE id = $1 AND user_id = $2`; 404 for both
 * "not yours" and "not real", so ids cannot be enumerated) and passes the
 * verified id down. `collectionId` reaches an int4 column, so it must come from
 * `parseCollectionId`: 2147483648 raises 22003 and surfaces as a 500, not a 404.
 * ------------------------------------------------------------------ */

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
