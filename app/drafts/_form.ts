/**
 * The pure half of the draft pages: parsing what the forms post, the prose for
 * the failures a person can cause, and the arithmetic the table view does over
 * mana costs. Everything the pages and actions *decide* lives here, so
 * test/draft-form.test.ts can hold it still without a Next server.
 *
 * Dependency-free at runtime on purpose, like app/d/_share.ts: Node's
 * --experimental-strip-types does no module resolution and cannot follow the
 * `@/*` alias. The one import is type-only and is erased before Node sees it.
 *
 * Next only routes `page`/`route`/`layout` files, so this file does not create
 * a `/drafts/_form` URL.
 */

import type { DraftCardView, DraftError } from "../../lib/draft/types";

/* ------------------------------------------------------------------ *
 * Form input
 *
 * The create form's numbers, the set code and the invite slug are parsed by
 * lib/draft's own helpers (parseSeatCount, parseSetCode, isPlausibleJoinSlug
 * and friends) and ids by lib/deck's parseId, so the page and the engine
 * cannot disagree about what is in range. Only the page's own input is here.
 * ------------------------------------------------------------------ */

/** Seats offered by default: a full table, bots filling whatever is left. */
export const DEFAULT_SEATS = 8;

/** Matches parseDeckName's cap, which the engine's parseDraftName is: the pod's
 *  name becomes the saved deck's name. */
export const DRAFT_NAME_MAX = 120;

/** The `?q=` set filter. Capped rather than rejected; it only ever narrows a
 *  list, and the engine escapes it before it reaches an ILIKE. */
export function parseSetSearch(value: unknown): string {
  return (typeof value === "string" ? value.trim() : "").slice(0, 60);
}

/* ------------------------------------------------------------------ *
 * Failures a person can cause
 *
 * The pattern of IMPORT_ERROR_TEXT / parseImportError in lib/import/form.ts:
 * an action that fails redirects with `?err=<code>`, and the page turns a code
 * it recognises into a sentence. The query string is user-editable, so an
 * unknown code renders nothing rather than being echoed back.
 * ------------------------------------------------------------------ */

export const ERR_PARAM = "err";

export const DRAFT_ERRORS = [
  "not_found", "not_lobby", "full", "not_creator", "unknown_set",
  "too_few_cards", "not_your_turn", "not_in_pack", "done",
] as const satisfies readonly DraftError[];

// Fails typechecking if lib/draft/types.ts grows a code this list lacks, so a
// new engine failure cannot quietly render as no message at all.
type Missing = Exclude<DraftError, (typeof DRAFT_ERRORS)[number]>;
const exhaustive: [Missing] extends [never] ? true : Missing = true;
void exhaustive;

export const DRAFT_ERROR_TEXT: Record<DraftError, string> = {
  not_found: "That pod no longer exists.",
  not_lobby: "That draft has already started, so it cannot take new players.",
  full: "Every seat at that table already has a person in it.",
  not_creator: "Only the person who created this pod can start it.",
  unknown_set: "That set is not in the local card mirror. Pick one from the list.",
  too_few_cards:
    "That set does not have enough different cards to fill a pack that size. " +
    "Try smaller packs, or another set.",
  // Two actions can hear this: a pick with no pack in front of you, and a save
  // before your last pick. One sentence has to be true of both.
  not_your_turn:
    "Not yet — there is no pack in front of you right now, and a pool can only be " +
    "saved once you have made your last pick.",
  not_in_pack: "That card is no longer in the pack in front of you. Here is the pack as it is now.",
  done: "The draft is over; every card has been taken.",
};

