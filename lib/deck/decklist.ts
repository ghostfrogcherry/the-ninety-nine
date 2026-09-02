/**
 * Parser for pasted decklists.
 *
 * Deliberately separate from lib/import/moxfield-text.ts. That one is strict —
 * it requires `(SET) collector` on every line, because a collection export
 * always has it and a missing set there means a corrupt file. A decklist copied
 * off a forum, a primer, or another deckbuilder usually has none of that:
 *
 *     1 Sol Ring                       <- the common case
 *     1x Sol Ring                      <- Archidekt/TappedOut style
 *     1 Sol Ring (C19) 221             <- Moxfield style
 *     1 Sol Ring (C19) 221 *F*         <- with finish
 *     Commander                        <- section header, assigns the board
 *     SB: 1 Sol Ring                   <- MTGO sideboard prefix
 *
 * Being strict here would reject most real input, so this accepts a bare name
 * and lets the resolver find a printing. What it will NOT do is guess at a line
 * it cannot parse — those come back as errors and are shown to the user rather
 * than silently dropped.
 */

import type { DeckBoard } from "@/lib/commander";

export interface DeckListLine {
  quantity: number;
  name: string;
  /** Present only when the line carried one. */
  setCode: string | null;
  collectorNumber: string | null;
  finish: "nonfoil" | "foil" | "etched";
  board: DeckBoard;
  lineNumber: number;
  raw: string;
}

export interface DeckListError {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface DeckListParse {
  lines: DeckListLine[];
  errors: DeckListError[];
  /** Sum of quantities — the number of physical cards the list describes. */
  totalCards: number;
}

/**
 * Section headers. Matched on a line of their own, and they switch the board
 * for everything after until the next header.
 *
 * "Deck", "Mainboard" and "Maybeboard" all appear in the wild; so does a bare
 * "Sideboard". `Companion` is treated as sideboard rather than invented as its
 * own board, since deck_cards.board has no such value.
 */
const HEADERS: Array<[RegExp, DeckBoard]> = [
  [/^(commanders?)\b/i, "commander"],
  [/^(deck|mainboard|main)\b/i, "main"],
  [/^(sideboard|companion)\b/i, "sideboard"],
  [/^(maybe ?board|considering)\b/i, "maybe"],
];

/**
 * One line of a list.
 *
 *   qty      1  |  1x  |  1X
 *   name     everything up to an optional trailing (SET) collector
 *   set      optional, parenthesised
 *   number   optional, only meaningful with a set
 *   markers  optional *F* / *E*
 *
 * The name is non-greedy and the tail is anchored, so " // " in a split card's
 * name survives — the same reason moxfield-text.ts matches the set from the
 * right.
 */
const LINE_RE =
  /^(\d+)\s*[xX]?\s+(.+?)(?:\s+\(([A-Za-z0-9_]+)\)(?:\s+(\S+?))?)?((?:\s+\*[A-Za-z]+\*)*)\s*$/;

/** MTGO-style `SB:` / `MB:` prefixes, which override the current section. */
const PREFIX_RE = /^(SB|MB|CM):\s*/i;
const PREFIX_BOARD: Record<string, DeckBoard> = { SB: "sideboard", MB: "main", CM: "commander" };

function finishFrom(markers: string): DeckListLine["finish"] {
  const m = markers.toUpperCase();
  if (m.includes("*E*")) return "etched";
  if (m.includes("*F*")) return "foil";
  return "nonfoil";
}

export function parseDeckList(input: string, defaultBoard: DeckBoard = "main"): DeckListParse {
  const lines: DeckListLine[] = [];
  const errors: DeckListError[] = [];
  let board: DeckBoard = defaultBoard;

  const raw = input.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const lineNumber = i + 1;
    let text = raw[i].trim();

    // Blank lines and comments are structure, not failures.
    if (text === "" || text.startsWith("#") || text.startsWith("//")) continue;

    // A header on its own line switches the board for what follows. Checked
    // before the line regex, since "Commander" alone has no quantity and would
    // otherwise be reported as a parse error.
    const header = HEADERS.find(([re]) => re.test(text) && !/^\d/.test(text));
    if (header && !/\d/.test(text.replace(/^\D+/, "").slice(0, 1))) {
      board = header[1];
      continue;
    }

    let lineBoard = board;
    const prefix = text.match(PREFIX_RE);
    if (prefix) {
      lineBoard = PREFIX_BOARD[prefix[1].toUpperCase()] ?? board;
      text = text.slice(prefix[0].length).trim();
    }

    const m = text.match(LINE_RE);
    if (!m) {
      errors.push({ lineNumber, raw: raw[i], reason: "could not read a quantity and card name" });
      continue;
    }

    const quantity = Number.parseInt(m[1], 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({ lineNumber, raw: raw[i], reason: "quantity must be a positive number" });
      continue;
    }

    lines.push({
      quantity,
      name: m[2].trim(),
      setCode: m[3] ? m[3].toLowerCase() : null,
      // Kept as a string. Real collector numbers include 19b, S4, CHK-19 and
      // pp319sb; parseInt would turn the last of those into 319.
      collectorNumber: m[4] ? m[4].trim() : null,
      finish: finishFrom(m[5] ?? ""),
      board: lineBoard,
      lineNumber,
      raw: raw[i],
    });
  }

