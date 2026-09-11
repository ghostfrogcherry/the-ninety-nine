/**
 * Price-history tests — `lib/prices/index.ts`.
 *
 *   npm test
 *
 * The pure tests always run. The database tests run only when
 * TEST_DATABASE_URL is set, e.g.
 *
 *   docker run -d --name nn-prices-test -p 55437:5432 \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=ninetynine -e POSTGRES_USER=ninetynine \
 *     postgres:17-alpine
 *   # the image runs a TEMPORARY server during init and then restarts, so
 *   # pg_isready can pass before the real server exists. Poll a real query:
 *   until docker exec nn-prices-test psql -U ninetynine -d ninetynine -c 'SELECT 1'; do sleep 1; done
 *   for f in db/migrations/*.sql; do
 *     docker exec -i nn-prices-test psql -v ON_ERROR_STOP=1 -U ninetynine -d ninetynine < "$f"
 *   done
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55437/ninetynine \
 *     node --experimental-strip-types --test test/prices.test.ts
 *
 * A DEDICATED variable, not DATABASE_URL: these tests insert placeholder rows
 * into `scryfall_cards` and `card_price_history` and must never be able to do
 * that to a real instance by inheriting the app's environment. Same rule as
 * test/import.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import pg from "pg";

/**
 * Types come from an extensionless import (erased at runtime, and resolved fine
 * by moduleResolution "bundler"); the values come from a dynamic import whose
 * specifier is a variable, which TypeScript does not try to resolve. Full type
 * checking, and it still runs under Node's type stripping, which needs the
 * real `.ts` extension. Same idiom as test/deck.test.ts.
 */
import type * as PricesModule from "../lib/prices";
import type { Mover, MoverRow, SeriesPoint, SnapshotRow } from "../lib/prices";

const pricesSpecifier = "../lib/prices/index.ts";

const {
  CURRENT_VALUE_SQL,
  DEFAULT_WINDOW,
  MOVERS_LIMIT,
  MOVERS_SQL,
  VALUE_SERIES_SQL,
  WINDOWS,
  barWidths,
  buildChart,
  dayMs,
  downsample,
  formatDay,
  formatPct,
  loadCurrentValue,
  loadHistoryExtent,
  loadMovers,
  loadRefreshState,
  loadValueSeries,
  moversTotal,
  niceTicks,
  parseMoney,
  parseWindow,
  pctChange,
  seriesStatus,
  splitMovers,
  strideIndices,
  summarise,
  toMovers,
  toSeries,
  windowDays,
  windowStart,
} = (await import(pricesSpecifier)) as typeof PricesModule;

const REPO = path.resolve(import.meta.dirname, "..");

// Synthetic mirror fixture — public card names, deterministic fake UUIDs.
// Regenerate with `node scripts/make-example-fixture.mjs`. Used here for the
// three cases price history is hard on: a printing that exists in BOTH finishes
// at different prices, a card whose `usd` is null, and a card priced at exactly
// "0.00" (which is a legal price and an illegal percentage baseline).
const MIRROR_JSON = path.join(REPO, "db/seed/example-mirror.json");

/** Fixture ids, by what each one exercises. */
const COOLDOWN = "8de33233-37db-47aa-b911-5c6fea39d8dd"; // BRO 53, $0.35 / $0.49 foil
const FOREST = "b880fc18-518c-40cd-9356-5797af4c1617"; // ZNR 280, cheap and numerous
const ARAHBO = "7549577b-19e5-4565-9b3d-686a285c312b"; // usd is null
const SOL_RING = "da515159-8de8-40a1-a62c-b96645939ad9"; // C19 221
const BLACK_LOTUS = "19c5899a-eef1-4dd3-a6ef-a8502cf02dc5"; // priced "0.00"
const COUNTERSPELL = "89971ab8-69b0-4a03-9e54-57195872710e";

/** A snapshot row as `pg` hands it over: NUMERIC and DATE both arrive as text. */
function snap(
  date: string,
  total: string,
  over: Partial<SnapshotRow> = {},
): SnapshotRow {
  return {
    recorded_on: date,
    total_usd: total,
    holdings: 3,
    priced: 3,
    unpriced_cards: 0,
    ...over,
  };
}

function point(date: string, total: number, over: Partial<SeriesPoint> = {}): SeriesPoint {
  return { date, total, holdings: 3, priced: 3, unpricedCards: 0, ...over };
}

function moverRow(over: Partial<MoverRow> = {}): MoverRow {
  return {
    scryfall_id: COOLDOWN,
    finish: "nonfoil",
    quantity: 1,
    name: "Involuntary Cooldown",
    set_code: "bro",
    collector_number: "53",
    from_usd: "0.30",
    to_usd: "0.35",
    delta_total: "0.05",
    direction: "up",
    ...over,
  };
}

/* ================================================================== *
 * Windows
 * ================================================================== */

