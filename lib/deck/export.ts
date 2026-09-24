/**
 * Deck export as plain text — the Arena/MTGO list format that untap.in's
 * "Decks → Import" box (and most other deck tools) reads:
 *
 *     Commander
 *     1 Arahbo, Roar of the World
 *
 *     Deck
 *     4 Lightning Bolt
 *     1 Fire // Ice
 *
 *     Sideboard
 *     2 Negate
 *
 * Pure, and dependency-free at runtime (the one import is type-only), so
 * test/deck-export.test.ts loads it under Node's type stripping with no Next
 * and no database. The page and the download route both call it, so the text in
 * the box and the file you download cannot disagree.
 */

import type { DeckBoard } from "../commander";

export interface ExportCard {
  /** The mirror's card name. For split, adventure and double-faced cards this
   *  is already Scryfall's full "Front // Back" name, which is what importers
   *  match on — a front-face-only name misses split cards entirely. */
  name: string;
  quantity: number;
  board: DeckBoard;
}

/** Names are one line each; a stray newline in a name would split a card in two. */
function clean(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Sum copies by name within one section, alphabetically.
 *
 * By name, not by printing: a deck can hold the same card as two rows — two
 * printings, or a foil and a non-foil copy — and `2 Sol Ring` twice is a list
 * some importers reject and others count as a duplicate entry.
 */
function section(cards: readonly ExportCard[], boards: readonly DeckBoard[]): string[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (!boards.includes(c.board)) continue;
    const name = clean(c.name);
    if (name === "" || !(c.quantity > 0)) continue;
    counts.set(name, (counts.get(name) ?? 0) + Math.floor(c.quantity));
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([name, n]) => `${n} ${name}`);
}

/**
 * The deck as text. The maybe-board is left out: it is a list of cards you
 * are NOT playing, and every importer would put them in the deck.
 *
 * The `Deck` header is always written, even for an empty main board, because
 * it is what tells an importer this is a list at all.
 */
export function formatDeckText(cards: readonly ExportCard[]): string {
  const commander = section(cards, ["commander"]);
  const main = section(cards, ["main"]);
  const side = section(cards, ["sideboard"]);

  const blocks: string[][] = [];
  if (commander.length) blocks.push(["Commander", ...commander]);
  blocks.push(["Deck", ...main]);
  if (side.length) blocks.push(["Sideboard", ...side]);
  return `${blocks.map((b) => b.join("\n")).join("\n\n")}\n`;
}

/**
 * `Content-Disposition` for downloading a deck as `<name>.txt`.
 *
 * Two filenames, per RFC 6266: a plain-ASCII `filename=` for anything old, and
 * an RFC 5987 `filename*=` carrying the real name in UTF-8. The deck name is
 * user text, so the ASCII one is whitelisted down to characters that cannot
 * end the quoted string or inject a header (`"`, `\`, CR/LF), and it never
 * starts with a dot, so "..txt" cannot become a hidden file.
 */
export function deckFileDisposition(deckName: string): string {
  const base = clean(deckName).slice(0, 100) || "deck";
  const ascii = base.replace(/[^A-Za-z0-9 ._()-]+/g, "_").replace(/^[.\s_]+/, "").trim() || "deck";
  // encodeURIComponent leaves ' ( ) * ! alone; RFC 5987's attr-char does not
  // allow the first four, so they are escaped by hand.
  const utf8 = encodeURIComponent(`${base}.txt`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}.txt"; filename*=UTF-8''${utf8}`;
}
