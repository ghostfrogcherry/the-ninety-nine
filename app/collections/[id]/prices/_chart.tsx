import { usd } from "@/app/_ui";
import { buildChart, formatDay, type SeriesPoint } from "@/lib/prices";

/**
 * The collection-value line, as inline SVG.
 *
 * A server component with no charting library: every coordinate comes from
 * `buildChart` in lib/prices, which is pure and tested, so the only thing this
 * file decides is paint. That is also why there is no `"use client"` here — the
 * hover layer below is CSS and `<title>`, not JavaScript, so the page ships as
 * static markup and still answers "what was it worth on the 8th?".
 *
 * One series, one colour. Direction is NOT encoded here: the line is yellow
 * whether the window is up or down, because a chart that turns green when it
 * rises encodes the same fact twice and leaves nothing for the movers list to
 * say. Green and yellow also collapse under protanopia (ΔE 3.6 against this
 * background), so they must never mean different things on one page.
 */
export function ValueChart({ points }: { points: readonly SeriesPoint[] }) {
  const chart = buildChart(points);
  // Callers check `seriesStatus` first; this is the belt to that braces.
  if (!chart) return null;

  const { plot } = chart;
  const last = chart.points[chart.points.length - 1]!;
  const floor = chart.yTicks[0]?.value ?? chart.domain[0];

  return (
    <figure style={{ margin: 0 }}>
      {/* Scoped to .pchart rather than added to globals.css, which this change
          does not own. Hover only reveals a marker that is already positioned,
          so nothing moves and nothing reflows. */}
      <style>{`
        .pchart .pt .hv { opacity: 0; }
        .pchart .pt:hover .hv { opacity: 1; }
      `}</style>

      <svg
        className="pchart"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        width="100%"
        style={{ display: "block", height: "auto" }}
        role="img"
        aria-label={`Collection value from ${formatDay(chart.points[0]!.point.date)} to ${formatDay(
          last.point.date,
        )}, ${usd(chart.points[0]!.point.total)} to ${usd(last.point.total)}. The same numbers are in the snapshot table below.`}
      >
        {/* Hairline, solid, one step off the surface: a grid is scaffolding. */}
        {chart.yTicks.map((tick) => (
          <line
            key={`g${tick.value}`}
            x1={plot.x}
            x2={plot.x + plot.w}
            y1={tick.y}
            y2={tick.y}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}
        {chart.yTicks.map((tick) => (
          <text
            key={`t${tick.value}`}
            x={plot.x - 8}
            y={tick.y + 3.5}
            textAnchor="end"
            fontSize={10}
            fill="var(--dim2)"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {usd(tick.value)}
          </text>
        ))}

        {chart.xTicks.map((tick, i) => (
          <text
            key={`x${i}`}
            x={tick.x}
            y={plot.y + plot.h + 16}
            textAnchor={i === 0 ? "start" : i === chart.xTicks.length - 1 ? "end" : "middle"}
            fontSize={10}
            fill="var(--dim2)"
          >
            {formatDay(tick.date)}
          </text>
        ))}

        {/* Phosphor bloom — a wider translucent copy of the same path, not a
            filter, so it costs nothing and cannot blur the 2px line on top. */}
        <path
          d={chart.linePath}
          fill="none"
          stroke="var(--yellow)"
          strokeWidth={7}
          strokeOpacity={0.12}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={chart.linePath}
          fill="none"
          stroke="var(--yellow)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* No area fill under the line. The y axis is zoomed to the data (see
            the caption), and a filled area under a truncated baseline reads as
            magnitude-from-zero — it would claim the collection is worth the
            height of the shading. */}

        <circle cx={last.x} cy={last.y} r={4} fill="var(--yellow)" stroke="var(--bg0)" strokeWidth={2} />
        <text x={last.x + 10} y={last.y + 4} fontSize={12} fill="var(--fg0)">
          {usd(last.point.total)}
        </text>

        {/* Hover layer. The rect is the hit target and is at least 24px wide
            whatever the point spacing, because a 3px-wide target on a year of
            weekly snapshots is unhittable. `<title>` gives the browser's own
            tooltip, which also reaches keyboard and screen-reader users. */}
        {chart.points.map((p, i) => (
          <g className="pt" key={`p${i}`}>
            <title>{`${p.point.date} · ${usd(p.point.total)}${
              p.point.unpricedCards > 0 ? ` · ${p.point.unpricedCards} card(s) unpriced` : ""
            }`}</title>
            <rect
              x={p.x - chart.band / 2}
              y={plot.y}
              width={chart.band}
              height={plot.h}
              fill="transparent"
            />
            <line
              className="hv"
              x1={p.x}
              x2={p.x}
              y1={plot.y}
              y2={plot.y + plot.h}
              stroke="var(--bg4)"
              strokeWidth={1}
            />
            <circle
              className="hv"
              cx={p.x}
              cy={p.y}
              r={4}
              fill="var(--yellow)"
              stroke="var(--bg0)"
              strokeWidth={2}
            />
          </g>
        ))}
      </svg>

      <figcaption style={{ color: "var(--dim2)", fontSize: 11, marginTop: "0.4rem" }}>
        The axis starts at {usd(floor)}, not $0.00 — the plot shows the swing, not the whole
        value. Hover a point for its date and total.
        {chart.indexed ? " Points are evenly spaced: their dates could not be read." : ""}
      </figcaption>
    </figure>
  );
}

/**
 * The same series as numbers.
 *
 * Not optional decoration: it is the copy of the chart that works without
 * colour, without hover and without SVG, and it is where the per-snapshot
 * unpriced counts are actually legible. Collapsed by default because the chart
 * is the point; `<details>` keeps that free of JavaScript.
 */
export function SnapshotTable({ points }: { points: readonly SeriesPoint[] }) {
  return (
    <details style={{ marginTop: "1rem" }}>
      <summary style={{ cursor: "pointer", color: "var(--dim)", fontSize: 12 }}>
        All {points.length} snapshots, as numbers
      </summary>
      <div style={{ overflowX: "auto", marginTop: "0.5rem" }}>
        <table>
          <thead>
            <tr>
              <th>Snapshot</th>
              <th className="num">Value</th>
              <th className="num">Change</th>
              <th className="num">Priced</th>
              <th className="num">Unpriced cards</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => {
              const previous = i > 0 ? points[i - 1]!.total : null;
              const step = previous === null ? null : p.total - previous;
              return (
                <tr key={p.date}>
                  <td>{p.date}</td>
                  <td className="num">{usd(p.total)}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        step === null || step === 0
                          ? "var(--dim2)"
                          : step > 0
                            ? "var(--green)"
                            : "var(--red)",
                    }}
                  >
                    {step === null ? "—" : `${step >= 0 ? "+" : "-"}${usd(Math.abs(step))}`}
                  </td>
                  <td className="num" style={{ color: "var(--dim)" }}>
                    {p.priced}/{p.holdings}
                  </td>
                  <td className="num" style={{ color: p.unpricedCards ? "var(--yellow)" : "var(--dim2)" }}>
                    {p.unpricedCards}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
