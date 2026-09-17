/**
 * Chart geometry — pure numbers in, SVG coordinates out.
 *
 * No markup and no React: the page owns the elements, this owns the arithmetic.
 * That is what lets test/prices.test.ts assert on exact path coordinates and on
 * tick values without rendering anything, and it is why the chart is inline SVG
 * from pure functions rather than a charting library.
 */

// The `.ts` is not optional: test/prices.test.ts reaches this file through
// Node's --experimental-strip-types, which performs no module resolution, so an
// extensionless `from "./series"` typechecks cleanly and then dies at runtime
// with ERR_MODULE_NOT_FOUND. Same rule as the re-exports in ./index.ts.
import { dayMs, strideIndices, type SeriesPoint } from "./series.ts";

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
