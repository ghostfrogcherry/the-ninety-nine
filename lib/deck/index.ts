/**
 * Deck building — the reads and writes behind the deck editor.
 *
 * Everything the UI (`app/decks/**`) and the JSON API (`app/api/decks/**`) do
 * to a deck goes through this file, so there is exactly one definition of what
 * "add a card" means. `lib/commander/` stays pure and judges the result; this
 * module is the only place that mutates `deck_cards`.
 *
 * Four constraints from 0004_decks.sql drive the whole design:
 *
 *  - `deck_cards` is UNIQUE on (deck_id, scryfall_id, board, finish). Adding a
 *    card that is already on that board in that finish must therefore be an
 *    UPSERT, not an INSERT — otherwise the second copy of a basic Forest is a
 *    23505 in the user's face. Every write here uses ON CONFLICT.
 *
 *  - `quantity` is CHECK (> 0). "Remove" is a DELETE, never `SET quantity = 0`,
 *    and a quantity edit down to 0 is routed to the same DELETE rather than
 *    being allowed to hit the check constraint.
 *
 *  - `scryfall_id` is deliberately NOT a foreign key into `scryfall_cards`,
 *    because that table is truncated and rebuilt by the weekly refresh. So
 *    nothing here joins to the mirror in order to *validate* a write: the card
 *    picker searches the mirror, but a row whose printing later vanishes from
 *    the mirror stays in the deck and is surfaced as "not found in the mirror"
 *    by the page, not deleted.
 *
 *  - Commander legality is enforced in the app, never by refusing a write. Every
 *    function here will happily store a banned card, a 4th copy of Sol Ring or
 *    a 137-card deck. `validateCommanderDeck` then explains why it is illegal.
 *    A builder that will not let you save a work in progress is useless.
 *
 * Ownership is checked by `deck_id = $ AND user_id = $` on the deck itself, and
 * every card mutation is additionally scoped by `deck_id`, so a row id belonging
 * to someone else's deck matches nothing. A deck the caller does not own reads
 * as absent, never as forbidden — same rule as
 * `app/api/collections/access.ts`, for the same reason: a 403 would confirm
 * which deck ids exist.
 *
 * Typed against a structural `Queryable` rather than importing `pg`, so this is
 * importable from a server component, from a route handler and from a test
 * holding a bare client. `pg`'s Pool and PoolClient both satisfy it as-is —
 * the same trick `lib/import/resolve.ts` uses.
 */

import type { CommanderCard, DeckBoard, DeckEntry } from "../commander";

/* ------------------------------------------------------------------ *
 * Minimal pg-shaped interface (see lib/import/resolve.ts)
 * ------------------------------------------------------------------ */

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/** `deck_cards.board`, verbatim from 0004_decks.sql. */
export const DECK_BOARDS = ["main", "commander", "sideboard", "maybe"] as const;

/** Human labels for the board selects. */
export const BOARD_LABELS: Record<DeckBoard, string> = {
  main: "Deck",
  commander: "Commander",
  sideboard: "Sideboard",
  maybe: "Maybe",
};

/**
 * Finishes offered by the editor. Matches Scryfall's `finishes` values and
 * `lib/collection/filters.ts`. `deck_cards.finish` is a bare TEXT column with no
 * CHECK, so this list is the only thing keeping it tidy — validate, do not trust.
 */
export const DECK_FINISHES = ["nonfoil", "foil", "etched"] as const;
export type DeckFinish = (typeof DECK_FINISHES)[number];

/**
 * Formats offered when creating a deck. `decks.format` is free TEXT defaulting
 * to 'commander'; only Commander is actually validated by `lib/commander/`, and
 * the UI says so rather than implying the others are checked.
 */
export const DECK_FORMATS = [
  "commander",
  "brawl",
  "oathbreaker",
  "standard",
  "pioneer",
  "modern",
  "legacy",
  "vintage",
  "pauper",
  // What a drafted pool is saved as (lib/draft's savePicksAsDeck). Listed here
  // rather than special-cased so that renaming a drafted deck does not see a
  // format this list lacks and offer to retype it; the deck page gives it a
  // 40-card check in place of the Commander one.
  "limited",
] as const;

