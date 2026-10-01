/**
 * Who holds which pack, and the bots' catch-up loop — pure, no database.
 *
 * The engine (./index.ts) loads a pod's draft_cards once per transaction,
 * builds a `Table` from them, decides every pick in memory, and writes the
 * lot back in one statement. A human pick that sets seven bots off is then
 * three or four round trips, not one per bot pick.
 *
 * There is no "current holder" column anywhere. Who holds a pack is derived,
 * every time, from how many cards each seat has taken and how many have left
 * each pack — so there is no second copy of the truth to drift, and a pick is
 * one UPDATE of one draft_cards row.
 */

import { pickForBot, type BotCard, type Rng } from "./packs.ts";

export interface PodShape {
  seatCount: number;
  packSize: number;
  packCount: number;
}

/** `a mod n`, always in [0, n). JavaScript's `%` keeps the sign of `a`. */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * Pass direction in a round: +1 (to seat+1) in rounds 0, 2, 4…, -1 in 1, 3….
 * Round numbers are 0-based here; 0008_drafts.sql's "odd-numbered rounds
 * (1st, 3rd, …)" are the same rounds counted from one.
 */
export function passDirection(round: number): 1 | -1 {
  return round % 2 === 0 ? 1 : -1;
}

/**
 * THE POSITION RULE.
 *
 * A seat that has made `n` picks is on round floor(n / pack_size), pick
 * n % pack_size: every pack has pack_size cards and a seat takes exactly one
 * from each pack that reaches it, so its own pick count says where it is.
 *
 * In round r at pick p, seat s holds the pack opened by
 *
 *     origin = (s - p·dir) mod seat_count
 *
 * because a pack moves one seat in the round's direction per pick: the pack
 * seat s opened is at s + p·dir after p picks, so the one at s came from
 * s - p·dir. That pack must also have had exactly p cards taken — the p seats
 * before s have each picked from it. Fewer, and it has not arrived yet: seat s
 * is waiting on whichever seat should take the pack's next card,
 * origin + taken·dir. More cannot happen; it would mean a seat after s took a
 * card from the pack before s did.
 *
 * A fast seat may open its next round's pack while slower ones finish the
 * last round: pick 0 of any round is the seat's own pack, which nobody else
 * touches first. The rule needs no round barrier, and so neither does the
 * engine.
 */
export function seatPosition(picksMade: number, shape: PodShape): { round: number; pick: number } {
  return { round: Math.floor(picksMade / shape.packSize), pick: picksMade % shape.packSize };
}

/** The origin seat of the pack seat `seat` holds at (round, pick). */
export function packOrigin(seat: number, round: number, pick: number, seatCount: number): number {
  return mod(seat - pick * passDirection(round), seatCount);
}

/** The seat that takes card number `taken` (0-based) from the pack `origin` opened. */
export function seatToPickFrom(origin: number, round: number, taken: number, seatCount: number): number {
  return mod(origin + taken * passDirection(round), seatCount);
}

export type SeatTurn =
  | { kind: "done"; round: number; pick: number }
  | { kind: "pick"; round: number; pick: number; origin: number }
  | { kind: "wait"; round: number; pick: number; origin: number; waitingOn: number };

/**
 * Where a seat stands, given its pick count and a way to ask how many cards
 * have left a pack. Kept separate from `Table` so the rule is testable with a
 * hand-written count and nothing else.
 */
export function seatTurn(
  seat: number,
  picksMade: number,
  taken: (round: number, origin: number) => number,
  shape: PodShape,
): SeatTurn {
  const { round, pick } = seatPosition(picksMade, shape);
  if (round >= shape.packCount) return { kind: "done", round, pick };
  const origin = packOrigin(seat, round, pick, shape.seatCount);
  const gone = taken(round, origin);
  if (gone === pick) return { kind: "pick", round, pick, origin };
  if (gone > pick) {
    throw new Error(`pack ${round}/${origin} has ${gone} cards taken but seat ${seat} is on pick ${pick}`);
  }
  return { kind: "wait", round, pick, origin, waitingOn: seatToPickFrom(origin, round, gone, shape.seatCount) };
}

/* ------------------------------------------------------------------ *
 * The in-memory pod
 * ------------------------------------------------------------------ */

