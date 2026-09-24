/**
 * Pack opening and bot picks — pure, no database.
 *
 * Everything random takes an injected `Rng` so a test can replay a pod exactly;
 * the engine passes `Math.random`. Nothing here is security-sensitive: knowing
 * the next pack in a friends' draft wins you a Limited deck, not an account.
 *
 * This file imports nothing, and ./table.ts only this file. The files of
 * lib/draft reach each other with an explicit `.ts` extension, for the reason
 * in lib/prices/index.ts: the tests load them under Node's type stripping,
 * which does no module resolution.
 */

/** A source of floats in [0, 1). `Math.random` in the app, seeded in tests. */
export type Rng = () => number;

/* ------------------------------------------------------------------ *
 * Eligibility
 * ------------------------------------------------------------------ */

/** The subset of a `scryfall_cards` row that deciding eligibility needs. */
export interface MirrorPrinting {
  id: string;
  oracle_id: string;
  name: string;
  collector_number: string;
  rarity: string;
  layout: string;
  type_line: string | null;
  colors: string[] | null;
  color_identity: string[] | null;
  /** Scryfall's `booster`. NULL = not known (pre-0008 row, or the demo fixture). */
  booster: boolean | null;
}

/**
 * Layouts that are not a card you could open and play. Tokens and emblems are
 * in a set's rows because Scryfall files them there (and a real pack's token
 * slot is not a pick); art cards are the art-series inserts. All of them are
 * also why the fallback to "every row of the set" is safe: without this list,
 * a set with unknown `booster` would deal Soldier tokens as commons.
 *
 * Shared with the SQL in ./index.ts (bound as a parameter), so the listing's
 * card counts and the packs cannot disagree about what counts.
 */
export const EXCLUDED_LAYOUTS: readonly string[] = ["token", "double_faced_token", "art_series", "emblem"];

/**
 * Basic lands are excluded: a pack's basic-land slot is not a pick anyone
 * makes, and each drafter adds basics when building. `Basic ` rather than
 * `Basic Land` so Snow-Covered basics ("Basic Snow Land — Forest"), which
 * Kaldheim-style sets carry in their rows, go too. Only lands have the Basic
 * supertype, so nothing else matches.
 */
export function isBasicLand(typeLine: string | null): boolean {
  return typeLine !== null && typeLine.startsWith("Basic ");
}

/** The same test, for SQL: `type_line NOT LIKE` this. */
export const BASIC_LAND_LIKE = "Basic %";

/**
 * Collector-number order: numeric prefix first, then the whole string.
 *
 * Collector numbers are TEXT (`19b`, `S4`, `CHK-19`, `pp319sb`). Comparing as
 * strings puts `100` before `27`; `parseInt` reads `pp319sb` as 319. So the
 * leading digits, if any, compare as a number, a number with no leading digits
 * sorts after every one that has them, and the raw string breaks ties
 * (`19` before `19b`).
 */