describe("parseWindow", () => {
  it("accepts every documented key", () => {
    for (const w of WINDOWS) assert.equal(parseWindow(w.key), w.key);
  });

  it("falls back to the default for anything unknown", () => {
    assert.equal(parseWindow("7d"), DEFAULT_WINDOW);
    assert.equal(parseWindow(""), DEFAULT_WINDOW);
    assert.equal(parseWindow(undefined), DEFAULT_WINDOW);
  });

  it("does not accept an inherited key", () => {
    // `in` walks the prototype chain; `Object.hasOwn` does not. ?sort=constructor
    // reaching ORDER BY was a real 500 on the collection browser, and this is
    // the same guard in the same shape.
    assert.equal(parseWindow("constructor"), DEFAULT_WINDOW);
    assert.equal(parseWindow("__proto__"), DEFAULT_WINDOW);
    assert.equal(parseWindow("toString"), DEFAULT_WINDOW);
    assert.equal(windowDays("hasOwnProperty" as never), null);
  });

  it("takes the first element of a repeated param", () => {
    assert.equal(parseWindow(["30d", "1y"]), "30d");
  });
});

describe("windowStart", () => {
  it("counts back in whole UTC days", () => {
    assert.equal(windowStart("2026-03-15", 30), "2026-02-13");
    assert.equal(windowStart("2026-01-01", 1), "2025-12-31");
  });

  it("crosses a leap day without drifting", () => {
    assert.equal(windowStart("2028-03-01", 1), "2028-02-29");
  });

  it("returns null for 'all', which has no lower bound", () => {
    assert.equal(windowStart("2026-03-15", null), null);
  });

  it("returns null rather than an Invalid Date string for junk", () => {
    assert.equal(windowStart("not-a-date", 30), null);
    assert.equal(windowStart("2026-3-5", 30), null);
  });
});

/* ================================================================== *
 * Money and change
 * ================================================================== */

describe("parseMoney", () => {
  it("parses the strings pg returns for NUMERIC", () => {
    assert.equal(parseMoney("1139.26"), 1139.26);
    assert.equal(parseMoney("0.00"), 0);
    assert.equal(parseMoney("-5.00"), -5);
  });

  it("distinguishes a missing price from zero", () => {
    // The whole point: NULL must not become 0, or one unpriced card in 1457
    // quietly becomes a card worth nothing.
    assert.equal(parseMoney(null), null);
    assert.equal(parseMoney(undefined), null);
    assert.equal(parseMoney(""), null);
    assert.equal(parseMoney("0.00"), 0);
  });

  it("returns null, never NaN, for a non-numeric string", () => {
    assert.equal(parseMoney("n/a"), null);
    assert.equal(parseMoney(Number.NaN), null);
    assert.equal(parseMoney(Number.POSITIVE_INFINITY), null);
  });
});

describe("pctChange", () => {
  it("computes an ordinary rise and fall", () => {
    assert.equal(pctChange(1.0, 1.5), 0.5);
    assert.equal(pctChange(2.0, 1.5), -0.25);
    assert.equal(pctChange(1.0, 1.0), 0);
  });

  it("is null from a $0.00 baseline — the division-by-zero case", () => {
    // Not hypothetical: the fixture holds a card priced exactly "0.00", and
    // real bulk commons sit there. 0 -> 0.99 is an infinite percentage, so the
    // dollar move is the only honest answer.
    assert.equal(pctChange(0, 0.99), null);
    assert.equal(pctChange(0, 0), null);
    assert.equal(pctChange(-0, 5), null);
  });

  it("is null when either end is unknown", () => {
    assert.equal(pctChange(null, 1.5), null);
    assert.equal(pctChange(1.5, null), null);
    assert.equal(pctChange(null, null), null);
  });

  it("reaches exactly -100% when a price falls to zero", () => {
    assert.equal(pctChange(5, 0), -1);
    assert.equal(formatPct(pctChange(5, 0)), "-100.0%");
  });
});

describe("formatPct", () => {
  it("always carries an explicit sign, so colour is never the only cue", () => {
    assert.equal(formatPct(0.041), "+4.1%");
    assert.equal(formatPct(-0.12), "-12.0%");
    assert.equal(formatPct(0), "0.0%");
  });

  it("renders an impossible percentage as a dash", () => {
    assert.equal(formatPct(null), "—");
    assert.equal(formatPct(Number.POSITIVE_INFINITY), "—");
    assert.equal(formatPct(Number.NaN), "—");
  });
});

describe("dayMs / formatDay", () => {
  it("reads a plain date as UTC midnight", () => {
    assert.equal(dayMs("2026-09-10"), Date.UTC(2026, 8, 10));
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    // `recorded_on` is cast to ::text in SQL precisely so this is all it ever
    // sees; a timestamp would land the label on the wrong day west of UTC.
    assert.ok(Number.isNaN(dayMs("2026-09-10T00:00:00Z")));
    assert.ok(Number.isNaN(dayMs("")));
  });

  it("labels the date it was given, not the viewer's local day", () => {
    assert.equal(formatDay("2026-09-10"), "Sep 10");
    assert.equal(formatDay("2026-01-01"), "Jan 1");
  });

  it("passes an unparseable date through rather than printing NaN", () => {
    assert.equal(formatDay("whenever"), "whenever");
  });
});

/* ================================================================== *
 * Series shaping
 * ================================================================== */

