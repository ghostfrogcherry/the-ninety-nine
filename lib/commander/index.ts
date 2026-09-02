/**
 * Commander (EDH) deck legality validation.
 *
 * PURE FUNCTIONS ONLY. Nothing here touches the database. The caller loads the
 * cards (from `scryfall_cards`, from an API response, from a fixture) and hands
 * them in. That is deliberate:
 *
 *  - `scryfall_cards` is a rebuildable cache (see 0002_scryfall.sql). Validation
 *    logic must not take a dependency on it being present or fresh.
 *  - Deck rows (0004_decks.sql) intentionally have no FK into that cache, so the
 *    join happens in the caller anyway.
 *  - Every violation is returned at once. The UI renders a list, not a single
 *    first-failure, so these return structured results rather than throwing or
 *    returning a bare boolean.
 *
 * This module is a SINGLE FILE on purpose. The repo's tsconfig does not set
 * `allowImportingTsExtensions`, but `node --experimental-strip-types` requires
 * explicit `.ts` specifiers on relative imports. Splitting this into several
 * files would force one of those two tools to fail on every internal import, so
 * there are no internal imports at all.
 *
 * The rules implemented, per the comment block at the bottom of 0004_decks.sql:
 *
 *   1. SINGLETON       keyed on oracle_id, NOT on the printing's id.
 *   2. COLOUR IDENTITY subset of the commander's (union, for two commanders).
 *   3. BANNED          legalities->>'commander' != 'banned' ('not_legal' too,
 *                      reported separately because the reason differs).
 *   4. DECK SIZE       exactly 100 including the commander(s).
 *   5. COMMANDER       legendary creature, or "can be your commander".
 */

/* -------------------------------------------------------------------------- */
/* Card shape                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One face of a multi-face card, as Scryfall stores it in `card_faces`.
 *
 * Transform / modal_dfc / split / adventure cards leave the top-level
 * `type_line` and `oracle_text` null or summarised and put the real text here.
 */
export interface ScryfallCardFace {
  name?: string | null;
  type_line?: string | null;
  oracle_text?: string | null;
}

/**
 * The subset of `scryfall_cards` (0002_scryfall.sql) that legality needs.
 *
 * Column names are snake_case to match the table, so a `pg` row drops straight
 * in with no mapping layer. Nullability mirrors the DDL: `oracle_id` and
 * `color_identity` are NOT NULL there, `type_line` and `oracle_text` are not.
 */
export interface CommanderCard {
  /** Scryfall's per-printing UUID. Two printings of one card differ here. */
  id: string;
  /** Stable across printings. THIS is what singleton keys on. */
  oracle_id: string;
  name: string;

  set_code?: string | null;
  collector_number?: string | null;
  layout?: string | null;

  type_line?: string | null;
  oracle_text?: string | null;

  /**
   * Scryfall's own `color_identity`, verbatim. It already accounts for mana
   * symbols in rules text and for colour indicators, which a cost-derived
   * calculation would miss. Never recompute this from `mana_cost`.
   */
  color_identity: string[];

  /** `{"commander": "legal" | "banned" | "not_legal" | "restricted", ...}` */
  legalities?: Record<string, string> | null;

  card_faces?: ScryfallCardFace[] | null;
}

/** Mirrors `deck_cards.board`. */
export type DeckBoard = "main" | "commander" | "sideboard" | "maybe";

/** One `deck_cards` row joined to its card. */
export interface DeckEntry {
  card: CommanderCard;
  /** `deck_cards.quantity`, which the schema constrains to > 0. */
  quantity: number;
  /** Defaults to "main" when omitted. */
  board?: DeckBoard;
}

/* -------------------------------------------------------------------------- */
/* Result shape                                                                */
/* -------------------------------------------------------------------------- */

export type Severity = "error" | "warning";

/** Fine-grained reason for a single violation. */
export type ViolationRule =
  | "singleton"
  | "color_identity"
  | "banned"
  | "not_legal"
  | "unknown_legality"
  | "deck_size"
  | "commander_missing"
  | "commander_too_many"
  | "commander_eligibility"
  | "commander_partner";

/** Coarse grouping the UI renders as one pass/fail row. */
export type CheckId =
  | "deck_size"
  | "commander"
  | "singleton"
  | "color_identity"
  | "legality";

/** Enough to identify and link a printing without re-sending the whole card. */
export interface CardRef {
  id: string;
  oracle_id: string;
  name: string;
  set_code: string | null;
  collector_number: string | null;
}