  return { lines, errors, totalCards: lines.reduce((s, l) => s + l.quantity, 0) };
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

import type { Queryable } from "@/lib/deck";

export interface ResolvedDeckLine {
  line: DeckListLine;
  scryfallId: string;
  /** How the printing was chosen, for the import summary. */
  via: "set_collector" | "name_in_set" | "owned_printing" | "newest_printing";
  name: string;
  owned: number;
}

export interface DeckListResolution {
  resolved: ResolvedDeckLine[];
  /** Lines that named no card the local mirror knows. Never dropped. */
  unresolved: DeckListLine[];
}

/**
 * Resolve parsed lines to printings, against the LOCAL MIRROR only.
 *
 * Three batched queries rather than one per line: a decklist is 100 lines, and
 * a query each would be 100 round trips for something the user is watching.
 *
 * For a bare name — the common case in a pasted list — preference order is a
 * printing the user OWNS, then the most recently released one. Owned first
 * because this is a collection app: if you have Sol Ring in your binder, the
 * deck should point at that copy so the "owned N/M" column means something.
 */
export async function resolveDeckList(
  db: Queryable,
  lines: readonly DeckListLine[],
  userId: number,
): Promise<DeckListResolution> {
  const resolved: ResolvedDeckLine[] = [];
  const unresolved: DeckListLine[] = [];
  if (lines.length === 0) return { resolved, unresolved };

  const ownedExpr = `COALESCE((SELECT SUM(cc.quantity) FROM collection_cards cc
                                JOIN collections col ON col.id = cc.collection_id
                               WHERE cc.scryfall_id = s.id AND col.user_id = $1), 0)::int`;

  // (a) exact printing, for lines that carried a set and collector number.
  const exact = lines.filter((l) => l.setCode && l.collectorNumber);
  // A concatenated key, not a row comparison. `(a, b) = ANY($1::text[][])` looks
  // natural and is a 42883 "operator does not exist: record = text" — Postgres
  // will not compare a record against array elements that way. Same idiom as
  // setCollectorKey in lib/import/resolve.ts.
  const exactRows = exact.length
    ? await db.query(
        `SELECT s.id::text AS id, s.name, LOWER(s.set_code) AS set_code,
                LOWER(s.collector_number) AS collector_number, ${ownedExpr} AS owned
           FROM scryfall_cards s
          WHERE LOWER(s.set_code) || ' ' || LOWER(s.collector_number) = ANY($2::text[])`,
        [userId, exact.map((l) => `${l.setCode} ${l.collectorNumber!.toLowerCase()}`)],
      )
    : { rows: [] };

  const byPrinting = new Map<string, { id: string; name: string; owned: number }>();
  for (const r of exactRows.rows as Array<Record<string, string | number>>) {
    byPrinting.set(`${r.set_code}|${r.collector_number}`, {
      id: String(r.id), name: String(r.name), owned: Number(r.owned),
    });
  }

  // (b) every printing of every named card, ranked. One query for the whole
  // list; the pick happens in JS so the ranking rule stays readable.
  const names = [...new Set(lines.map((l) => l.name.toLowerCase()))];
  const nameRows = await db.query(
    `SELECT s.id::text AS id, s.name, LOWER(s.name) AS lname, LOWER(s.set_code) AS set_code,
            s.released_at, ${ownedExpr} AS owned
       FROM scryfall_cards s
      WHERE LOWER(s.name) = ANY($2::text[])
      ORDER BY s.released_at DESC NULLS LAST, s.set_code ASC`,
    [userId, names],
  );

  const byName = new Map<string, Array<{ id: string; name: string; set_code: string; owned: number }>>();
  for (const r of nameRows.rows as Array<Record<string, unknown>>) {
    const key = String(r.lname);
    const list = byName.get(key) ?? [];
    list.push({
      id: String(r.id), name: String(r.name),
      set_code: String(r.set_code), owned: Number(r.owned),
    });
    byName.set(key, list);
  }

  for (const line of lines) {
    if (line.setCode && line.collectorNumber) {
      const hit = byPrinting.get(`${line.setCode}|${line.collectorNumber.toLowerCase()}`);
      if (hit) {
        resolved.push({ line, scryfallId: hit.id, via: "set_collector", name: hit.name, owned: hit.owned });
        continue;
      }
      // Fall through: a wrong collector number should not lose the card.
    }

    const candidates = byName.get(line.name.toLowerCase());
    if (!candidates || candidates.length === 0) {
      unresolved.push(line);
      continue;
    }

    if (line.setCode) {
      const inSet = candidates.find((c) => c.set_code === line.setCode);
      if (inSet) {
        resolved.push({ line, scryfallId: inSet.id, via: "name_in_set", name: inSet.name, owned: inSet.owned });
        continue;
      }
    }

    const owned = candidates.find((c) => c.owned > 0);
    const pick = owned ?? candidates[0];
    resolved.push({
      line, scryfallId: pick.id,
      via: owned ? "owned_printing" : "newest_printing",
      name: pick.name, owned: pick.owned,
    });
  }

  return { resolved, unresolved };
}

export interface ApplyResult {
  /** Distinct (printing, board, finish) rows written. */
  rows: number;
  /** Sum of quantities added. */
  cards: number;
}

/**
 * Write resolved lines into a deck.
 *
 * ONE multi-row INSERT rather than a call per line. `addDeckCard` bumps
 * `decks.updated_at` on every call, so importing a 100-card list through it
 * would issue 200 statements and 100 redundant UPDATEs for a single user action.
 *
 * Lines are folded first: a list can legitimately name the same printing twice
 * (an "Artifacts" section and a "Ramp" section both listing Sol Ring). Without
 * folding, one statement touching that row twice is
 * "ON CONFLICT DO UPDATE command cannot affect row a second time".
 *
 * Additive, matching addDeckCard: pasting a list into a deck that already holds
 * some of it increases quantities rather than replacing them.
 */
export async function applyDeckList(
  db: Queryable,
  deckId: number,
  resolved: readonly ResolvedDeckLine[],
  maxQuantity = 999,
): Promise<ApplyResult> {
  if (resolved.length === 0) return { rows: 0, cards: 0 };

  const folded = new Map<string, { id: string; board: DeckBoard; finish: string; qty: number }>();
  for (const r of resolved) {
    const key = `${r.scryfallId}|${r.line.board}|${r.line.finish}`;
    const cur = folded.get(key);
    if (cur) cur.qty = Math.min(cur.qty + r.line.quantity, maxQuantity);
    else folded.set(key, { id: r.scryfallId, board: r.line.board, finish: r.line.finish, qty: r.line.quantity });
  }

  const rows = [...folded.values()];
  const params: unknown[] = [deckId];
  const tuples = rows.map((r) => {
    const a = params.push(r.id);
    const b = params.push(r.qty);
    const c = params.push(r.board);
    const d = params.push(r.finish);
    return `($1, $${a}::uuid, $${b}::int, $${c}, $${d})`;
  });

  await db.query(
    `INSERT INTO deck_cards (deck_id, scryfall_id, quantity, board, finish)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (deck_id, scryfall_id, board, finish)
     DO UPDATE SET quantity = LEAST(deck_cards.quantity + EXCLUDED.quantity, ${maxQuantity})`,
    params,
  );
  await db.query("UPDATE decks SET updated_at = now() WHERE id = $1", [deckId]);

  return { rows: rows.length, cards: rows.reduce((s, r) => s + r.qty, 0) };
}
