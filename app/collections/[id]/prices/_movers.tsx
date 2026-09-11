import { usd } from "@/app/_ui";
import { barWidths, formatPct, splitMovers, type Mover } from "@/lib/prices";

/** Longest bar, in SVG-free plain pixels. Short enough to sit in a 22rem panel. */
const BAR_MAX = 72;

/**
 * Biggest movers, gainers beside fallers.
 *
 * Direction is encoded three times over and colour is the weakest of them: the
 * arrow first, then the explicit sign on every number, then green/red. Gruvbox
 * green and red do clear CVD separation against this background (ΔE 9.7 under
 * deuteranopia), but a list where the only difference between "+$5" and "-$5"
 * is a hue is a list that lies to a printer, to a screenshot and to about 8% of
 * men.
 */
export function Movers({ movers }: { movers: readonly Mover[] }) {
  // Scaled across BOTH lists, not per list: bars that are only comparable
  // within their own column would draw a 3c rise the same length as a $5 fall.
  const widths = barWidths(
    movers.map((m) => m.deltaTotal),
    BAR_MAX,
  );
  const widthFor = new Map(movers.map((m, i) => [m.key, widths[i] ?? 0]));
  const { up, down } = splitMovers(movers);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(21rem, 1fr))",
        gap: "1.25rem",
        marginTop: "1.5rem",
      }}
    >
      <MoverList title="Gained" movers={up} widthFor={widthFor} />
      <MoverList title="Lost" movers={down} widthFor={widthFor} />
    </div>
  );
}

function MoverList({
  title,
  movers,
  widthFor,
}: {
  title: string;
  movers: readonly Mover[];
  widthFor: Map<string, number>;
}) {
  return (
    <section className="panel">
      <h2>
        {title} <span style={{ color: "var(--dim2)" }}>· {movers.length}</span>
      </h2>
      {movers.length === 0 ? (
        <p style={{ color: "var(--dim2)", fontSize: 12, margin: "0.4rem 0 0" }}>
          Nothing {title === "Gained" ? "rose" : "fell"} in this window.
        </p>
      ) : (
        <table>
          <tbody>
            {movers.map((m) => (
              <MoverRow key={m.key} mover={m} width={widthFor.get(m.key) ?? 0} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MoverRow({ mover, width }: { mover: Mover; width: number }) {
  const up = mover.direction === "up";
  const tone = up ? "var(--green)" : "var(--red)";
  const sign = up ? "+" : "-";

  return (
    <tr>
      <td style={{ maxWidth: "14rem" }}>
        <div style={{ display: "flex", gap: "0.35rem", alignItems: "baseline" }}>
          {/* aria-hidden: the sign on the number already says the direction, and
              a screen reader announcing "black up-pointing triangle" does not. */}
          <span aria-hidden style={{ color: tone }}>{up ? "▲" : "▼"}</span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: mover.name ? undefined : "var(--dim2)",
            }}
          >
            {/* No FK to the mirror (0003), so a printing Scryfall reshuffled out
                of the bulk file still moves and still belongs in this list. */}
            {mover.name ?? "not in the mirror"}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--dim2)", paddingLeft: "1.1rem" }}>
          {mover.setCode ? `${mover.setCode.toUpperCase()} ${mover.collectorNumber ?? ""} · ` : ""}
          {/* The finish is spelled out on every row, never implied: one printing
              can appear in this list twice, plain and foil, at different prices
              and moving by different amounts. */}
          <span style={{ color: mover.finish === "nonfoil" ? "var(--dim2)" : "var(--yellow)" }}>
            {mover.finish}
          </span>
          {" ×"}
          {mover.quantity} · {usd(mover.from)} → {usd(mover.to)}
        </div>
      </td>
      <td style={{ width: BAR_MAX + 12 }}>
        <div
          title={`${sign}${usd(Math.abs(mover.deltaTotal))} across ${mover.quantity} cop${
            mover.quantity === 1 ? "y" : "ies"
          }`}
          style={{
            width,
            height: 6,
            background: tone,
            // Square at the baseline, rounded at the data end — the end is the
            // value, the start is the axis.
            borderRadius: "0 3px 3px 0",
          }}
        />
      </td>
      <td className="num" style={{ whiteSpace: "nowrap" }}>
        <div style={{ color: tone }}>
          {sign}
          {usd(Math.abs(mover.deltaTotal))}
        </div>
        <div style={{ fontSize: 11, color: "var(--dim)" }} title={
          mover.pct === null ? "No percentage: the price started at $0.00 or was unknown." : undefined
        }>
          {formatPct(mover.pct)}
        </div>
      </td>
    </tr>
  );
}
