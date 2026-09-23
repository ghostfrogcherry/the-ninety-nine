/**
 * The value series: windows, money, and the points the chart is drawn from.
 *
 * Pure functions of numbers and of rows `pg` has already handed over — no SQL
 * and no geometry. What a price MEANS lives here and only here (a missing price
 * is not zero, a $0.00 baseline carries no percentage, a date is UTC), because
 * the chart, the movers list and the loaders all have to agree about it: two
 * copies of the "is this comparable" rule is how a page ends up reporting a
 * -100% crash for a card nobody re-observed.
 *
 * Imports nothing at runtime, like every file in lib/prices — see ./index.ts.
 */

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