/** One draft_cards row, as the engine holds it. `id` is absent before insert. */
export interface TableCard extends BotCard {
  id?: number;
  round: number;
  origin: number;
  slot: number;
  scryfall_id: string;
  picked_by: number | null;
  pick_number: number | null;
}

export interface Table {
  shape: PodShape;
  cards: TableCard[];
  /** Cards of each pack, keyed `round:origin`. */
  packs: Map<string, TableCard[]>;
  /** Cards each seat has taken, in pick order. */
  picks: TableCard[][];
  /** Cards picked since the table was built, in the order they were taken. */
  picked: TableCard[];
}

const packKey = (round: number, origin: number) => `${round}:${origin}`;

export function buildTable(shape: PodShape, cards: TableCard[]): Table {
  const packs = new Map<string, TableCard[]>();
  const picks: TableCard[][] = Array.from({ length: shape.seatCount }, () => []);
  for (const card of cards) {
    const key = packKey(card.round, card.origin);
    const pack = packs.get(key);
    if (pack) pack.push(card);
    else packs.set(key, [card]);
    if (card.picked_by !== null) picks[card.picked_by]!.push(card);
  }
  for (const list of picks) list.sort((a, b) => a.round - b.round || a.pick_number! - b.pick_number!);
  for (const pack of packs.values()) pack.sort((a, b) => a.slot - b.slot);
  return { shape, cards, packs, picks, picked: [] };
}

export function takenFrom(table: Table, round: number, origin: number): number {
  let n = 0;
  for (const card of table.packs.get(packKey(round, origin)) ?? []) if (card.picked_by !== null) n += 1;
  return n;
}

export function turnOf(table: Table, seat: number): SeatTurn {
  return seatTurn(seat, table.picks[seat]!.length, (r, o) => takenFrom(table, r, o), table.shape);
}

/** The cards still in the pack a seat may pick from now, or null if it cannot pick. */
export function packInFront(table: Table, seat: number): TableCard[] | null {
  const turn = turnOf(table, seat);
  if (turn.kind !== "pick") return null;
  return (table.packs.get(packKey(turn.round, turn.origin)) ?? []).filter((c) => c.picked_by === null);
}

/**
 * Take `card` for `seat`. The caller has checked the card is in
 * `packInFront(table, seat)`; this re-checks, because a wrong pick here would
 * be written to the database as fact.
 */
export function takeCard(table: Table, seat: number, card: TableCard): void {
  const pack = packInFront(table, seat);
  if (!pack || !pack.includes(card)) throw new Error(`seat ${seat} cannot take that card now`);
  card.picked_by = seat;
  // 0-based within the round, and equal to the cards already gone from this
  // pack — see draft_cards.pick_number in 0008_drafts.sql.
  card.pick_number = table.picks[seat]!.length % table.shape.packSize;
  table.picks[seat]!.push(card);
  table.picked.push(card);
}

export function isComplete(table: Table): boolean {
  const { seatCount, packSize, packCount } = table.shape;
  return table.picks.reduce((n, list) => n + list.length, 0) === seatCount * packSize * packCount;
}

/**
 * Let every bot take every pick it can, round-robin one pick per bot per
 * pass, until a full pass picks nothing — which is when every bot is either
 * done or waiting on a person.
 *
 * Each pass that does not stop takes at least one card, so the loop ends
 * within (cards left + 1) passes. The bound is still enforced: a bug in the
 * position rule must surface as an error in one request, not as a request
 * that never returns while holding the pod's row lock.
 */
export function runBots(table: Table, botSeats: readonly number[], rng: Rng): number {
  const { seatCount, packSize, packCount } = table.shape;
  const maxPasses = seatCount * packSize * packCount + 1;
  let taken = 0;
  for (let pass = 0; pass <= maxPasses; pass += 1) {
    let progressed = false;
    for (const seat of botSeats) {
      const pack = packInFront(table, seat);
      if (!pack || pack.length === 0) continue;
      takeCard(table, seat, pickForBot(pack, table.picks[seat]!, rng));
      taken += 1;
      progressed = true;
    }
    if (!progressed) return taken;
  }
  throw new Error("draft bots did not settle; the position rule is broken");
}
