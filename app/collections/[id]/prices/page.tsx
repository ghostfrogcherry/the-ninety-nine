import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { currentUserId, loadOwnedCollection, parseCollectionId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { Notice, Shell, usd } from "@/app/_ui";
import {
  MOVERS_LIMIT,
  WINDOWS,
  downsample,
  formatDay,
  formatPct,
  loadCurrentValue,
  loadHistoryExtent,
  loadMovers,
  loadRefreshState,
  loadValueSeries,
  moversTotal,
  parseWindow,
  seriesStatus,
  summarise,
  windowDays,
  windowStart,
  type CurrentValue,
  type RefreshState,
  type SeriesPoint,
  type SeriesStatus,
  type WindowKey,
} from "@/lib/prices";
import { SnapshotTable, ValueChart } from "./_chart";
import { Movers } from "./_movers";

export const dynamic = "force-dynamic";

/** Points the 880px-wide plot can carry before marks stop being marks. */
const MAX_POINTS = 180;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PricesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  // Range-checked before it reaches an int4 column: `pg` infers the bind type
  // from the column, so 2147483648 raises 22003 and surfaces as a 500 instead
  // of matching nothing. Same guard as the collection page.
  const id = parseCollectionId((await params).id);
  if (id === null) notFound();

  // Re-checked here even though the caller arrived from a page that already
  // checked: a URL is not a permission. Someone else's collection and a
  // nonexistent one are the same 404, so this cannot enumerate ids.
  const collection = await loadOwnedCollection(id, userId);
  if (!collection) notFound();

  const sp = await searchParams;
  const windowKey = parseWindow(sp.window);
  const since = windowStart(new Date().toISOString().slice(0, 10), windowDays(windowKey));

  const [extent, rawSeries, now] = await Promise.all([
    loadHistoryExtent(pool, id),
    loadValueSeries(pool, id, since),
    loadCurrentValue(pool, id),
  ]);

  const points = downsample(rawSeries, MAX_POINTS);
  const status = seriesStatus(points);
  const summary = summarise(points);
  // `summarise` returns null only for an empty series, which `seriesStatus`
  // already calls "empty", so the two can never disagree — but the compiler
  // cannot see that, and the pairing is spelled out here rather than asserted
  // away with a `!`.
  const blankStatus: Exclude<SeriesStatus, "ok"> = status === "ok" ? "empty" : status;

  // Movers are only meaningful between two real snapshot dates, so they are
  // bounded by the series itself rather than by the requested window: asking
  // for prices "on" a date the refresh never ran would compare a card against
  // itself and report a collection where nothing ever moves.
  const movers =
    status === "ok" && summary
      ? await loadMovers(pool, id, summary.first.date, summary.last.date, MOVERS_LIMIT)
      : [];

  // Only fetched when the page has to explain an absence — it is the mirror's
  // refresh count that says WHEN the chart starts working.
  const refresh = status === "ok" ? null : await loadRefreshState(pool);

  const base = `/collections/${id}/prices`;

  return (
    <Shell
      title={collection.name}
      actions={
        <Link href={`/collections/${id}`} style={{ fontSize: 12 }}>
          cards →
        </Link>
      }
      subtitle={
        <>
          price history ·{" "}
          <span className="stat">{extent.snapshots}</span>{" "}
          snapshot{extent.snapshots === 1 ? "" : "s"}
          {extent.firstOn && extent.lastOn ? (
            <>
              {" "}
              <span style={{ color: "var(--dim2)" }}>
                ({extent.firstOn} – {extent.lastOn})
              </span>
            </>
          ) : null}
          {" · "}
          <WindowPicker current={windowKey} base={base} />
        </>
      }
    >
      {status === "ok" && summary ? (
        <>
          <Headline summary={summary} now={now} windowKey={windowKey} />

          <div className="panel" style={{ marginTop: "1.25rem" }}>
            <ValueChart points={points} />
            <SnapshotTable points={points} />
          </div>

          <Movers movers={movers} />

          <p style={{ color: "var(--dim2)", fontSize: 11, marginTop: "0.9rem" }}>
            Top {MOVERS_LIMIT} each way, ranked by the money the collection gained or lost — a
            printing held in two finishes is two entries, because they are two prices. Those rows
            account for {signed(moversTotal(movers))} of the {signed(summary.delta)} change; the
            rest is the long tail.{" "}
            {summary.first.priced < summary.first.holdings || summary.last.priced < summary.last.holdings ? (
              <>
                {summary.first.holdings - summary.first.priced} holding
                {summary.first.holdings - summary.first.priced === 1 ? " had" : "s had"} no recorded
                price on {summary.first.date} and {summary.last.holdings - summary.last.priced} ha
                {summary.last.holdings - summary.last.priced === 1 ? "s" : "ve"} none on{" "}
                {summary.last.date}; a holding missing a price at either end cannot be compared and
                is left out of both lists rather than reported as flat.
              </>
            ) : null}
          </p>
        </>
      ) : (
        <NoChart
          status={blankStatus}
          points={points}
          windowKey={windowKey}
          snapshots={extent.snapshots}
          firstOn={extent.firstOn}
          lastOn={extent.lastOn}
          now={now}
          refresh={refresh}
          base={base}
        />
      )}

      <Provenance now={now} />
    </Shell>
  );
}