export function compareCollectorNumbers(a: string, b: string): number {
  const pa = /^\d+/.exec(a);
  const pb = /^\d+/.exec(b);
  const na = pa ? Number(pa[0]) : Number.POSITIVE_INFINITY;
  const nb = pb ? Number(pb[0]) : Number.POSITIVE_INFINITY;
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The printings of one set that can appear in a pack, one per card.
 *
 *  1. `booster = true` rows, if any row of the set has `booster` known. A set's
 *     rows include showcase frames, extended art and collector-booster extras
 *     that would otherwise triple every rare. If no row knows (every row NULL —
 *     data from before 0008, or the demo fixture), fall back to every row
 *     rather than refusing to draft a set the next refresh would allow.
 *  2. Minus basic lands and non-card layouts (see EXCLUDED_LAYOUTS).
 *  3. One printing per oracle_id, the lowest collector number: the numbered
 *     main-set printing rather than a variant. This is what makes "no duplicate
 *     within a pack" a property of sampling without replacement.
 *
 * Output is sorted by collector number, so the same rows in any order give
 * the same pool — which is what lets a seeded test replay a pod exactly.
 */
export function eligibleCards<T extends MirrorPrinting>(rows: readonly T[]): T[] {
  const known = rows.some((r) => r.booster !== null);
  const byOracle = new Map<string, T>();
  for (const row of rows) {
    if (known && row.booster !== true) continue;
    if (EXCLUDED_LAYOUTS.includes(row.layout)) continue;
    if (isBasicLand(row.type_line)) continue;
    const kept = byOracle.get(row.oracle_id);
    if (!kept || compareCollectorNumbers(row.collector_number, kept.collector_number) < 0) {
      byOracle.set(row.oracle_id, row);
    }
  }
  return [...byOracle.values()].sort(
    (a, b) => compareCollectorNumbers(a.collector_number, b.collector_number) || (a.id < b.id ? -1 : 1),
  );
}

/* ------------------------------------------------------------------ *
 * Rarity
 * ------------------------------------------------------------------ */

export type RarityClass = "mythic" | "rare" | "uncommon" | "common";

/**
 * Scryfall's rarities folded to the four a pack is built from. `special`
 * (Time Spiral's timeshifted cards) and `bonus` (Brothers' War retro
 * artifacts, Strixhaven's Mystical Archive) sit in the rare slot's place; an
 * unknown future rarity is treated as common rather than crashing a draft.
 */
export function rarityClass(rarity: string): RarityClass {
  switch (rarity) {
    case "mythic":
      return "mythic";
    case "rare":
    case "special":
    case "bonus":
      return "rare";
    case "uncommon":
      return "uncommon";
    default:
      return "common";
  }
}

/**
 * Where a slot looks when its own rarity has run dry in this pack: the
 * nearest rarity first. A tiny or odd set (a Masters set with few commons, a
 * fixture) still gets full packs rather than short ones — a short pack would
 * break the position rule, which assumes every pack has pack_size cards.
 */
const FALLBACK: Record<RarityClass, readonly RarityClass[]> = {
  mythic: ["mythic", "rare", "uncommon", "common"],
  rare: ["rare", "mythic", "uncommon", "common"],
  uncommon: ["uncommon", "common", "rare", "mythic"],
  common: ["common", "uncommon", "rare", "mythic"],
};

/** Chance the rare slot is a mythic, when the set has any: one pack in eight. */
export const MYTHIC_CHANCE = 1 / 8;

/** Uncommons per pack; the rest after the rare slot are commons. */
export const UNCOMMONS_PER_PACK = 3;

/* ------------------------------------------------------------------ *
 * Opening packs
 * ------------------------------------------------------------------ */

function bucketsOf<T extends { rarity: string }>(pool: readonly T[]): Record<RarityClass, T[]> {
  const out: Record<RarityClass, T[]> = { mythic: [], rare: [], uncommon: [], common: [] };
  for (const card of pool) out[rarityClass(card.rarity)].push(card);
  return out;
}

/**
 * The rarity each slot of a pack asks for, rare slot first: a simplified
 * draft booster of 1 rare-or-mythic, 3 uncommons and commons for the rest.
 * The rare slot is a mythic with probability MYTHIC_CHANCE when the set has
 * mythics at all; a set with none always asks for a rare, rather than having
 * one pack in eight fall through to an uncommon.
 */
export function slotPlan(packSize: number, hasMythics: boolean, rng: Rng): RarityClass[] {
  const plan: RarityClass[] = [hasMythics && rng() < MYTHIC_CHANCE ? "mythic" : "rare"];
  for (let i = 1; i < packSize; i += 1) plan.push(i <= UNCOMMONS_PER_PACK ? "uncommon" : "common");
  return plan;
}

/**
 * Open one pack from an eligible pool (the output of `eligibleCards`).
 *
 * Sampling is without replacement within the pack, from a pool that already
 * holds one printing per oracle_id — so a pack never repeats a card. Across
 * packs it is with replacement, as real boosters are: two packs of one pod
 * may well share a common.
 *
 * Throws when the pool is smaller than the pack: callers check
 * `pool.length >= packSize` first and turn it into `too_few_cards`, so
 * reaching this is a bug, not a person's mistake.
 */
export function openPack<T extends { rarity: string }>(pool: readonly T[], packSize: number, rng: Rng): T[] {
  if (pool.length < packSize) {
    throw new Error(`cannot open a ${packSize}-card pack from ${pool.length} eligible cards`);
  }
  // Fresh copies per pack: sampling removes from them.
  const buckets = bucketsOf(pool);
  const plan = slotPlan(packSize, buckets.mythic.length > 0, rng);
  const pack: T[] = [];
  for (const want of plan) {
    for (const rarity of FALLBACK[want]) {
      const bucket = buckets[rarity];
      if (bucket.length === 0) continue;
      const i = Math.floor(rng() * bucket.length);
      pack.push(bucket[i]!);
      // Swap-remove: order within a bucket carries no meaning.
      bucket[i] = bucket[bucket.length - 1]!;
      bucket.pop();
      break;
    }
  }
  return pack;
}

/* ------------------------------------------------------------------ *
 * Bot picks
 * ------------------------------------------------------------------ */

/** What a bot looks at on a card. */
export interface BotCard {
  rarity: string;
  colors: string[] | null;
  color_identity?: string[] | null;
}

const RARITY_WEIGHT: Record<RarityClass, number> = { mythic: 4, rare: 3, uncommon: 2, common: 1 };

/**
 * Worth one and a half rarity steps: an on-colour uncommon beats an
 * off-colour rare, an on-colour common does not. Enough that a bot ends up
 * with a playable two-colour pile, not so much that it passes a bomb.
 */
export const COLOUR_BONUS = 1.5;

/** Picks before a bot has "colours" at all. Before that it takes the best card. */
export const COLOUR_COMMIT_PICKS = 3;

/** Only breaks ties. Far below the smallest real difference (0.5). */
const TIE_BREAK = 0.01;

const WUBRG = ["W", "U", "B", "R", "G"];

/**
 * A card's colours for drafting purposes: what it costs to cast. Multi-face
 * cards have no top-level `colors` in the mirror (card-row.mjs keeps it NULL),
 * so they fall back to colour identity rather than reading as colourless.
 */
export function cardColours(card: BotCard): string[] {
  return card.colors ?? card.color_identity ?? [];
}

/**
 * The two colours a bot is in: the two it holds the most cards of, counting a
 * gold card once per colour. Ties go in WUBRG order so a replay is exact.
 * Empty until COLOUR_COMMIT_PICKS picks have at least one colour between them.
 */
export function botColours(picks: readonly BotCard[]): string[] {
  const counts = new Map<string, number>();
  let coloured = 0;
  for (const card of picks) {
    const colours = cardColours(card);
    if (colours.length > 0) coloured += 1;
    for (const c of colours) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (coloured < COLOUR_COMMIT_PICKS) return [];
  return WUBRG.filter((c) => counts.has(c))
    .sort((a, b) => counts.get(b)! - counts.get(a)! || WUBRG.indexOf(a) - WUBRG.indexOf(b))
    .slice(0, 2);
}

/**
 * How much a bot wants a card:
 *
 *   rarity weight (mythic 4, rare 3, uncommon 2, common 1)
 *   + COLOUR_BONUS if the bot has colours and every colour of the card is one
 *     of them — colourless cards (artifacts, Eldrazi) always count as
 *     on-colour, since any deck can play them
 *
 * Deliberately crude and explainable. Rarity stands in for power, which is
 * roughly how a set is designed; the colour bonus is what makes a bot's pile
 * a deck rather than a binder of rares. It knows nothing about curve or
 * synergy, and a person drafting against it should be able to predict it.
 */
export function botScore(card: BotCard, colours: readonly string[]): number {
  let score = RARITY_WEIGHT[rarityClass(card.rarity)];
  if (colours.length > 0 && cardColours(card).every((c) => colours.includes(c))) score += COLOUR_BONUS;
  return score;
}

/**
 * The card a bot takes: highest `botScore`, with a tiny random nudge so equal
 * cards (two commons of its colour) are not always resolved by pack order.
 */
export function pickForBot<T extends BotCard>(pack: readonly T[], picksSoFar: readonly BotCard[], rng: Rng): T {
  if (pack.length === 0) throw new Error("a bot cannot pick from an empty pack");
  const colours = botColours(picksSoFar);
  let best = pack[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const card of pack) {
    const score = botScore(card, colours) + rng() * TIE_BREAK;
    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }
  return best;
}