export function parseDraftError(value: unknown): DraftError | null {
  return typeof value === "string" && (DRAFT_ERRORS as readonly string[]).includes(value)
    ? (value as DraftError)
    : null;
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/**
 * Which way packs travel in a 0-based round. 0008_drafts.sql: seat+1 in the
 * 1st, 3rd, 5th pack, seat-1 in the others — left, right, left, as at a real
 * table, which is what keeps one neighbour from feeding you all three packs.
 */
export function passDirection(round: number): "left" | "right" {
  return round % 2 === 0 ? "left" : "right";
}

/** The seat a pack goes to next from `seat`, wrapping round the table. */
export function passesTo(seat: number, round: number, seatCount: number): number {
  const step = passDirection(round) === "left" ? 1 : -1;
  return (seat + step + seatCount) % seatCount;
}

/**
 * `{2}{U}{U}` → `["2", "U", "U"]`. A split or double-faced cost keeps its
 * separator as `"//"`, so the page can draw both halves without guessing where
 * one ends. Anything that is not a braced symbol is dropped rather than drawn.
 */
export function manaSymbols(cost: string | null | undefined): string[] {
  if (!cost) return [];
  const out: string[] = [];
  for (const part of cost.split("//").map((p) => p.trim())) {
    if (out.length) out.push("//");
    for (const m of part.matchAll(/\{([^{}]{1,8})\}/g)) out.push(m[1].toUpperCase());
  }
  return out;
}

/**
 * Mana value from a printed cost.
 *
 * DraftCardView carries the cost but not Scryfall's `cmc`, so the picks panel
 * sorts on this instead. Rules 202.3: X is 0, a hybrid `{2/W}` is its largest
 * half, Phyrexian `{W/P}` is 1, a half-mana `{HW}` is ½ — and a split card
 * adds both halves, which is why every half is summed here.
 */
export function manaValue(cost: string | null | undefined): number {
  let total = 0;
  for (const sym of manaSymbols(cost)) {
    if (sym === "//" || sym === "X" || sym === "Y" || sym === "Z") continue;
    if (/^\d+$/.test(sym)) { total += Number(sym); continue; }
    if (sym.startsWith("H")) { total += 0.5; continue; }
    const halves = sym.split("/").map((h) => (/^\d+$/.test(h) ? Number(h) : 1));
    total += Math.max(...halves);
  }
  return total;
}

/** Colour groups in the picks panel, in WUBRG order and then the leftovers. */
export const PICK_GROUPS = ["W", "U", "B", "R", "G", "multi", "colorless", "land"] as const;
export type PickGroup = (typeof PICK_GROUPS)[number];

export const PICK_GROUP_LABELS: Record<PickGroup, string> = {
  W: "White", U: "Blue", B: "Black", R: "Red", G: "Green",
  multi: "Multicolour", colorless: "Colourless", land: "Lands",
};

const WUBRG = ["W", "U", "B", "R", "G"];

/**
 * Where a card sits in the picks panel.
 *
 * Lands first, judged on the FRONT face only — a modal double-faced spell with
 * a land on its back ("Instant // Land") is still a spell you cast, and filing
 * it under Lands would hide it from the colour it asks you to be. Colour comes
 * from `colors` when the mirror has it; a double-faced card carries its colours
 * on its faces and arrives here as null, so the cost is the fallback.
 */
export function pickGroup(card: Pick<DraftCardView, "colors" | "mana_cost" | "type_line">): PickGroup {
  const front = (card.type_line ?? "").split("//")[0];
  if (/\bLand\b/.test(front)) return "land";
  const colours = card.colors
    ?? [...new Set(manaSymbols(card.mana_cost).flatMap((s) => s.split("/")).filter((c) => WUBRG.includes(c)))];
  if (colours.length > 1) return "multi";
  if (colours.length === 1 && WUBRG.includes(colours[0])) return colours[0] as PickGroup;
  return "colorless";
}

export interface PickGroupView<C> {
  group: PickGroup;
  label: string;
  cards: C[];
}

/** Picks grouped by colour, each group sorted by mana value then name. Empty
 *  groups are left out: a mono-red drafter does not need five "0" headings. */
export function groupPicks<C extends Pick<DraftCardView, "colors" | "mana_cost" | "type_line" | "name">>(
  picks: readonly C[],
): PickGroupView<C>[] {
  const by = new Map<PickGroup, C[]>();
  for (const c of picks) {
    const g = pickGroup(c);
    by.set(g, [...(by.get(g) ?? []), c]);
  }
  return PICK_GROUPS.filter((g) => by.has(g)).map((g) => ({
    group: g,
    label: PICK_GROUP_LABELS[g],
    cards: [...by.get(g)!].sort(
      (a, b) => manaValue(a.mana_cost) - manaValue(b.mana_cost) || a.name.localeCompare(b.name),
    ),
  }));
}

/** Nonland picks by mana value, 0..6 and 7+, for the little curve. */
export function pickCurve(picks: readonly Pick<DraftCardView, "mana_cost" | "type_line" | "colors">[]): number[] {
  const buckets = new Array(8).fill(0) as number[];
  for (const c of picks) {
    if (pickGroup(c) === "land") continue;
    buckets[Math.min(7, Math.floor(manaValue(c.mana_cost)))] += 1;
  }
  return buckets;
}

/**
 * The invite as something to paste into a chat. Absolute when AUTH_URL is set
 * — never built from the request's Host header, for the reason appBaseUrl()
 * in lib/auth/mail.ts gives — and a bare path otherwise, which is still right
 * for anyone on the same box.
 */
export function invitePath(slug: string): string {
  return `/drafts/join/${encodeURIComponent(slug)}`;
}

export function inviteUrl(slug: string, base: string | null): string {
  return base ? `${base}${invitePath(slug)}` : invitePath(slug);
}