/** `+$4.10` / `-$4.10` / `$0.00`. `usd()` renders a negative as `$-4.10`, which
 *  reads as a typo in a column; the sign belongs in front of the money. */
function signed(value: number): string {
  if (value === 0) return usd(0);
  return `${value > 0 ? "+" : "-"}${usd(Math.abs(value))}`;
}

function WindowPicker({ current, base }: { current: WindowKey; base: string }) {
  return (
    <span style={{ display: "inline-flex", gap: "0.5rem", fontSize: 12 }}>
      {WINDOWS.map((w) => (
        <Link
          key={w.key}
          href={`${base}?window=${w.key}`}
          style={{
            color: w.key === current ? "var(--yellow)" : "var(--dim)",
            borderBottom: w.key === current ? "1px solid var(--yellow)" : "1px solid transparent",
          }}
        >
          {w.label}
        </Link>
      ))}
    </span>
  );
}

/**
 * The numbers above the chart.
 *
 * Two values, deliberately both shown. The hero is the value at the LAST
 * SNAPSHOT, because that is what the chart plots and what `collection_values`
 * (and so /collections) reports once history exists. The mirror's live number
 * is the one the card list totals. They are the same source on different dates,
 * and a page that showed only one of them would leave the other looking like a
 * bug.
 */
function Headline({
  summary,
  now,
  windowKey,
}: {
  summary: NonNullable<ReturnType<typeof summarise>>;
  now: CurrentValue;
  windowKey: WindowKey;
}) {
  const up = summary.delta >= 0;
  const tone = summary.delta === 0 ? "var(--dim)" : up ? "var(--green)" : "var(--red)";
  const label = WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
        gap: "1rem",
      }}
    >
      <Tile label={`Value on ${formatDay(summary.last.date)}`}>
        {/* Proportional figures, not tabular: at 28px, equal-width digits make
            a number look loose. Columns of numbers get tabular-nums; this is
            not a column. */}
        <span style={{ fontSize: 28, color: "var(--fg0)" }}>{usd(summary.last.total)}</span>
      </Tile>

      <Tile label={`Change over ${label.toLowerCase()}`}>
        <span style={{ fontSize: 20, color: tone }}>
          <span aria-hidden>{summary.delta === 0 ? "·" : up ? "▲" : "▼"}</span> {signed(summary.delta)}
        </span>
        <span style={{ color: "var(--dim)", marginLeft: "0.5rem" }}>{formatPct(summary.pct)}</span>
        <div style={{ fontSize: 11, color: "var(--dim2)" }}>
          from {usd(summary.first.total)} on {summary.first.date}
        </div>
      </Tile>

      <Tile label="Mirror right now">
        <span style={{ fontSize: 20, color: "var(--fg1)" }}>{usd(now.total)}</span>
        <div style={{ fontSize: 11, color: "var(--dim2)" }}>
          today&rsquo;s prices, straight from the mirror — the card list totals this
        </div>
      </Tile>

      <Tile label="Range in window">
        <span style={{ fontSize: 20, color: "var(--fg1)" }}>
          {usd(summary.min)} – {usd(summary.max)}
        </span>
        <div style={{ fontSize: 11, color: "var(--dim2)" }}>low to high across the plotted points</div>
      </Tile>
    </div>
  );
}

/**
 * A number with a caption, not a `Notice`, despite wearing the same aqua rule.
 *
 * `Notice` is a message panel: it carries `margin-bottom: 1rem`, which does not
 * collapse inside the grid above and would leave four tiles sitting on a ragged
 * baseline, and its `title` is an `h2` — four of these are metrics, not
 * headings. The tone would lie too: `good` is a claim about the news, and the
 * change tile is red as often as it is green.
 */
function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="panel"
      style={{ borderLeft: "2px solid var(--aqua-dim)", padding: "0.7rem 0.9rem" }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--dim)",
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: "0.2rem" }}>{children}</div>
    </div>
  );
}

/**
 * Everything the page can say when it cannot draw a line.
 *
 * This is the common case for the first fortnight of an install, not an error
 * path, so it gets the real explanation: WHY there is nothing, WHEN there will
 * be something, and what the collection is worth in the meantime. What it must
 * never do is draw a flat line at zero, or a single point pretending to be a
 * trend — both of those say "your collection was worth nothing", which is a
 * different and false statement from "nothing has been recorded yet".
 */