describe("toSeries", () => {
  it("parses the row shape pg returns", () => {
    const series = toSeries([snap("2026-01-01", "10.20"), snap("2026-01-08", "10.39")]);
    assert.deepEqual(
      series.map((p) => [p.date, p.total]),
      [
        ["2026-01-01", 10.2],
        ["2026-01-08", 10.39],
      ],
    );
  });

  it("carries the unpriced counts through instead of dropping them", () => {
    const [p] = toSeries([snap("2026-01-01", "10.20", { holdings: 7, priced: 6, unpriced_cards: 1 })]);
    assert.equal(p!.holdings, 7);
    assert.equal(p!.priced, 6);
    assert.equal(p!.unpricedCards, 1);
  });
});

describe("seriesStatus — the empty states are results, not fallbacks", () => {
  it("is `empty` with no snapshots at all", () => {
    // The common case for a week after install: history only starts on the
    // SECOND refresh, because the first has no outgoing prices to preserve.
    assert.equal(seriesStatus([]), "empty");
  });

  it("is `single` with exactly one snapshot", () => {
    // One dated point is not a trend. Drawing it as a line implies a flat
    // stretch nobody observed.
    assert.equal(seriesStatus([point("2026-01-01", 10.2)]), "single");
  });

  it("is `unpriced` when snapshots exist but nothing in them has a price", () => {
    // Every total would be $0.00. That is a mirror problem, and a chart of
    // zeroes claims the collection is worthless.
    const dead = [
      point("2026-01-01", 0, { priced: 0, unpricedCards: 7 }),
      point("2026-01-08", 0, { priced: 0, unpricedCards: 7 }),
    ];
    assert.equal(seriesStatus(dead), "unpriced");
  });

  it("is `ok` as soon as two points hold real money", () => {
    assert.equal(seriesStatus([point("2026-01-01", 10.2), point("2026-01-08", 10.39)]), "ok");
  });

  it("prefers `unpriced` over `single` — a lone $0.00 point is still nothing to draw", () => {
    assert.equal(seriesStatus([point("2026-01-01", 0, { priced: 0 })]), "unpriced");
  });
});

describe("summarise", () => {
  it("returns null for an empty series rather than a zeroed summary", () => {
    assert.equal(summarise([]), null);
  });

  it("reports change from the first point to the last", () => {
    const s = summarise([point("2026-01-01", 10.2), point("2026-01-08", 10.39), point("2026-01-15", 8.2)]);
    assert.ok(s);
    assert.equal(s.first.date, "2026-01-01");
    assert.equal(s.last.date, "2026-01-15");
    assert.equal(Math.round(s.delta * 100) / 100, -2);
    assert.equal(s.min, 8.2);
    assert.equal(s.max, 10.39);
  });

  it("reports a single point as no change, not as growth from zero", () => {
    const s = summarise([point("2026-01-01", 10.2)]);
    assert.ok(s);
    assert.equal(s.delta, 0);
    assert.equal(s.pct, 0);
  });

  it("has no percentage when the collection started at $0.00", () => {
    const s = summarise([point("2026-01-01", 0, { priced: 1 }), point("2026-01-08", 4)]);
    assert.equal(s?.pct, null);
    assert.equal(s?.delta, 4);
  });
});

describe("strideIndices / downsample", () => {
  it("keeps everything when the series is already short enough", () => {
    assert.deepEqual(strideIndices(3, 5), [0, 1, 2]);
    const points = [point("2026-01-01", 1), point("2026-01-08", 2)];
    assert.deepEqual(downsample(points, 10), points);
  });

  it("always keeps both ends", () => {
    const picked = strideIndices(100, 5);
    assert.equal(picked[0], 0);
    assert.equal(picked[picked.length - 1], 99);
    assert.ok(picked.length <= 5);
  });

  it("thins a long series without reordering it", () => {
    const long = Array.from({ length: 500 }, (_, i) =>
      point(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, i),
    );
    const thin = downsample(long, 60);
    assert.ok(thin.length <= 60);
    assert.equal(thin[0]!.total, 0);
    assert.equal(thin[thin.length - 1]!.total, 499);
    assert.deepEqual([...thin].sort((a, b) => a.total - b.total), thin);
  });

  it("degrades safely on nonsense counts", () => {
    assert.deepEqual(strideIndices(0, 5), []);
    assert.deepEqual(strideIndices(10, 0), []);
    assert.deepEqual(strideIndices(10, 1), [0]);
    assert.deepEqual(strideIndices(2.5 as number, 5), []);
  });
});

/* ================================================================== *
 * Geometry
 * ================================================================== */