export interface Violation {
  rule: ViolationRule;
  severity: Severity;
  /** Human-readable, already formatted for display. */
  message: string;
  /** Every printing implicated. Empty for deck-wide rules like deck_size. */
  cards: CardRef[];
}

export interface RuleCheck {
  check: CheckId;
  /** True when this check produced no error-severity violations. */
  ok: boolean;
  violations: Violation[];
}

export interface CommanderValidation {
  /** True when there are no error-severity violations. Warnings do not block. */
  legal: boolean;
  /** Total cards on the 'main' and 'commander' boards. */
  deckSize: number;
  commanders: CardRef[];
  /** Union of the commanders' identities, normalised to WUBRG order. */
  commanderColorIdentity: string[];
  checks: RuleCheck[];
  /** Flattened, in check order. */
  violations: Violation[];
  errors: Violation[];
  warnings: Violation[];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Canonical Commander colour order. */
const WUBRG = ["W", "U", "B", "R", "G"] as const;

const RE_LEGENDARY = /\blegendary\b/i;
const RE_CREATURE = /\bcreature\b/i;
const RE_BASIC = /\bbasic\b/i;
const RE_LAND = /\bland\b/i;
const RE_BACKGROUND = /\bbackground\b/i;

const RE_CAN_BE_COMMANDER = /can be your commander/i;

/**
 * Pairing keywords that let a deck run two commanders. Used only for a
 * non-blocking warning: we flag two commanders with no pairing mechanic
 * between them, but do not hard-fail, because new pairing keywords ship with
 * roughly every Commander product and a stale list must not lock a deck out.
 */
const RE_PAIRING =
  /\bpartner\b|friends forever|choose a background|doctor['’]s companion|\bdoctor\b/i;

function normalizeColor(c: string): string {
  return c.trim().toUpperCase();
}

/** Uppercase, de-duplicate, drop anything that is not WUBRG, sort WUBRG-wise. */
export function normalizeIdentity(identity: readonly string[] | null | undefined): string[] {
  const seen = new Set((identity ?? []).map(normalizeColor));
  return WUBRG.filter((c) => seen.has(c));
}

/** `{W}{U}` for display, or the word "colourless" for the empty identity. */
export function formatIdentity(identity: readonly string[]): string {
  const norm = normalizeIdentity(identity);
  return norm.length === 0 ? "colourless" : norm.map((c) => `{${c}}`).join("");
}

export function cardRef(card: CommanderCard): CardRef {
  return {
    id: card.id,
    oracle_id: card.oracle_id,
    name: card.name,
    set_code: card.set_code ?? null,
    collector_number: card.collector_number ?? null,
  };
}

/** `Sol Ring (C21 #263)` — enough for a human to find the exact printing. */
export function describeCard(card: CommanderCard): string {
  const set = card.set_code ? card.set_code.toUpperCase() : null;
  const num = card.collector_number ?? null;
  if (set && num) return `${card.name} (${set} #${num})`;
  if (set) return `${card.name} (${set})`;
  return card.name;
}

/**
 * Every type line on the card, split on ` // `.
 *
 * Split per half deliberately: an adventure like `Creature — Bear // Instant`
 * must not read as "has a Creature type AND has an Instant type" when the
 * question is really "is any single face BOTH legendary AND a creature".
 */
function typeSegments(card: CommanderCard): string[] {
  const out: string[] = [];
  const push = (line?: string | null): void => {
    if (!line) return;
    for (const part of line.split("//")) {
      const seg = part.trim();
      if (seg) out.push(seg);
    }
  };
  push(card.type_line);
  for (const face of card.card_faces ?? []) push(face.type_line);
  return out;
}

/** Top-level oracle text plus every face's, joined. */
function allOracleText(card: CommanderCard): string {
  const parts: string[] = [];
  if (card.oracle_text) parts.push(card.oracle_text);
  for (const face of card.card_faces ?? []) {
    if (face.oracle_text) parts.push(face.oracle_text);
  }
  return parts.join("\n");
}

function anySegment(card: CommanderCard, ...tests: RegExp[]): boolean {
  return typeSegments(card).some((seg) => tests.every((re) => re.test(seg)));
}

/* -------------------------------------------------------------------------- */
/* Card predicates                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Basic lands are exempt from singleton. Covers `Basic Land — Forest`,
 * `Basic Snow Land — Forest`, and `Basic Land` (Wastes).
 */
export function isBasicLand(card: CommanderCard): boolean {
  return anySegment(card, RE_BASIC, RE_LAND);
}

/** A single face that is both Legendary and a Creature. */
export function isLegendaryCreature(card: CommanderCard): boolean {
  return anySegment(card, RE_LEGENDARY, RE_CREATURE);
}

/** `Legendary Enchantment — Background`. */
export function isBackground(card: CommanderCard): boolean {
  return anySegment(card, RE_LEGENDARY, RE_BACKGROUND);
}

export type CommanderEligibility =
  | { eligible: true; via: "legendary_creature" | "can_be_your_commander" | "background" }
  | { eligible: false; via: null };

/**
 * A commander must be a legendary creature, or say it can be one.
 *
 * The text path covers planeswalkers printed with "<Name> can be your
 * commander" (Rowan, Will, Commander Legends walkers) and the Baldur's Gate
 * partner-likes.
 *
 * Backgrounds are accepted as a third path. Their own oracle text does NOT
 * contain "can be your commander" — the permission lives on the creature's
 * "Choose a Background" — so a strict two-path check would reject every
 * Background deck. Pairing sanity is handled separately, as a warning.
 */
export function commanderEligibility(card: CommanderCard): CommanderEligibility {
  if (isLegendaryCreature(card)) return { eligible: true, via: "legendary_creature" };
  if (RE_CAN_BE_COMMANDER.test(allOracleText(card))) {
    return { eligible: true, via: "can_be_your_commander" };
  }
  if (isBackground(card)) return { eligible: true, via: "background" };
  return { eligible: false, via: null };
}

/* -------------------------------------------------------------------------- */
/* Copy limits (the singleton exceptions)                                      */
/* -------------------------------------------------------------------------- */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** "A deck can have up to seven cards named Seven Dwarves." */
const RE_UP_TO = /a deck can have up to ([a-z]+|\d+) cards named/i;
/** "A deck can have any number of cards named Rat Colony." */
const RE_ANY_NUMBER = /a deck can have any number of cards named/i;

/**
 * Last-resort caps keyed on the folded card name, for the two cards whose
 * limit is a specific number. Names are folded to ASCII first so the entry
 * for "nazgul" matches Scryfall's "Nazgûl".
 */
const NAME_CAPS = new Map<string, number>([
  ["seven dwarves", 7],
  ["nazgul", 9],
]);

/** Lowercase and strip diacritics: "Nazgûl" -> "nazgul". */
function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export type CopyLimitReason = "singleton" | "basic_land" | "any_number" | "capped";

export interface CopyLimit {
  /** `Number.POSITIVE_INFINITY` when unlimited. Not JSON-safe; internal use. */
  limit: number;
  reason: CopyLimitReason;
}

/**
 * How many copies of this card one Commander deck may contain.
 *
 * Order matters. An explicit "up to N" is checked before the name table, and
 * the name table before the generic "any number of", so a card that carries a
 * known numeric cap can never fall through to unlimited.
 */
export function copyLimitFor(card: CommanderCard): CopyLimit {
  if (isBasicLand(card)) {
    return { limit: Number.POSITIVE_INFINITY, reason: "basic_land" };
  }

  const text = allOracleText(card);

  const upTo = text.match(RE_UP_TO);
  if (upTo) {
    const raw = upTo[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NUMBER_WORDS[raw];
    if (Number.isFinite(n) && n > 0) return { limit: n, reason: "capped" };
  }

  const byName = NAME_CAPS.get(foldName(card.name));
  if (byName !== undefined) return { limit: byName, reason: "capped" };

  if (RE_ANY_NUMBER.test(text)) {
    return { limit: Number.POSITIVE_INFINITY, reason: "any_number" };
  }

  return { limit: 1, reason: "singleton" };
}

/* -------------------------------------------------------------------------- */
/* Individual checks                                                           */
/* -------------------------------------------------------------------------- */

/** Boards that count toward the 100. Sideboard/maybe are working space. */
const COUNTED_BOARDS = new Set<DeckBoard>(["main", "commander"]);

function boardOf(entry: DeckEntry): DeckBoard {
  return entry.board ?? "main";
}

/** The 'main' + 'commander' entries, in input order. */
export function countedEntries(entries: readonly DeckEntry[]): DeckEntry[] {
  return entries.filter((e) => COUNTED_BOARDS.has(boardOf(e)));
}

export function commanderEntries(entries: readonly DeckEntry[]): DeckEntry[] {
  return entries.filter((e) => boardOf(e) === "commander");
}

export function deckSize(entries: readonly DeckEntry[]): number {
  return countedEntries(entries).reduce((sum, e) => sum + e.quantity, 0);
}

/**
 * RULE 2 (identity source): the union of every commander's identity.
 *
 * Partner, Friends forever, Background and Doctor's companion all produce two
 * commanders; the deck's identity is the union. One commander is just the
 * union of a single set.
 */
export function commanderColorIdentity(commanders: readonly CommanderCard[]): string[] {
  const union = new Set<string>();
  for (const c of commanders) {
    for (const color of normalizeIdentity(c.color_identity)) union.add(color);
  }
  return WUBRG.filter((c) => union.has(c));
}

/**
 * RULE 4 — deck size. Exactly 100, commander(s) included.
 */
export function checkDeckSize(entries: readonly DeckEntry[]): RuleCheck {
  const size = deckSize(entries);
  const violations: Violation[] = [];

  if (size !== 100) {
    const delta = 100 - size;
    const fix = delta > 0 ? `Add ${delta}.` : `Remove ${-delta}.`;
    violations.push({
      rule: "deck_size",
      severity: "error",
      message: `Deck has ${size} cards; Commander requires exactly 100 including the commander. ${fix}`,
      cards: [],
    });
  }

  return { check: "deck_size", ok: violations.length === 0, violations };
}

/**
 * RULE 5 — commander eligibility, plus arity sanity.
 */
export function checkCommanders(entries: readonly DeckEntry[]): RuleCheck {
  const commanders = commanderEntries(entries);
  const violations: Violation[] = [];

  if (commanders.length === 0) {
    violations.push({
      rule: "commander_missing",
      severity: "error",
      message: "Deck has no commander. Assign one card to the 'commander' board.",
      cards: [],
    });
  }

  if (commanders.length > 2) {
    violations.push({
      rule: "commander_too_many",
      severity: "error",
      message: `Deck has ${commanders.length} commanders; at most 2 are allowed (partner, Friends forever, Background, or Doctor's companion).`,
      cards: commanders.map((e) => cardRef(e.card)),
    });
  }

  for (const entry of commanders) {
    const eligibility = commanderEligibility(entry.card);
    if (!eligibility.eligible) {
      const typeLine = entry.card.type_line ?? "(no type line)";
      violations.push({
        rule: "commander_eligibility",
        severity: "error",
        message: `${describeCard(entry.card)} cannot be a commander. It is "${typeLine}" — a commander must be a legendary creature, or say it can be your commander.`,
        cards: [cardRef(entry.card)],
      });
    }
  }

  // Non-blocking: two commanders with no pairing mechanic between them.
  if (commanders.length === 2) {
    const paired = commanders.some(
      (e) => RE_PAIRING.test(allOracleText(e.card)) || isBackground(e.card),
    );
    if (!paired) {
      violations.push({
        rule: "commander_partner",
        severity: "warning",
        message: `${describeCard(commanders[0].card)} and ${describeCard(commanders[1].card)} show no pairing ability (partner, Friends forever, Choose a Background, Doctor's companion). Two commanders normally require one.`,
        cards: commanders.map((e) => cardRef(e.card)),
      });
    }
  }

  const ok = violations.every((v) => v.severity !== "error");
  return { check: "commander", ok, violations };
}

/**
 * RULE 1 — singleton, keyed on oracle_id.
 *
 * Grouping on `oracle_id` rather than `id` is the whole point: two different
 * printings of Sol Ring are two rows in `deck_cards` with different
 * `scryfall_id`s, one shared `oracle_id`, and one singleton violation.
 */
export function checkSingleton(entries: readonly DeckEntry[]): RuleCheck {
  interface Group {
    card: CommanderCard;
    total: number;
    printings: Map<string, CommanderCard>;
  }

  const groups = new Map<string, Group>();

  for (const entry of countedEntries(entries)) {
    const key = entry.card.oracle_id;
    const group = groups.get(key);
    if (group) {
      group.total += entry.quantity;
      if (!group.printings.has(entry.card.id)) {
        group.printings.set(entry.card.id, entry.card);
      }
    } else {
      groups.set(key, {
        card: entry.card,
        total: entry.quantity,
        printings: new Map([[entry.card.id, entry.card]]),
      });
    }
  }

  const violations: Violation[] = [];

  for (const group of groups.values()) {
    const { limit, reason } = copyLimitFor(group.card);
    if (group.total <= limit) continue;

    const printings = [...group.printings.values()];
    const allowance =
      reason === "capped"
        ? `its own text allows up to ${limit}`
        : "Commander allows 1";

    let message = `"${group.card.name}" appears ${group.total} times; ${allowance}.`;
    if (printings.length > 1) {
      message += ` Copies: ${printings.map(describeCard).join(", ")}. Different printings share one oracle_id and still break singleton.`;
    }

    violations.push({
      rule: "singleton",
      severity: "error",
      message,
      cards: printings.map(cardRef),
    });
  }

  return { check: "singleton", ok: violations.length === 0, violations };
}

/**
 * RULE 2 — colour identity.
 *
 * Every card's identity must be a SUBSET of the commander's. A colourless
 * commander yields the empty set, and only the empty set is a subset of it, so
 * colourless-only falls out with no special case.
 *
 * Returns no violations when there is no commander — there is nothing to
 * compare against, and `checkCommanders` already reports the real problem.
 */
export function checkColorIdentity(entries: readonly DeckEntry[]): RuleCheck {
  const commanders = commanderEntries(entries).map((e) => e.card);
  const violations: Violation[] = [];

  if (commanders.length === 0) {
    return { check: "color_identity", ok: true, violations };
  }

  const allowed = new Set(commanderColorIdentity(commanders));
  const allowedLabel = formatIdentity([...allowed]);

  for (const entry of countedEntries(entries)) {
    const identity = normalizeIdentity(entry.card.color_identity);
    const outside = identity.filter((c) => !allowed.has(c));
    if (outside.length === 0) continue;

    violations.push({
      rule: "color_identity",
      severity: "error",
      message: `${describeCard(entry.card)} has colour identity ${formatIdentity(identity)}, which is outside the commander's ${allowedLabel}. Offending: ${formatIdentity(outside)}.`,
      cards: [cardRef(entry.card)],
    });
  }

  return { check: "color_identity", ok: violations.length === 0, violations };
}

/**
 * RULE 3 — banned list.
 *
 * 'banned' and 'not_legal' are both unplayable but are reported as distinct
 * rules: 'banned' is a Rules Committee decision about a legal-to-own card,
 * 'not_legal' means the card was never Commander-legal at all (un-sets,
 * Conspiracy, playtest cards, Alchemy rebalances). The fixes differ, so the
 * messages do too.
 *
 * A missing 'commander' key is a warning, not an error — that means the local
 * Scryfall mirror is stale or the row was never resolved, which is a data
 * problem rather than a deck problem, and must not silently pass as legal.
 */
export function checkLegality(entries: readonly DeckEntry[]): RuleCheck {
  const violations: Violation[] = [];

  for (const entry of countedEntries(entries)) {
    const status = entry.card.legalities?.commander;

    if (status === "banned") {
      violations.push({
        rule: "banned",
        severity: "error",
        message: `${describeCard(entry.card)} is banned in Commander.`,
        cards: [cardRef(entry.card)],
      });
    } else if (status === "not_legal") {
      violations.push({
        rule: "not_legal",
        severity: "error",
        message: `${describeCard(entry.card)} is not legal in Commander — it was never legal in the format (un-set, Conspiracy, playtest or digital-only card), rather than banned.`,
        cards: [cardRef(entry.card)],
      });
    } else if (status === undefined || status === null || status === "") {
      violations.push({
        rule: "unknown_legality",
        severity: "warning",
        message: `${describeCard(entry.card)} has no Commander legality recorded. The Scryfall mirror may be stale; legality could not be confirmed.`,
        cards: [cardRef(entry.card)],
      });
    }
  }

  const ok = violations.every((v) => v.severity !== "error");
  return { check: "legality", ok, violations };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run every Commander legality check and return all violations at once.
 *
 * `entries` is the deck as `deck_cards` stores it: one entry per row, with the
 * commander(s) on the 'commander' board. 'sideboard' and 'maybe' entries are
 * ignored entirely — they are working space, not part of the deck.
 */
export function validateCommanderDeck(entries: readonly DeckEntry[]): CommanderValidation {
  const checks: RuleCheck[] = [
    checkDeckSize(entries),
    checkCommanders(entries),
    checkSingleton(entries),
    checkColorIdentity(entries),
    checkLegality(entries),
  ];

  const violations = checks.flatMap((c) => c.violations);
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const commanders = commanderEntries(entries).map((e) => e.card);

  return {
    legal: errors.length === 0,
    deckSize: deckSize(entries),
    commanders: commanders.map(cardRef),
    commanderColorIdentity: commanderColorIdentity(commanders),
    checks,
    violations,
    errors,
    warnings,
  };
}