function NoChart({
  status,
  points,
  windowKey,
  snapshots,
  firstOn,
  lastOn,
  now,
  refresh,
  base,
}: {
  status: "empty" | "single" | "unpriced";
  points: readonly SeriesPoint[];
  windowKey: WindowKey;
  snapshots: number;
  firstOn: string | null;
  lastOn: string | null;
  now: CurrentValue;
  refresh: RefreshState | null;
  base: string;
}) {
  // History exists, just not inside the window that was asked for. A different
  // message from "no history": one is fixed by clicking All, the other by
  // waiting a week.
  const outsideWindow = status === "empty" && snapshots > 0;

  return (
    <Notice
      tone="warn"
      title={
        outsideWindow
          ? "Nothing recorded in this window"
          : status === "empty"
            ? "No price history yet"
            : status === "single"
              ? "One snapshot so far"
              : "Snapshots exist, but no prices in them"
      }
    >
      {outsideWindow ? (
        <p>
          This collection has {snapshots} snapshot{snapshots === 1 ? "" : "s"}, from {firstOn} to{" "}
          {lastOn} — all of it older than the {windowKey} window.{" "}
          <Link href={`${base}?window=all`}>Show all</Link>.
        </p>
      ) : status === "empty" ? (
        <>
          <p>
            <code>card_price_history</code> starts filling on the <strong>second</strong> Scryfall
            refresh. The first refresh has nothing to preserve: it writes the prices it downloads
            over an empty mirror, so there are no outgoing prices to snapshot, and it correctly
            records zero history rows.
          </p>
          <p>{refreshSentence(refresh)}</p>
        </>
      ) : status === "single" ? (
        <p>
          One snapshot, on {points[0]!.date}, at {usd(points[0]!.total)}. A line needs two dated
          points to join and the movers list needs two to compare, so there is nothing to draw yet.
          The next weekly refresh supplies the second. {refreshSentence(refresh)}
        </p>
      ) : (
        <p>
          {snapshots} snapshot{snapshots === 1 ? "" : "s"} cover{snapshots === 1 ? "s" : ""} this
          collection, but not one of its cards has a recorded price in any of them, so every total
          would be {usd(0)}. That is a gap in the mirror, not a collection worth nothing — a chart
          of zeroes would say the opposite.
        </p>
      )}

      <p style={{ marginBottom: 0 }}>
        Right now this collection is worth <span className="stat">{usd(now.total)}</span> at Scryfall
        market prices read live from the mirror, across {now.cards} cards in {now.holdings} holdings.
        That is today&rsquo;s number, not a history.
        {now.unpricedCards > 0 ? (
          <>
            {" "}
            <span style={{ color: "var(--yellow)" }}>
              {now.unpricedCards} of those cards ({now.unpricedHoldings} holding
              {now.unpricedHoldings === 1 ? "" : "s"}) have no Scryfall price at all
            </span>{" "}
            and count as {usd(0)} in that total. One unpriced card in fourteen hundred is normal,
            not a fault.
          </>
        ) : null}
      </p>
    </Notice>
  );
}

/** When the chart starts working, in terms of the thing that decides it. */
function refreshSentence(refresh: RefreshState | null): string {
  if (!refresh || refresh.runs === 0) {
    return (
      "The Scryfall mirror has never been refreshed successfully, so there are no prices to " +
      "snapshot at all yet. Run `docker compose --profile refresh run --rm scryfall-refresh`: " +
      "the first run fills the mirror, the second — a week later — writes the first dated snapshot."
    );
  }
  if (refresh.runs === 1) {
    return (
      `The mirror has been refreshed once, on ${refresh.lastOn}. The next weekly refresh records ` +
      "the first dated snapshot, and the one after it gives the chart two points to join."
    );
  }
  return (
    `The mirror has been refreshed ${refresh.runs} times, most recently on ${refresh.lastOn}, ` +
    "so history is being written — it just does not cover this collection's cards yet."
  );
}

/** Where the money comes from. Stated on the page, not just in the README,
 *  because the number is otherwise easy to mistake for a sale price. */
function Provenance({ now }: { now: CurrentValue }) {
  return (
    <p style={{ color: "var(--dim2)", fontSize: 11, marginTop: "1.5rem" }}>
      Every price here is Scryfall market — TCGplayer market, from <code>usd</code> /{" "}
      <code>usd_foil</code> — snapshotted by the weekly refresh, with foil, etched and non-foil of
      one printing priced separately. It is not a sale price and not a buylist price: a retailer
      export of the same cards uses a different ladder and will read higher (a 1457-card collection
      valued at $1,639.67 by one came to $1,139.26 here).
      {now.unpricedCards > 0 ? (
        <>
          {" "}
          {now.unpricedCards} card{now.unpricedCards === 1 ? "" : "s"} in this collection ha
          {now.unpricedCards === 1 ? "s" : "ve"} no Scryfall price and contribute{" "}
          {now.unpricedCards === 1 ? "s" : ""} {usd(0)} to every total on this page.
        </>
      ) : null}
    </p>
  );
}