/** Which card pool the picker searches. Owned first: this is a collection app. */
export const SEARCH_SCOPES = ["owned", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/**
 * Upper bound on a single `deck_cards.quantity`.
 *
 * Not a rules number — Commander's real limit is the singleton rule, which is
 * checked in `lib/commander/` and must stay checkable rather than being
 * pre-empted here. This only stops a fat-fingered `99999` from turning the deck
 * view into a wall of nonsense.
 */
export const MAX_QUANTITY = 999;

/* ------------------------------------------------------------------ *
 * Input parsing
 *
 * Every one of these takes `unknown`, because the callers are a FormData value
 * (string | File | null) and a JSON body. They return null on anything
 * unexpected rather than coercing, so a hand-edited form cannot smuggle a value
 * into SQL or into an enum-shaped column.
 * ------------------------------------------------------------------ */

function str(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

export function parseBoard(value: unknown): DeckBoard | null {
  const s = str(value);
  return (DECK_BOARDS as readonly string[]).includes(s ?? "") ? (s as DeckBoard) : null;
}

export function parseFinish(value: unknown): DeckFinish | null {
  const s = str(value);
  return (DECK_FINISHES as readonly string[]).includes(s ?? "") ? (s as DeckFinish) : null;
}

export function parseFormat(value: unknown): string | null {
  const s = str(value)?.toLowerCase() ?? null;
  return (DECK_FORMATS as readonly string[]).includes(s ?? "") ? s : null;
}

export function parseScope(value: unknown): SearchScope {
  return str(value) === "all" ? "all" : "owned";
}

export function parseDeckName(value: unknown): string | null {
  const s = str(value);
  if (s === null || s === "") return null;
  // 120 matches the collections create schema.
  return s.length > 120 ? s.slice(0, 120) : s;
}

/**
 * Fold a deck name to the form the delete confirmation compares on. Not
 * exported: the folded form is never stored and never displayed, it exists only
 * for the equality test below.
 */
function foldDeckName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Does the text typed into the delete box name the deck that is about to be
 * deleted?
 *
 * Deleting a deck is unrecoverable — no soft delete, no undo, and the FK
 * cascade takes all ninety-nine cards with it — so the confirmation is tied to
 * the deck's identity rather than to a generic "yes" token. The failure a token
 * does not catch: a tab left open on /decks/7?confirm=1 yesterday, clicked
 * today when you meant deck 9. A name has to match, so the stale tab deletes
 * nothing.
 *
 * Case and runs of whitespace are folded, because rejecting someone who typed
 * "arahbo cats" for "Arahbo  Cats" protects nobody and only trains them to
 * paste without reading. An empty box never matches, not even a deck whose
 * stored name is blank — `parseDeckName` cannot create one, but a direct INSERT
 * can, and that must not be the one deck that deletes itself on an empty form.
 */
export function confirmsDeckName(typed: unknown, deckName: unknown): boolean {
  const t = str(typed);
  const n = str(deckName);
  if (t === null || n === null) return false;
  const folded = foldDeckName(n);
  if (folded === "") return false;
  return foldDeckName(t) === folded;
}

/**
 * Quantity for an *edit*. 0 is deliberately legal here and means "delete the
 * row" — `quantity` is CHECK (> 0), so the alternative is a constraint error on
 * a perfectly reasonable user action.
 */
export function parseQuantity(value: unknown): number | null {
  const s = typeof value === "number" ? String(value) : str(value);
  if (s === null || s === "" || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_QUANTITY ? n : null;
}

/** Quantity for an *add*: same, but 0 copies of a card is not a thing to add. */
export function parseAddQuantity(value: unknown): number | null {
  const n = parseQuantity(value);
  return n === null || n === 0 ? null : n;
}

/**
 * Largest value a Postgres `integer` (int4) can hold.
 *
 * SERIAL is int4, and `pg` infers a bind parameter's type from the column it is
 * compared against — so a larger number does NOT quietly match zero rows, it
 * raises 22003 "value out of range for type integer" and surfaces as a 500.
 * `/decks/2147483648` returned 500 where `/decks/999999999` correctly returned
 * 404. Bounding here is the whole reason this parse layer exists.
 */
export const MAX_INT4 = 2147483647;

/** `decks.id` / `deck_cards.id` are SERIAL. Reject anything that is not one. */
export function parseId(value: unknown): number | null {
  const s = typeof value === "number" ? String(value) : str(value);
  if (s === null || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `deck_cards.scryfall_id` is UUID. Postgres would reject a malformed one with
 * 22P02 anyway, but that surfaces as a 500; checking here gives a 400.
 */
export function parseScryfallId(value: unknown): string | null {
  const s = str(value);
  return s !== null && RE_UUID.test(s) ? s.toLowerCase() : null;
}

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

export interface DeckRow extends Record<string, unknown> {
  id: number;
  user_id: number;
  name: string;
  format: string;
  is_public: boolean;
  public_slug: string | null;
}

export interface DeckCardRow extends Record<string, unknown> {
  id: number;
  deck_id: number;
  scryfall_id: string;
  quantity: number;
  board: DeckBoard;
  finish: string;
}

/**
 * A `deck_cards` row joined to its mirror card, which is what both the deck page
 * and the API return. The index signature satisfies
 * `query<T extends Record<string, unknown>>`; `CommanderCard` is a closed
 * interface by design, so it is widened here rather than in the library.
 */
export interface DeckCardDetail extends CommanderCard {
  row_id: number;
  quantity: number;
  board: DeckBoard;
  finish: string;
  /** Copies of this exact printing across the caller's own collections. */
  owned: number;
  /** Mana value, for the curve. Null for lands and unmirrored rows. */
  cmc: number | null;
  /** Falls back to the front face: multi-face cards have no top-level art. */
  image: string | null;
  unit_price: string | null;
  [key: string]: unknown;
}

export interface DeckContents {
  cards: DeckCardDetail[];
  /**
   * `deck_cards` rows whose `scryfall_id` is not in the mirror. Counted, not
   * dropped: there is no FK (0004_decks.sql), so a stale or mid-refresh mirror
   * must read as "N cards unresolved", never as a deck that silently shrank.
   */
  unresolved: number;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * The deck, if this user owns it. `null` covers both "no such deck" and
 * "someone else's deck" on purpose — callers turn both into 404.
 */
export async function loadOwnedDeck(
  db: Queryable,
  deckId: number,
  userId: number,
): Promise<DeckRow | null> {
  const { rows } = await db.query(
    `SELECT id, user_id, name, format, is_public, public_slug
       FROM decks
      WHERE id = $1 AND user_id = $2`,
    [deckId, userId],
  );
  return (rows[0] as DeckRow) ?? null;
}

/**
 * Deck contents joined to the mirror, plus a count of the rows that did not
 * join.
 *
 * LEFT JOIN so the unresolved rows can be counted in the same pass, then split
 * in JS. The deck page's old INNER JOIN + separate COUNT(*) did the same thing
 * in two round trips.
 *
 * `owned` is a correlated subquery rather than another join: joining
 * `collection_cards` here would multiply deck rows by the number of collections
 * holding that printing and inflate every quantity.
 */
export async function loadDeckContents(
  db: Queryable,
  deckId: number,
  userId: number,
): Promise<DeckContents> {
  const { rows } = await db.query(
    `SELECT dc.id AS row_id, dc.quantity, dc.board, dc.finish,
            s.id::text AS id, s.oracle_id::text AS oracle_id, s.name,
            s.set_code, s.collector_number, s.layout,
            s.type_line, s.oracle_text, s.color_identity, s.legalities, s.card_faces,
            s.cmc,
            -- Multi-face cards carry no top-level image_uris; the art is on the
            -- front face. Without this fallback every transform/modal card in a
            -- deck renders as a broken image.
            COALESCE(s.image_uris->>'normal', s.card_faces->0->'image_uris'->>'normal') AS image,
            (CASE dc.finish
               WHEN 'foil'   THEN s.prices->>'usd_foil'
               WHEN 'etched' THEN s.prices->>'usd_etched'
               ELSE s.prices->>'usd' END) AS unit_price,
            COALESCE((SELECT SUM(cc.quantity)
                        FROM collection_cards cc
                        JOIN collections c ON c.id = cc.collection_id
                       WHERE cc.scryfall_id = dc.scryfall_id
                         AND cc.finish = dc.finish
                         AND c.user_id = $2), 0)::int AS owned
       FROM deck_cards dc
       LEFT JOIN scryfall_cards s ON s.id = dc.scryfall_id
      WHERE dc.deck_id = $1
      ORDER BY s.name NULLS LAST, s.set_code, dc.finish`,
    [deckId, userId],
  );

  const cards: DeckCardDetail[] = [];
  let unresolved = 0;
  for (const row of rows) {
    if (row.id === null) unresolved += 1;
    else cards.push(row as DeckCardDetail);
  }
  return { cards, unresolved };
}

/** Deck rows -> the shape `validateCommanderDeck` consumes. */
export function toDeckEntries(cards: readonly DeckCardDetail[]): DeckEntry[] {
  return cards.map((c) => ({ card: c, quantity: c.quantity, board: c.board }));
}

export interface MirrorSearchRow extends Record<string, unknown> {
  id: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  type_line: string | null;
  color_identity: string[];
  legalities: Record<string, string> | null;
  finishes: string[];
  /** Copies across the caller's own collections, all finishes. */
  owned: number;
}

/**
 * Card picker search — against the LOCAL MIRROR ONLY.
 *
 * Nothing in this app calls api.scryfall.com per card. `scryfall_cards` is a
 * weekly bulk copy precisely so that searching costs Scryfall nothing (see
 * 0002_scryfall.sql and the bulk-data terms), and a per-keystroke API search
 * would violate the arrangement the whole mirror exists to honour.
 *
 * `scope: "owned"` restricts to printings in one of the caller's collections,
 * which is the default because this is a collection app and the common case is
 * "build a deck out of what I have". `scope: "all"` opens it to the full mirror
 * for cards not owned yet.
 *
 * Ranking puts an exact name first, then a prefix match, so searching "sol ring"
 * does not bury it under "Solemn Simulacrum". Substring rather than prefix
 * matching means the search is a seq scan over the mirror — 117k rows, ~40ms on
 * the real box, run once per submitted form rather than per keystroke, so the
 * LIMIT is the thing keeping it cheap. `scryfall_cards_name_lower_idx` cannot
 * help a leading `%` under a non-C collation.
 */
export async function searchMirror(
  db: Queryable,
  opts: { userId: number; q: string; scope: SearchScope; limit?: number },
): Promise<MirrorSearchRow[]> {
  const q = opts.q.trim();
  if (q === "") return [];
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  const ownedExpr = `COALESCE((SELECT SUM(cc.quantity)
                                 FROM collection_cards cc
                                 JOIN collections c ON c.id = cc.collection_id
                                WHERE cc.scryfall_id = s.id AND c.user_id = $1), 0)::int`;

  // The owned scope filters with EXISTS rather than a join so a printing held in
  // two collections still comes back as one row.
  const scopeClause =
    opts.scope === "owned"
      ? `AND EXISTS (SELECT 1 FROM collection_cards cc
                       JOIN collections c ON c.id = cc.collection_id
                      WHERE cc.scryfall_id = s.id AND c.user_id = $1)`
      : "";

  const { rows } = await db.query(
    `SELECT s.id::text AS id, s.name, s.set_code, s.set_name, s.collector_number,
            s.type_line, s.color_identity, s.legalities, s.finishes,
            ${ownedExpr} AS owned
       FROM scryfall_cards s
      WHERE s.name ILIKE '%' || $2 || '%'
        ${scopeClause}
      ORDER BY (LOWER(s.name) = LOWER($2)) DESC,
               (s.name ILIKE $2 || '%') DESC,
               s.name ASC, s.set_code ASC, s.collector_number ASC
      LIMIT $3`,
    [opts.userId, q, limit],
  );
  return rows as MirrorSearchRow[];
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Bump `decks.updated_at`. `/decks` orders by it, so a deck you just edited
 * should float to the top; nothing else keeps that column current.
 *
 * Separate statement rather than folded into each mutation's CTE: it is
 * cosmetic, and a failure to reorder a list is not worth making every write
 * conditional on.
 */
export async function touchDeck(db: Queryable, deckId: number): Promise<void> {
  await db.query("UPDATE decks SET updated_at = now() WHERE id = $1", [deckId]);
}

export async function createDeck(
  db: Queryable,
  userId: number,
  input: { name: string; format: string; description?: string | null },
): Promise<DeckRow> {
  const { rows } = await db.query(
    `INSERT INTO decks (user_id, name, format, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, name, format, is_public, public_slug`,
    [userId, input.name, input.format, input.description ?? null],
  );
  return rows[0] as DeckRow;
}

/**
 * Rename a deck, and optionally re-format it.
 *
 * `updated_at = now()` rides inside this UPDATE rather than going through
 * `touchDeck`. `touchDeck` is a separate statement because a card mutation
 * writes `deck_cards` and touching the deck is a second table; a rename is
 * already writing the deck row, so folding it in is free — and it means /decks
 * cannot re-sort for a rename that did not actually land.
 *
 * `format` is optional, and `COALESCE($4, format)` leaves the column alone when
 * it is null. That is load-bearing rather than tidy: `parseFormat` returns null
 * for anything outside DECK_FORMATS and `decks.format` is free TEXT, so a deck
 * inserted directly as 'canadian highlander' has to survive a rename instead of
 * being silently retyped as whatever the select fell back to.
 *
 * Scoped by `user_id` as well as `id` — like enableSharing/disableSharing, and
 * unlike the card mutations, which are already behind a deck the caller was
 * shown to own. This writes the deck row itself, so it re-states the check.
 * Null means "not yours" or "not there", indistinguishable on purpose.
 */
export async function renameDeck(
  db: Queryable,
  deckId: number,
  userId: number,
  input: { name: string; format?: string | null },
): Promise<DeckRow | null> {
  const { rows } = await db.query(
    `UPDATE decks
        SET name       = $3,
            format     = COALESCE($4, format),
            updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, name, format, is_public, public_slug`,
    [deckId, userId, input.name, input.format ?? null],
  );
  return (rows[0] as DeckRow) ?? null;
}

/**
 * Delete a deck and everything in it.
 *
 * ONE statement, no transaction: `deck_cards.deck_id` is
 * `REFERENCES decks (id) ON DELETE CASCADE` in 0004_decks.sql, so the card rows
 * go with the deck inside this DELETE. Deleting `deck_cards` by hand first is
 * the version that would need a transaction, and all it would add is a window
 * in which a deck exists with its cards already gone. The cascade is asserted
 * against a real Postgres in test/deck.test.ts rather than trusted, so dropping
 * that FK fails a test instead of quietly orphaning rows.
 *
 * Returns the row it deleted, so the caller can revalidate `/d/<slug>` with the
 * slug this DELETE actually removed. Reading the slug beforehand leaves a window
 * in which a concurrent rotate publishes the deck at a slug nobody invalidates.
 *
 * The public link dies with the row and needs no separate un-share step:
 * `/d/[slug]` resolves through `WHERE public_slug = $1 AND is_public = TRUE`,
 * and there is no longer a row to match.
 */
export async function deleteDeck(
  db: Queryable,
  deckId: number,
  userId: number,
): Promise<DeckRow | null> {
  const { rows } = await db.query(
    `DELETE FROM decks
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, name, format, is_public, public_slug`,
    [deckId, userId],
  );
  return (rows[0] as DeckRow) ?? null;
}

export interface AddCardInput {
  scryfallId: string;
  quantity: number;
  board: DeckBoard;
  finish: string;
}

/**
 * Add copies of a printing to a board.
 *
 * THE upsert. (deck_id, scryfall_id, board, finish) is unique, so adding a card
 * already on that board is `quantity = quantity + n`, not a duplicate-key error.
 * Additive rather than absolute because this is the "+ Add" button: clicking it
 * twice on Forest means two Forests. `setDeckCardQuantity` is the absolute one.
 *
 * The conflict target names the four columns of `deck_cards_unique_idx`; naming
 * the columns rather than the index keeps this working if the index is ever
 * renamed.
 *
 * Note what is NOT here: no check that the card exists in the mirror, and no
 * legality check. The first would couple user data to a rebuildable cache; the
 * second would stop you saving a deck you are halfway through fixing.
 */
export async function addDeckCard(
  db: Queryable,
  deckId: number,
  input: AddCardInput,
): Promise<DeckCardRow> {
  const { rows } = await db.query(
    `INSERT INTO deck_cards (deck_id, scryfall_id, quantity, board, finish)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (deck_id, scryfall_id, board, finish)
     DO UPDATE SET quantity = LEAST(deck_cards.quantity + EXCLUDED.quantity, ${MAX_QUANTITY})
     RETURNING id, deck_id, scryfall_id::text AS scryfall_id, quantity, board, finish`,
    [deckId, input.scryfallId, input.quantity, input.board, input.finish],
  );
  await touchDeck(db, deckId);
  return rows[0] as DeckCardRow;
}

/**
 * Set an existing row's quantity absolutely.
 *
 * `quantity = 0` DELETEs. The column is CHECK (> 0), so the only alternatives
 * are a 500 from the constraint or silently refusing an edit the user clearly
 * meant. Returns the surviving row, or null when it was deleted or never
 * belonged to this deck.
 */
export async function setDeckCardQuantity(
  db: Queryable,
  deckId: number,
  rowId: number,
  quantity: number,
): Promise<DeckCardRow | null> {
  if (quantity <= 0) {
    await removeDeckCard(db, deckId, rowId);
    return null;
  }
  const { rows } = await db.query(
    `UPDATE deck_cards SET quantity = $3
      WHERE id = $1 AND deck_id = $2
     RETURNING id, deck_id, scryfall_id::text AS scryfall_id, quantity, board, finish`,
    [rowId, deckId, quantity],
  );
  if (rows.length) await touchDeck(db, deckId);
  return (rows[0] as DeckCardRow) ?? null;
}

/**
 * Remove a row outright. DELETE, never `quantity = 0`.
 *
 * Scoped by `deck_id` as well as `id`, so a row id from someone else's deck
 * deletes nothing and reports false — the caller turns that into a 404 without
 * ever having to say whose row it was.
 */
export async function removeDeckCard(
  db: Queryable,
  deckId: number,
  rowId: number,
): Promise<boolean> {
  const { rows } = await db.query(
    "DELETE FROM deck_cards WHERE id = $1 AND deck_id = $2 RETURNING id",
    [rowId, deckId],
  );
  if (rows.length) await touchDeck(db, deckId);
  return rows.length > 0;
}

/**
 * Move a row to another board, merging if the destination already holds that
 * printing in that finish.
 *
 * One statement, not a transaction: a DELETE ... RETURNING feeding an INSERT
 * ... ON CONFLICT is atomic by itself, so there is no window in which the card
 * exists on neither board (or on both). Moving Sol Ring from 'maybe' to 'main'
 * when 'main' already has one yields a single row with the summed quantity
 * instead of a 23505 from the unique index.
 *
 * `board <> $3` matters more than it looks, though not for the reason it first
 * appears. Moving a row to the board it is already on does NOT raise "cannot
 * affect row a second time" on Postgres 17 — measured, not assumed. What
 * actually happens is quieter and worse: the CTE deletes the row and the INSERT
 * lands a brand-new one, so `deck_cards.id` silently changes and `added_at`
 * resets. That id is the handle the editor posts back, so a no-op move would
 * invalidate the very form the user just submitted from. With the clause, a
 * no-op move is a genuine no-op and the row id is stable.
 *
 * Returns null for a no-op or a row that is not in this deck; the caller cannot
 * distinguish them, and neither should the HTTP status.
 */
export async function moveDeckCard(
  db: Queryable,
  deckId: number,
  rowId: number,
  board: DeckBoard,
): Promise<DeckCardRow | null> {
  const { rows } = await db.query(
    `WITH moved AS (
       DELETE FROM deck_cards
        WHERE id = $1 AND deck_id = $2 AND board <> $3
       RETURNING scryfall_id, quantity, finish
     )
     INSERT INTO deck_cards (deck_id, scryfall_id, quantity, board, finish)
     SELECT $2, scryfall_id, quantity, $3, finish FROM moved
     ON CONFLICT (deck_id, scryfall_id, board, finish)
     DO UPDATE SET quantity = LEAST(deck_cards.quantity + EXCLUDED.quantity, ${MAX_QUANTITY})
     RETURNING id, deck_id, scryfall_id::text AS scryfall_id, quantity, board, finish`,
    [rowId, deckId, board],
  );
  if (rows.length) await touchDeck(db, deckId);
  return (rows[0] as DeckCardRow) ?? null;
}
