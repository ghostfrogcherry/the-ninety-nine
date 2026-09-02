/**
 * Parser for the Moxfield/MTGO-style plain-text collection export:
 *
 *     1 Growing Ranks (C19) 193
 *     2 Makindi Stampede // Makindi Mesas (ZNR) 26
 *     1 Reflections of Littjara (KHM) 400 *F*
 *
 * This is the format the real collection export uses — NOT ManaBox CSV.
 * Validated against all 1457 lines of the first scan batch.
 *
 * Things the real data proves, which a naive parser gets wrong:
 *
 *  - Collector numbers are NOT integers. The live file contains `19b`, `33a`,
 *    `278s`, `S4`, `CHK-19`, `DDE-48`, `SHM-237`, `et45sb`, `pp319sb`.
 *    Parsing these with parseInt() silently corrupts them (`pp319sb` -> 319).
 *
 *  - Card names contain ` // ` (52 lines: split cards and modal DFCs). The set
 *    code must be located from the RIGHT, or a greedy match eats the name.
 *
 *  - Foil is a per-line variant, not a per-card property. The same printing can
 *    appear twice, once plain and once `*F*`. 16 printings do exactly that, so
 *    1457 lines collapse to 1441 distinct Scryfall IDs. Deduplicating on card
 *    identity alone loses those foils.
 */

export type Finish = "nonfoil" | "foil" | "etched";

export interface ParsedLine {
  quantity: number;
  name: string;
  setCode: string;
  collectorNumber: string;
  finish: Finish;
  lineNumber: number;
  raw: string;
}

export interface ParseError {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  cards: ParsedLine[];
  errors: ParseError[];
  /** Distinct parsed lines. */
  totalLines: number;
  /** Sum of quantities — the number of physical cards. */
  totalCards: number;
}

/**
 * Anchored at both ends and non-greedy on the name, with the set code matched
 * as the LAST parenthesised group before a trailing token. `.+?` on the name
 * plus the anchored tail is what keeps ` // ` names intact.
 */
const LINE_RE =
  /^(\d+)\s+(.+?)\s+\(([A-Za-z0-9_]+)\)\s+(\S+?)((?:\s+\*[A-Za-z]+\*)*)\s*$/;

/** Trailing markers: *F* foil, *E* etched. Moxfield emits these uppercase. */
function finishFromMarkers(markers: string): Finish {
  const m = markers.toUpperCase();
  if (m.includes("*E*")) return "etched";
  if (m.includes("*F*")) return "foil";
  return "nonfoil";
}

export function parseMoxfieldText(input: string): ParseResult {
  const cards: ParsedLine[] = [];
  const errors: ParseError[] = [];

  const lines = input.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = i + 1;
    const trimmed = raw.trim();

    // Blank lines and comments are structure, not failures.
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    // Section headers Moxfield/Archidekt emit when exporting a deck rather
    // than a collection. Skipped silently so a deck export does not produce
    // a wall of bogus "no_match" issues.
    if (/^(deck|sideboard|maybeboard|commander|companion|tokens?)\b:?\s*$/i.test(trimmed)) {
      continue;
    }

    const m = trimmed.match(LINE_RE);
    if (!m) {
      errors.push({ lineNumber, raw, reason: "parse_error" });
      continue;
    }

    const [, qty, name, setCode, collectorNumber, markers] = m;
    const quantity = Number.parseInt(qty, 10);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({ lineNumber, raw, reason: "invalid_quantity" });
      continue;
    }

    cards.push({
      quantity,
      name: name.trim(),
      // Scryfall set codes are lowercase in its API; the export is uppercase.
      setCode: setCode.toLowerCase(),
      // Kept as a string, deliberately. See the header note.
      collectorNumber: collectorNumber.trim(),
      finish: finishFromMarkers(markers ?? ""),
      lineNumber,
      raw,
    });
  }

  return {
    cards,
    errors,
    totalLines: cards.length,
    totalCards: cards.reduce((sum, c) => sum + c.quantity, 0),
  };
}

/**
 * Merge duplicate entries. The first scan batch happens to contain none, but
 * an incremental re-scan of the same shelf will, and summing is the only
 * correct answer once it does.
 *
 * The key is (setCode, collectorNumber, finish) — NOT the name, and NOT the
 * printing alone. Folding foil into non-foil here is the exact bug that would
 * lose the 16 foil/plain pairs in the live data.
 */
export function mergeDuplicates(cards: ParsedLine[]): ParsedLine[] {
  const byKey = new Map<string, ParsedLine>();

  for (const card of cards) {
    const key = `${card.setCode}|${card.collectorNumber.toLowerCase()}|${card.finish}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      byKey.set(key, { ...card });
    }
  }

  return [...byKey.values()];
}