describe("niceTicks", () => {
  it("lands on round numbers inside the range", () => {
    assert.deepEqual(niceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
    assert.deepEqual(niceTicks(1100, 1200, 4), [1100, 1125, 1150, 1175, 1200]);
  });

  it("never steps outside the range it was given", () => {
    for (const t of niceTicks(1138.72, 1207.66, 4)) {
      assert.ok(t >= 1138.72 && t <= 1207.66, `${t} outside range`);
    }
  });

  it("collapses to a single tick when there is no range", () => {
    assert.deepEqual(niceTicks(5, 5, 4), [5]);
    assert.deepEqual(niceTicks(5, 4, 4), [5]);
  });

  it("returns nothing rather than looping on unusable input", () => {
    assert.deepEqual(niceTicks(Number.NaN, 10, 4), []);
    assert.deepEqual(niceTicks(0, Number.POSITIVE_INFINITY, 4), []);
    assert.deepEqual(niceTicks(0, 100, 0), []);
  });
});

describe("buildChart", () => {
  const three = [
    point("2026-01-01", 10.2),
    point("2026-01-08", 10.39),
    point("2026-01-15", 8.2),
  ];

  it("returns null for an empty series", () => {
    // The page has to explain itself instead of drawing an empty axis.
    assert.equal(buildChart([]), null);
  });

  it("draws no line for a single point", () => {
    // One dot is not a line, and a one-point path implies a flat week.
    const chart = buildChart([point("2026-01-01", 10.2)]);
    assert.ok(chart);
    assert.equal(chart.linePath, "");
    assert.equal(chart.points.length, 1);
    assert.equal(chart.points[0]!.x, chart.plot.x + chart.plot.w / 2);
    assert.ok(Number.isFinite(chart.points[0]!.y));
  });

  it("keeps every coordinate finite when the series is dead flat", () => {
    // Zero range divides by zero; the fallback band is what stops the whole
    // path coming out as `M NaN NaN`, which renders as nothing at all.
    const chart = buildChart([point("2026-01-01", 40), point("2026-01-08", 40)]);
    assert.ok(chart);
    for (const p of chart.points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
    assert.ok(chart.domain[0] < chart.domain[1]);
    assert.match(chart.linePath, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
  });

  it("keeps coordinates finite when every total is zero", () => {
    const chart = buildChart([
      point("2026-01-01", 0, { priced: 0 }),
      point("2026-01-08", 0, { priced: 0 }),
    ]);
    assert.ok(chart);
    for (const p of chart.points) assert.ok(Number.isFinite(p.y));
  });

  it("spaces x by time, not by index", () => {
    // A skipped weekly refresh is a two-week gap and has to look like one;
    // even spacing would draw that fortnight as an ordinary week and overstate
    // the slope on either side of it.
    const gapped = buildChart([
      point("2026-01-01", 10),
      point("2026-01-08", 11),
      point("2026-01-29", 12),
    ]);
    assert.ok(gapped);
    assert.equal(gapped.indexed, false);
    const [a, b, c] = gapped.points;
    assert.ok(b!.x - a!.x < c!.x - b!.x);
  });

  it("falls back to index spacing when the dates cannot carry the axis", () => {
    const same = buildChart([point("2026-01-01", 10), point("2026-01-01", 11)]);
    assert.ok(same);
    assert.equal(same.indexed, true);
    assert.equal(same.points[0]!.x, same.plot.x);
    assert.equal(same.points[1]!.x, same.plot.x + same.plot.w);
  });

  it("puts the highest value at the top of the plot", () => {
    const chart = buildChart(three);
    assert.ok(chart);
    const highest = chart.points[1]!; // 10.39
    const lowest = chart.points[2]!; // 8.20
    assert.ok(highest.y < lowest.y, "SVG y grows downward");
    assert.ok(highest.y >= chart.plot.y);
    assert.ok(lowest.y <= chart.plot.y + chart.plot.h);
  });

  it("emits one path segment per point, in order", () => {
    const chart = buildChart(three);
    assert.ok(chart);
    assert.equal((chart.linePath.match(/[ML]/g) ?? []).length, 3);
    assert.ok(chart.linePath.startsWith("M"));
  });

  it("keeps a hover target big enough to hit", () => {
    const dense = buildChart(Array.from({ length: 200 }, (_, i) => point(`2026-01-01`, i)));
    assert.ok(dense);
    assert.ok(dense.band >= 24);
  });

  it("labels both ends of the x axis", () => {
    const chart = buildChart(three);
    assert.ok(chart);
    assert.equal(chart.xTicks[0]!.date, "2026-01-01");
    assert.equal(chart.xTicks[chart.xTicks.length - 1]!.date, "2026-01-15");
  });

  it("keeps every y tick inside the plot", () => {
    const chart = buildChart(three);
    assert.ok(chart);
    for (const tick of chart.yTicks) {
      assert.ok(tick.y >= chart.plot.y - 0.01 && tick.y <= chart.plot.y + chart.plot.h + 0.01);
    }
  });
});

describe("barWidths", () => {
  it("scales to the largest magnitude in the set", () => {
    assert.deepEqual(barWidths([5, 2.5, 1], 100), [100, 50, 20]);
  });

  it("ignores direction — the arrow and the sign carry that", () => {
    assert.deepEqual(barWidths([-5, 5], 100), [100, 100]);
  });

  it("gives a real move at least a visible bar", () => {
    // A 0.3px sliver reads as "no change" while the number beside it says
    // otherwise.
    const [big, tiny] = barWidths([1000, 1], 100);
    assert.equal(big, 100);
    assert.ok(tiny! >= 2);
  });

  it("draws nothing for zero, and nothing at all when everything is zero", () => {
    assert.deepEqual(barWidths([0, 0], 100), [0, 0]);
    assert.deepEqual(barWidths([5, 0], 100), [100, 0]);
  });

  it("degrades to no bars rather than NaN widths", () => {
    assert.deepEqual(barWidths([Number.NaN, 5], 100), [0, 100]);
    assert.deepEqual(barWidths([5], 0), [0]);
  });
});

/* ================================================================== *
 * Movers
 * ================================================================== */

describe("toMovers", () => {
  it("keeps the foil and the non-foil of one printing as separate movers", () => {
    // THE case the schema exists for. One printing, two finishes, two prices,
    // and here they even move by different amounts. Keying on scryfall_id alone
    // collapses them into one row and keeps whichever was written last.
    const movers = toMovers([
      moverRow({ finish: "nonfoil", quantity: 2, from_usd: "0.30", to_usd: "0.35", delta_total: "0.10" }),
      moverRow({ finish: "foil", quantity: 1, from_usd: "0.40", to_usd: "0.60", delta_total: "0.20" }),
    ]);

    assert.equal(movers.length, 2);
    assert.equal(new Set(movers.map((m) => m.key)).size, 2);
    assert.deepEqual(movers.map((m) => m.finish), ["nonfoil", "foil"]);
    assert.deepEqual(movers.map((m) => m.from), [0.3, 0.4]);
    assert.deepEqual(movers.map((m) => m.to), [0.35, 0.6]);
    // Same card, genuinely different percentage moves.
    assert.equal(formatPct(movers[0]!.pct), "+16.7%");
    assert.equal(formatPct(movers[1]!.pct), "+50.0%");
    assert.equal(Math.round(moversTotal(movers) * 100) / 100, 0.3);
  });

  it("keys on id AND finish, so the two rows survive a Map", () => {
    const movers = toMovers([
      moverRow({ finish: "nonfoil" }),
      moverRow({ finish: "foil" }),
      moverRow({ finish: "etched" }),
    ]);
    const byKey = new Map(movers.map((m) => [m.key, m]));
    assert.equal(byKey.size, 3);
    assert.ok(movers.every((m) => m.key.endsWith(`|${m.finish}`)));
  });

  it("multiplies the per-card move by the number of copies owned", () => {
    const [mover] = toMovers([
      moverRow({ from_usd: "1.00", to_usd: "1.49", quantity: 3, delta_total: "1.47" }),
    ]);
    assert.equal(mover!.deltaUnit, 0.49);
    assert.equal(mover!.deltaTotal, 1.47);
    assert.equal(mover!.quantity, 3);
  });

  it("has no percentage for a card that started at $0.00", () => {
    const [mover] = toMovers([
      moverRow({ from_usd: "0.00", to_usd: "0.99", delta_total: "0.99" }),
    ]);
    assert.equal(mover!.pct, null);
    assert.equal(mover!.deltaTotal, 0.99);
    assert.equal(mover!.direction, "up");
  });

  it("treats an unknown price as unknown, not as zero", () => {
    const [mover] = toMovers([moverRow({ from_usd: null, to_usd: "0.99", delta_total: null })]);
    assert.equal(mover!.from, null);
    assert.equal(mover!.deltaUnit, null);
    assert.equal(mover!.pct, null);
    assert.equal(mover!.deltaTotal, 0);
  });

  it("survives a printing the mirror no longer has — there is no FK", () => {
    const [mover] = toMovers([moverRow({ name: null, set_code: null, collector_number: null })]);
    assert.equal(mover!.name, null);
    assert.equal(mover!.scryfallId, COOLDOWN);
  });

  it("takes direction from the money, not from the SQL label", () => {
    const [mover] = toMovers([moverRow({ delta_total: "-5.00", direction: "up" })]);
    assert.equal(mover!.direction, "down");
  });
});

describe("splitMovers / moversTotal", () => {
  const movers: Mover[] = toMovers([
    moverRow({ delta_total: "1.47" }),
    moverRow({ finish: "foil", delta_total: "0.20" }),
    moverRow({ scryfall_id: BLACK_LOTUS, delta_total: "-5.00" }),
  ]);

  it("splits by direction without reordering either half", () => {
    const { up, down } = splitMovers(movers);
    assert.deepEqual(up.map((m) => m.deltaTotal), [1.47, 0.2]);
    assert.deepEqual(down.map((m) => m.deltaTotal), [-5]);
  });

  it("sums to what the list actually explains", () => {
    assert.equal(Math.round(moversTotal(movers) * 100) / 100, -3.33);
    assert.equal(moversTotal([]), 0);
  });
});

/* ================================================================== *
 * SQL shape — the finish key, guarded without a database
 * ================================================================== */

describe("query text", () => {
  it("matches history on finish as well as scryfall_id, everywhere", () => {
    // Every join to card_price_history in this file. Dropping `finish` from any
    // one of them prices foils off the non-foil ladder and silently merges the
    // 16 printings a real collection holds in both.
    const joins = [
      ...VALUE_SERIES_SQL.matchAll(/h\.scryfall_id\s*=\s*o\.scryfall_id/g),
      ...MOVERS_SQL.matchAll(/h\.scryfall_id\s*=\s*o\.scryfall_id/g),
    ];
    assert.ok(joins.length >= 3, "expected the id join in the series and both mover laterals");
    for (const sql of [VALUE_SERIES_SQL, MOVERS_SQL]) {
      const idJoins = (sql.match(/scryfall_id\s*=\s*(o|h)\.scryfall_id/g) ?? []).length;
      const finishJoins = (sql.match(/finish\s*=\s*(o|h)\.finish/g) ?? []).length;
      assert.equal(idJoins, finishJoins, "every id match must have a finish match beside it");
    }
  });

  it("groups holdings by finish, so a foil is its own holding", () => {
    for (const sql of [VALUE_SERIES_SQL, MOVERS_SQL]) {
      assert.match(sql, /GROUP BY cc\.scryfall_id, cc\.finish/);
    }
  });

  it("looks prices up at or before the date, never on it", () => {
    // The carry-forward. `= s.recorded_on` would drop every card the refresh
    // had nothing new to say about and crash the total.
    assert.match(VALUE_SERIES_SQL, /recorded_on <= s\.recorded_on/);
    assert.equal((MOVERS_SQL.match(/recorded_on <= \$[23]::date/g) ?? []).length, 2);
  });

  it("prices the current-value fallback off the same finish ladder as 0006", () => {
    assert.match(CURRENT_VALUE_SQL, /WHEN 'foil'\s+THEN \(s\.prices->>'usd_foil'\)/);
    assert.match(CURRENT_VALUE_SQL, /WHEN 'etched'\s+THEN \(s\.prices->>'usd_etched'\)/);
  });

  it("binds every user-supplied value rather than interpolating it", () => {
    for (const sql of [VALUE_SERIES_SQL, MOVERS_SQL, CURRENT_VALUE_SQL]) {
      assert.ok(!/\$\{/.test(sql), "no template holes left in the shipped SQL");
    }
    assert.match(MOVERS_SQL, /LIMIT \$4/);
  });
});

/* ================================================================== *
 * Against postgres
 * ================================================================== */

const DB_URL = process.env.TEST_DATABASE_URL;

describe("price history against postgres", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, () => {
  let pool: pg.Pool;
  let collectionId: number;
  let emptyCollectionId: number;
  const email = `prices-test-${process.pid}-${Date.now()}@ninetynine.invalid`;

  /**
   * Three weekly snapshots, built so every number on the page has one right
   * answer that can be worked out by hand:
   *
   *   date        BRO 53 nf ×2   BRO 53 foil ×1   Forest ×12   Sol Ring ×3
   *   2026-01-01  0.30           0.40             0.10         1.00
   *   2026-01-08  0.35           0.49             0.10         (carried 1.00)
   *   2026-01-15  (carried 0.35) 0.60             0.12         1.49
   *
   * plus Black Lotus ×1 at 5.00 -> 0.00 (a faller, and a -100%), Counterspell
   * ×1 at 0.00 -> 0.99 (a riser with no computable percentage), and Arahbo ×1
   * with no history row at all (the "one card in 1457 has no price" case).
   */
  const HISTORY: Array<[string, string, string, string | null]> = [
    [COOLDOWN, "nonfoil", "2026-01-01", "0.30"],
    [COOLDOWN, "nonfoil", "2026-01-08", "0.35"],
    [COOLDOWN, "foil", "2026-01-01", "0.40"],
    [COOLDOWN, "foil", "2026-01-08", "0.49"],
    [COOLDOWN, "foil", "2026-01-15", "0.60"],
    [FOREST, "nonfoil", "2026-01-01", "0.10"],
    [FOREST, "nonfoil", "2026-01-08", "0.10"],
    [FOREST, "nonfoil", "2026-01-15", "0.12"],
    [SOL_RING, "nonfoil", "2026-01-01", "1.00"],
    [SOL_RING, "nonfoil", "2026-01-15", "1.49"],
    [BLACK_LOTUS, "nonfoil", "2026-01-01", "5.00"],
    [BLACK_LOTUS, "nonfoil", "2026-01-15", "0.00"],
    [COUNTERSPELL, "nonfoil", "2026-01-01", "0.00"],
    [COUNTERSPELL, "nonfoil", "2026-01-15", "0.99"],
  ];

  const round = (n: number) => Math.round(n * 100) / 100;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

    const mirror = JSON.parse(readFileSync(MIRROR_JSON, "utf8")) as Array<Record<string, never>>;
    for (const c of mirror as unknown as Array<{
      id: string; oracle_id: string; name: string; set_code: string; set_name: string;
      collector_number: string; rarity: string; layout: string; type_line: string;
      oracle_text: string; color_identity: string[]; legalities: unknown; prices: unknown;
      finishes: string[];
    }>) {
      await pool.query(
        `INSERT INTO scryfall_cards
           (id, oracle_id, name, set_code, set_name, collector_number, rarity,
            layout, type_line, oracle_text, color_identity, legalities, prices, finishes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13::jsonb,$14::text[])
         ON CONFLICT (id) DO NOTHING`,
        [
          c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number,
          c.rarity, c.layout, c.type_line, c.oracle_text, c.color_identity,
          JSON.stringify(c.legalities), JSON.stringify(c.prices), c.finishes,
        ],
      );
    }

    const user = await pool.query(
      "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
      ["prices test", email],
    );
    const userId = user.rows[0].id as number;

    const collection = await pool.query(
      "INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id",
      [userId, "Prices test"],
    );
    collectionId = collection.rows[0].id as number;

    const empty = await pool.query(
      "INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id",
      [userId, "No history yet"],
    );
    emptyCollectionId = empty.rows[0].id as number;

    const holdings: Array<[string, number, string, string]> = [
      [COOLDOWN, 2, "nonfoil", "en"],
      [COOLDOWN, 1, "foil", "en"],
      [FOREST, 12, "nonfoil", "en"],
      [ARAHBO, 1, "nonfoil", "en"],
      [BLACK_LOTUS, 1, "nonfoil", "en"],
      [COUNTERSPELL, 1, "nonfoil", "en"],
      // ONE printing, one finish, two languages — two legal rows under the
      // (collection_id, scryfall_id, finish, language) unique index, and a
      // single price covering both. They must collapse to one holding of 3.
      [SOL_RING, 1, "nonfoil", "en"],
      [SOL_RING, 2, "nonfoil", "ja"],
    ];
    for (const [id, quantity, finish, language] of holdings) {
      await pool.query(
        `INSERT INTO collection_cards (collection_id, scryfall_id, quantity, finish, language)
         VALUES ($1, $2, $3, $4, $5)`,
        [collectionId, id, quantity, finish, language],
      );
    }
    // The empty collection holds cards, just nothing with history.
    await pool.query(
      `INSERT INTO collection_cards (collection_id, scryfall_id, quantity, finish)
       VALUES ($1, $2, 1, 'nonfoil'), ($1, $3, 1, 'nonfoil')`,
      [emptyCollectionId, ARAHBO, "b2203c75-deac-4a56-bcad-f7b0f3fa8a74"],
    );

    for (const [id, finish, on, usd] of HISTORY) {
      await pool.query(
        `INSERT INTO card_price_history (scryfall_id, finish, recorded_on, usd)
         VALUES ($1, $2, $3::date, $4::numeric)
         ON CONFLICT (scryfall_id, finish, recorded_on) DO UPDATE SET usd = EXCLUDED.usd`,
        [id, finish, on, usd],
      );
    }
  });

  after(async () => {
    // History is keyed on the card, not the collection, so it is not cleaned up
    // by the cascade — remove exactly the rows this file wrote.
    for (const [id, finish, on] of HISTORY) {
      await pool.query(
        `DELETE FROM card_price_history WHERE scryfall_id = $1 AND finish = $2 AND recorded_on = $3::date`,
        [id, finish, on],
      );
    }
    await pool.query("DELETE FROM users WHERE email = $1", [email]);
    await pool.end();
  });

  it("values every snapshot, carrying the last known price forward", async () => {
    const series = await loadValueSeries(pool, collectionId, null);
    assert.deepEqual(
      series.map((p) => [p.date, round(p.total)]),
      [
        // 2×0.30 + 0.40 + 12×0.10 + 3×1.00 + 5.00 + 0.00
        ["2026-01-01", 10.2],
        // BRO 53 rises, Sol Ring / Lotus / Counterspell carry their 01-01 price
        ["2026-01-08", 10.39],
        // BRO 53 non-foil has no row this week and carries 0.35, not $0
        ["2026-01-15", 8.2],
      ],
    );
  });

  it("prices the foil and the non-foil of one printing differently", async () => {
    // 0.35 vs 0.49 is the whole reason `finish` is in the primary key. If the
    // join dropped it, both rows would take whichever price sorted first and
    // the 01-08 total would not be 10.39.
    const { rows } = await pool.query(
      `SELECT finish, usd::text FROM card_price_history
        WHERE scryfall_id = $1 AND recorded_on = '2026-01-08'::date ORDER BY finish`,
      [COOLDOWN],
    );
    assert.deepEqual(rows, [{ finish: "foil", usd: "0.49" }, { finish: "nonfoil", usd: "0.35" }]);

    const series = await loadValueSeries(pool, collectionId, null);
    const jan8 = series.find((p) => p.date === "2026-01-08")!;
    // Both finishes counted: 2×0.35 + 1×0.49 = 1.19 of that total.
    assert.equal(round(jan8.total), 10.39);
    // 7 holdings, not 8: the two Sol Ring language rows are one priced holding.
    assert.equal(jan8.holdings, 7);
  });

  it("counts the card with no price at all instead of dropping it", async () => {
    const series = await loadValueSeries(pool, collectionId, null);
    for (const p of series) {
      assert.equal(p.holdings, 7);
      assert.equal(p.priced, 6);
      assert.equal(p.unpricedCards, 1, "Arahbo has no history row in any finish");
    }
  });

  it("windows by date", async () => {
    const recent = await loadValueSeries(pool, collectionId, "2026-01-08");
    assert.deepEqual(recent.map((p) => p.date), ["2026-01-08", "2026-01-15"]);
    // The carried prices still come from before the window — a window is a view
    // of the series, not a truncation of the data behind it.
    assert.equal(round(recent[0]!.total), 10.39);
  });

  it("returns nothing at all for a collection with no history", async () => {
    const series = await loadValueSeries(pool, emptyCollectionId, null);
    assert.deepEqual(series, []);
    assert.equal(seriesStatus(series), "empty");
    const extent = await loadHistoryExtent(pool, emptyCollectionId);
    assert.deepEqual(extent, { firstOn: null, lastOn: null, snapshots: 0 });
  });

  it("reports how far back the history goes", async () => {
    const extent = await loadHistoryExtent(pool, collectionId);
    assert.deepEqual(extent, { firstOn: "2026-01-01", lastOn: "2026-01-15", snapshots: 3 });
  });

  it("ranks movers by the money the collection actually gained or lost", async () => {
    const movers = await loadMovers(pool, collectionId, "2026-01-01", "2026-01-15");
    const { up, down } = splitMovers(movers);

    assert.deepEqual(
      up.map((m) => [m.name, m.finish, round(m.deltaTotal)]),
      [
        ["Sol Ring", "nonfoil", 1.47], // 0.49 × 3 copies beats every per-card move
        ["Counterspell", "nonfoil", 0.99],
        ["Forest", "nonfoil", 0.24], // 2c × 12 copies outranks a 20c single
        ["Involuntary Cooldown", "foil", 0.2],
        ["Involuntary Cooldown", "nonfoil", 0.1],
      ],
    );
    assert.deepEqual(
      down.map((m) => [m.name, round(m.deltaTotal)]),
      [["Black Lotus", -5]],
    );

    // The foil and the non-foil of BRO 53 are two rows moving by different
    // amounts and different percentages — exactly what collapsing on
    // scryfall_id would hide.
    const cooldowns = movers.filter((m) => m.scryfallId === COOLDOWN);
    assert.equal(cooldowns.length, 2);
    assert.deepEqual(cooldowns.map((m) => formatPct(m.pct)), ["+50.0%", "+16.7%"]);
  });

  it("gives the zero-baseline riser a dollar move and no percentage", async () => {
    const movers = await loadMovers(pool, collectionId, "2026-01-01", "2026-01-15");
    const counterspell = movers.find((m) => m.name === "Counterspell")!;
    assert.equal(counterspell.from, 0);
    assert.equal(counterspell.pct, null);
    assert.equal(formatPct(counterspell.pct), "—");

    const lotus = movers.find((m) => m.name === "Black Lotus")!;
    assert.equal(lotus.to, 0);
    assert.equal(formatPct(lotus.pct), "-100.0%");
  });

  it("excludes the uncomparable rather than calling them flat", async () => {
    const movers = await loadMovers(pool, collectionId, "2026-01-01", "2026-01-15");
    assert.equal(movers.find((m) => m.scryfallId === ARAHBO), undefined);
  });

  it("explains the whole change when nothing is left off the list", async () => {
    const series = await loadValueSeries(pool, collectionId, null);
    const movers = await loadMovers(pool, collectionId, "2026-01-01", "2026-01-15");
    const summary = summarise(series)!;
    assert.equal(round(moversTotal(movers)), round(summary.delta));
    assert.equal(round(summary.delta), -2);
  });

  it("honours the row limit per direction", async () => {
    const capped = await loadMovers(pool, collectionId, "2026-01-01", "2026-01-15", 2);
    const { up, down } = splitMovers(capped);
    assert.equal(up.length, 2);
    assert.equal(down.length, 1);
    assert.ok(MOVERS_LIMIT >= 2);
  });

  it("values the collection from the mirror when there is no history to use", async () => {
    // The 0006 fallback, plus the count the view cannot give: Seven Dwarves is
    // priced, Arahbo's `usd` is null.
    const now = await loadCurrentValue(pool, emptyCollectionId);
    assert.equal(now.holdings, 2);
    assert.equal(now.cards, 2);
    assert.equal(round(now.total), 0.35);
    assert.equal(now.unpricedHoldings, 1);
    assert.equal(now.unpricedCards, 1);
  });

  it("prices a foil off usd_foil in the current-value fallback", async () => {
    // Arahbo is the mirror image of the usual case: usd is null, usd_foil is
    // 37.99. A finish-blind fallback would value the foil at nothing.
    const solo = await pool.query(
      "INSERT INTO collections (user_id, name) SELECT user_id, 'foil fallback' FROM collections WHERE id = $1 RETURNING id",
      [collectionId],
    );
    const foilId = solo.rows[0].id as number;
    await pool.query(
      "INSERT INTO collection_cards (collection_id, scryfall_id, quantity, finish) VALUES ($1, $2, 1, 'foil')",
      [foilId, ARAHBO],
    );
    const now = await loadCurrentValue(pool, foilId);
    assert.equal(round(now.total), 37.99);
    assert.equal(now.unpricedHoldings, 0);
    await pool.query("DELETE FROM collections WHERE id = $1", [foilId]);
  });

  it("reads the refresh state that dates the empty message", async () => {
    const before = await loadRefreshState(pool);
    await pool.query(
      `INSERT INTO scryfall_bulk_imports (bulk_type, status, finished_at, card_count)
       VALUES ('default_cards', 'ok', '2026-01-15T04:00:00Z', 117620),
              ('default_cards', 'failed', '2026-01-16T04:00:00Z', NULL)`,
    );
    const state = await loadRefreshState(pool);
    // The failed run is not a refresh: it preserved nothing.
    assert.equal(state.runs, before.runs + 1);
    assert.equal(state.lastOn, "2026-01-15");
    await pool.query("DELETE FROM scryfall_bulk_imports WHERE bulk_type = 'default_cards'");
  });
});
