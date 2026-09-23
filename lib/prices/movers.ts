/**
 * The biggest movers between two snapshots, shaped for the table beside the
 * chart.
 *
 * Shaping only: which holdings count as movers, and in what order, is decided
 * by MOVERS_SQL in ./queries.ts. What this adds is the identity a mover is
 * keyed and rendered by, and the two different deltas the page shows — per card
 * and across every copy owned.
 */

// Explicit `.ts` — see the rule in ./index.ts. Type-stripping does no module
// resolution, so an extensionless specifier here passes tsc and then fails at
// runtime.
import { parseMoney, pctChange } from "./series.ts";

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
