/**
 * Booster draft engine. See lib/draft/types.ts for the shapes the pages use,
 * and db/migrations/0008_drafts.sql for the tables.
 *
 *  - ./packs.ts — which printings are eligible, opening packs, the bot's pick
 *  - ./table.ts — the position rule and the in-memory pod the bots run on
 *  - this file  — the SQL, the transactions, and the rules about who may act
 *
 * Every write takes the pod's `drafts` row FOR UPDATE before reading anything
 * else, and every function that writes to draft_cards is one of those writes.
 * That single lock is the whole concurrency story: two friends picking at the
 * same instant, a double-clicked pick button and a back-button resubmit all
 * queue on the row, and the second one then reads the state the first one
 * committed. A resubmitted pick finds the seat already a pick further on, and
 * is refused (`not_your_turn` / `not_in_pack`) rather than taking a second
 * card. draft_cards_one_pick_idx backs that up in the schema.
 *
 * Speed matters because the pages poll `loadSeatState` every couple of
 * seconds per person while they wait. So a pick loads the pod's cards once
 * (at most 8 seats × 6 packs × 20 cards = 960 rows), lets every bot catch up
 * in memory, and writes every pick it made in ONE UPDATE; `loadSeatState` is
 * three queries on the 0008 indexes whatever the pod's size.
 *
 * Not-yours and not-real read the same (`not_found` / null), as everywhere
 * in this app, so pod ids cannot be enumerated.
 *
 * Runtime imports are relative with a `.ts` extension and reach only
 * lib/deck and this directory; see lib/prices/index.ts for why the tests
 * need that. Type-only imports are erased and may use the `@/` alias.
 */

import { randomBytes } from "node:crypto";

import type { ClientLike, PoolLike } from "@/lib/import/resolve";

import { MAX_INT4, createDeck, parseDeckName, type Queryable } from "../deck/index.ts";
import { BASIC_LAND_LIKE, EXCLUDED_LAYOUTS, eligibleCards, openPack, type MirrorPrinting, type Rng } from "./packs.ts";
import {
  buildTable,
  isComplete,
  packInFront,
  packOrigin,
  runBots,
  seatPosition,
  seatToPickFrom,
  takeCard,
  type PodShape,
  type Table,
  type TableCard,
} from "./table.ts";
import type {
  CreateDraftInput,
  DraftCardView,
  DraftError,
  DraftSeatState,
  DraftSeatView,
  DraftSetOption,
  DraftStatus,
  DraftSummary,
} from "./types";

export type * from "./types";
export type { Rng } from "./packs.ts";

/* ------------------------------------------------------------------ *
 * Limits and input parsing
 *
 * The pages parse FormData with these before calling in; the engine parses
 * again, because a function that writes must not trust that its caller did.
 * ------------------------------------------------------------------ */

export const SEAT_COUNT_MIN = 2;
export const SEAT_COUNT_MAX = 8;
export const PACK_SIZE_MIN = 5;
export const PACK_SIZE_MAX = 20;
export const PACK_COUNT_MIN = 1;
export const PACK_COUNT_MAX = 6;
export const DEFAULT_PACK_SIZE = 14;
export const DEFAULT_PACK_COUNT = 3;

/**
 * Fewest distinct eligible cards a set needs to be OFFERED for drafting.
 *
 * Not the engine's hard floor: that is pack_size, because a pack is sampled
 * without replacement from a one-printing-per-card pool, so pack_size
 * distinct cards is exactly what "no duplicate within a pack" needs, and
 * `startDraft` checks exactly that for the pod in hand. 45 is 3 × 14 + 3 —
 * enough that the three default packs one seat opens could all be different
 * cards, with a little slack. Below it the set is a promo, token or
 * precon-sized set, and every pack of a pod would be the same handful of
 * cards: technically draftable, not worth listing.
 */
export const MIN_DRAFTABLE_CARDS = 45;

/**
 * Scryfall `set_type`s never offered, whatever their card count. Tokens,
 * memorabilia (oversized and gold-bordered cards) and minigames are not
 * Magic cards you draft; alchemy and treasure_chest are digital-only and
 * rebalanced; vanguard is its own format. Promo sets are small and scattered
 * printings of unrelated cards. A NULL set_type — pre-0008 rows, the demo
 * fixture — is allowed: unknown is not a reason to refuse.
 *
 * Commander precon sets need no entry: Scryfall marks none of their rows
 * `booster`, so they count 0 eligible cards and fall below the threshold.
 */
export const EXCLUDED_SET_TYPES: readonly string[] = [
  "token",
  "memorabilia",
  "minigame",
  "alchemy",
  "treasure_chest",
  "vanguard",
  "promo",
];

/** Most sets `listDraftableSets` returns; the real mirror has ~900 sets in all. */
export const DRAFTABLE_SET_LIMIT = 200;

function intInRange(value: unknown, min: number, max: number): number | null {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  if (s === null || !/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

export const parseSeatCount = (v: unknown) => intInRange(v, SEAT_COUNT_MIN, SEAT_COUNT_MAX);
export const parsePackSize = (v: unknown) => intInRange(v, PACK_SIZE_MIN, PACK_SIZE_MAX);
export const parsePackCount = (v: unknown) => intInRange(v, PACK_COUNT_MIN, PACK_COUNT_MAX);

/** Same rules as a deck name: the saved deck is named after the pod. */
export const parseDraftName = parseDeckName;

/**
 * Scryfall set codes are 3–6 lowercase alphanumerics (`dsk`, `pmh3`,
 * `h2r`). Lowercased here because the mirror stores them lowercase and an
 * uppercase code from a hand-typed URL should still find its set.
 */
export function parseSetCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  return /^[a-z0-9]{2,8}$/.test(s) ? s : null;
}

/**
 * `drafts.id`, a user id, or a `draft_cards.id` — all SERIAL. Range checked
 * against MAX_INT4 because a larger number is not "no match" to Postgres but
 * a 22003 error, i.e. a 500 (see lib/deck's parseId).
 */
function validId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4 ? value : null;
}

/* ------------------------------------------------------------------ *
 * Join slugs
 * ------------------------------------------------------------------ */

/**
 * The same alphabet and length as a deck's share slug (app/d/_share.ts), for
 * the same reasons: five bits per character with no modulo bias, 100 bits in
 * all, nothing ambiguous read aloud. Repeated rather than imported because
 * lib/ does not reach into app/, and a join slug is not a share slug — they
 * may yet diverge.
 */
const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const JOIN_SLUG_LENGTH = 20;
const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${JOIN_SLUG_LENGTH}}$`);

/** randomBytes, never Math.random: one leaked invite must not predict the next. */
function generateJoinSlug(): string {
  const bytes = randomBytes(JOIN_SLUG_LENGTH);
  let out = "";
  for (let i = 0; i < JOIN_SLUG_LENGTH; i += 1) out += SLUG_ALPHABET[bytes[i]! & 31];
  return out;
}

/** Shape check before any query, so junk in a URL costs no connection. */
export function isPlausibleJoinSlug(raw: unknown): raw is string {
  return typeof raw === "string" && SLUG_PATTERN.test(raw);
}

/* ------------------------------------------------------------------ *
 * Transactions
 * ------------------------------------------------------------------ */

/** A failure a person caused. Thrown to unwind a transaction, returned as `{ error }`. */
class Refusal extends Error {
  // Assigned in the body: Node's type stripping cannot erase a
  // `constructor(readonly code)` parameter property, and the tests run there.
  readonly code: DraftError;
  constructor(code: DraftError) {
    super(code);
    this.code = code;
  }
}

/**
 * BEGIN … COMMIT on one pooled client. A `Refusal` rolls back and becomes
 * `{ error }` — startDraft may already have seated bots when it discovers the
 * set is too small, and those must not survive the refusal. Anything else
 * rolls back and rethrows. A client whose ROLLBACK also failed is handed back
 * as broken, so the pool discards it instead of lending out a connection
 * stuck mid-transaction.
 */
async function inTransaction<T>(pool: PoolLike, fn: (db: ClientLike) => Promise<T>): Promise<T | { error: DraftError }> {
  const client = await pool.connect();
  let broken: unknown;
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr;
    }
    if (err instanceof Refusal) return { error: err.code };
    throw err;
  } finally {
    client.release(broken);
  }
}

interface DraftRow {
  id: number;
  name: string;
  set_code: string;
  set_name: string;
  status: DraftStatus;
  seat_count: number;
  pack_size: number;
  pack_count: number;
  join_slug: string;
  created_by: number;
  created_at: string;
}

/**
 * `to_json(created_at) #>> '{}'` is ISO 8601 with an offset whatever the
 * session's DateStyle, and a string — the contract promises a string, and
 * pg would otherwise hand the page a Date.
 */
const SUMMARY_COLUMNS = `d.id, d.name, d.set_code, d.set_name, d.status, d.seat_count, d.pack_size,
  d.pack_count, d.join_slug, d.created_by, to_json(d.created_at) #>> '{}' AS created_at`;

function toSummary(row: DraftRow): DraftSummary {
  return {
    id: row.id,
    name: row.name,
    set_code: row.set_code,
    set_name: row.set_name,
    status: row.status,
    seat_count: row.seat_count,
    pack_size: row.pack_size,
    pack_count: row.pack_count,
    join_slug: row.join_slug,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

const shapeOf = (d: DraftRow): PodShape => ({ seatCount: d.seat_count, packSize: d.pack_size, packCount: d.pack_count });

/** The first statement of every write: take the pod's lock, or refuse. */
async function lockDraft(db: Queryable, where: "id" | "join_slug", key: number | string): Promise<DraftRow> {
  const { rows } = await db.query(`SELECT ${SUMMARY_COLUMNS} FROM drafts d WHERE d.${where} = $1 FOR UPDATE`, [key]);
  if (!rows[0]) throw new Refusal("not_found");
  return rows[0] as DraftRow;
}

interface SeatRow {
  seat: number;
  user_id: number | null;
  deck_id: number | null;
}

async function loadSeats(db: Queryable, draftId: number): Promise<SeatRow[]> {
  const { rows } = await db.query(
    "SELECT seat, user_id, deck_id FROM draft_seats WHERE draft_id = $1 ORDER BY seat",
    [draftId],
  );
  return rows as SeatRow[];
}

/* ------------------------------------------------------------------ *
 * Sets
 * ------------------------------------------------------------------ */

type SetRow = MirrorPrinting & { set_name: string };

/** Every row of one set, for eligibility. A few hundred rows for a real set. */
async function loadSetRows(db: Queryable, setCode: string): Promise<SetRow[]> {
  const { rows } = await db.query(
    `SELECT id::text AS id, oracle_id::text AS oracle_id, name, collector_number, rarity, layout,
            type_line, colors, color_identity, booster, set_name
       FROM scryfall_cards
      WHERE set_code = $1`,
    [setCode],
  );
  return rows as SetRow[];
}

/**
 * Sets that can be drafted, newest first, optionally filtered by name/code.
 *
 * The eligibility here is `eligibleCards` in SQL — same layout list, same
 * basic-land test, same "booster rows if any row knows, else every row" —
 * so a set offered here is one `startDraft` will accept at the default
 * pack size. `booster_known` is computed over every row of the set, as
 * `eligibleCards` does, not only over the eligible ones.
 *
 * A grouped pass over the whole mirror (~117k rows): tens of milliseconds,
 * run when someone opens the new-draft page, not on anything polled.
 */
export async function listDraftableSets(db: Queryable, search?: string): Promise<DraftSetOption[]> {
  const q = typeof search === "string" ? search.trim().slice(0, 100) : "";
  // Escape LIKE's wildcards so "100%" searches for the text, not for anything.
  const pattern = q === "" ? null : `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await db.query(
    `SELECT set_code, set_name, set_type, to_char(released, 'YYYY-MM-DD') AS released_at,
            booster_known,
            (CASE WHEN booster_known THEN booster_cards ELSE all_cards END)::int AS card_count
       FROM (SELECT set_code,
                    max(set_name) AS set_name,
                    max(set_type) AS set_type,
                    max(released_at) AS released,
                    bool_or(booster IS NOT NULL) AS booster_known,
                    count(DISTINCT oracle_id) FILTER (WHERE eligible AND booster) AS booster_cards,
                    count(DISTINCT oracle_id) FILTER (WHERE eligible) AS all_cards
               FROM (SELECT set_code, set_name, set_type, released_at, booster, oracle_id,
                            (layout <> ALL($1::text[])
                             AND (type_line IS NULL OR type_line NOT LIKE $2)) AS eligible
                       FROM scryfall_cards
                      WHERE $3::text IS NULL OR set_name ILIKE $3 OR set_code ILIKE $3) s
              GROUP BY set_code) g
      WHERE (set_type IS NULL OR set_type <> ALL($4::text[]))
        AND (CASE WHEN booster_known THEN booster_cards ELSE all_cards END) >= $5
      ORDER BY released DESC NULLS LAST, set_code
      LIMIT $6`,
    [EXCLUDED_LAYOUTS, BASIC_LAND_LIKE, pattern, EXCLUDED_SET_TYPES, MIN_DRAFTABLE_CARDS, DRAFTABLE_SET_LIMIT],
  );
  return rows as DraftSetOption[];
}

/* ------------------------------------------------------------------ *
 * Lobby
 * ------------------------------------------------------------------ */

/** Tries at a unique join_slug before giving up; see SLUG_CLAIM_ATTEMPTS in app/d/_share.ts. */
const SLUG_ATTEMPTS = 5;

/**
 * Create a pod in 'lobby' with the creator in seat 0.
 *
 * The set is checked here as well as at start, so a pod that could never
 * start is refused before anyone is invited to it. A blank name becomes
 * "<set name> draft" rather than an error: the name only labels the pod and
 * the deck saved from it. Seat and pack numbers outside the schema's CHECKs
 * throw — the page offers only valid ones (parseSeatCount and friends), so
 * an invalid one is a caller bug, not something to explain to a person.
 */
export async function createDraft(
  db: Queryable,
  input: CreateDraftInput,
): Promise<{ id: number } | { error: DraftError }> {
  const userId = validId(input.userId);
  const seatCount = parseSeatCount(input.seatCount);
  const packSize = parsePackSize(input.packSize ?? DEFAULT_PACK_SIZE);
  const packCount = parsePackCount(input.packCount ?? DEFAULT_PACK_COUNT);
  if (userId === null) throw new RangeError("createDraft: userId is not a valid id");
  if (seatCount === null || packSize === null || packCount === null) {
    throw new RangeError("createDraft: seat count, pack size or pack count out of range");
  }

  const setCode = parseSetCode(input.setCode);
  if (setCode === null) return { error: "unknown_set" };
  const rows = await loadSetRows(db, setCode);
  if (rows.length === 0) return { error: "unknown_set" };
  if (eligibleCards(rows).length < packSize) return { error: "too_few_cards" };
  const setName = rows[0]!.set_name;
  const name = parseDraftName(input.name) ?? `${setName} draft`;

  // One statement, so a pod never exists without its creator's seat.
  const sql = `WITH d AS (
                 INSERT INTO drafts (created_by, name, set_code, set_name, seat_count, pack_size, pack_count, join_slug)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id, created_by)
               INSERT INTO draft_seats (draft_id, seat, user_id)
               SELECT id, 0, created_by FROM d
               RETURNING draft_id AS id`;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    try {
      const { rows: out } = await db.query(sql, [
        userId, name, setCode, setName, seatCount, packSize, packCount, generateJoinSlug(),
      ]);
      return { id: out[0].id as number };
    } catch (err) {
      // drafts_join_slug_key is the only unique index a fresh pod can hit.
      if ((err as { code?: unknown }).code !== "23505") throw err;
    }
  }
  throw new Error(`could not claim a unique join_slug in ${SLUG_ATTEMPTS} attempts`);
}

/** The pod an invite slug names, or null. For the join page. */
export async function findDraftBySlug(db: Queryable, slug: string): Promise<DraftSummary | null> {
  if (!isPlausibleJoinSlug(slug)) return null;
  const { rows } = await db.query(`SELECT ${SUMMARY_COLUMNS} FROM drafts d WHERE d.join_slug = $1`, [slug]);
  return rows[0] ? toSummary(rows[0] as DraftRow) : null;
}

/**
 * Take the lowest free seat. Joining a pod you are already in is a no-op
 * success, whatever its status — a person re-opening their own invite link
 * should land in their pod, not on an error.
 *
 * A seat is free if it has no row, or a row whose person has since deleted
 * their account (user_id went NULL via ON DELETE SET NULL): in the lobby
 * that seat belongs to nobody, and letting it block the pod would leave a
 * permanently "full" lobby with an empty chair.
 */
export async function joinDraft(
  db: PoolLike,
  slug: string,
  userId: number,
): Promise<{ id: number } | { error: DraftError }> {
  if (!isPlausibleJoinSlug(slug) || validId(userId) === null) return { error: "not_found" };
  return inTransaction(db, async (tx) => {
    const draft = await lockDraft(tx, "join_slug", slug);
    const seats = await loadSeats(tx, draft.id);
    if (seats.some((s) => s.user_id === userId)) return { id: draft.id };
    if (draft.status !== "lobby") throw new Refusal("not_lobby");

    const taken = new Set(seats.filter((s) => s.user_id !== null).map((s) => s.seat));
    let seat = 0;
    while (seat < draft.seat_count && taken.has(seat)) seat += 1;
    if (seat >= draft.seat_count) throw new Refusal("full");

    await tx.query(
      `INSERT INTO draft_seats (draft_id, seat, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (draft_id, seat) DO UPDATE SET user_id = EXCLUDED.user_id, joined_at = now()`,
      [draft.id, seat, userId],
    );
    return { id: draft.id };
  });
}

/* ------------------------------------------------------------------ *
 * Drafting
 * ------------------------------------------------------------------ */

/**
 * Write the picks a Table made since it was loaded. One UPDATE for a human
 * pick and every bot pick it set off. `picked_by IS NULL` makes a pick that
 * lost a race match nothing; the row lock means it cannot, so a short count
 * is thrown rather than silently committed.
 */
async function savePicks(db: Queryable, draftId: number, table: Table): Promise<void> {
  if (table.picked.length === 0) return;
  const { rows } = await db.query(
    `UPDATE draft_cards c
        SET picked_by = u.seat, pick_number = u.pick, picked_at = now()
       FROM unnest($2::int[], $3::int[], $4::int[]) AS u(id, seat, pick)
      WHERE c.id = u.id AND c.draft_id = $1 AND c.picked_by IS NULL
     RETURNING c.id`,
    [draftId, table.picked.map((c) => c.id), table.picked.map((c) => c.picked_by), table.picked.map((c) => c.pick_number)],
  );
  if (rows.length !== table.picked.length) {
    throw new Error(`draft ${draftId}: wrote ${rows.length} of ${table.picked.length} picks`);
  }
}

async function finishIfComplete(db: Queryable, draftId: number, table: Table): Promise<void> {
  if (isComplete(table)) {
    await db.query("UPDATE drafts SET status = 'done', finished_at = now() WHERE id = $1", [draftId]);
  }
}

/** NULL user_id is a bot — including a seat whose person deleted their account mid-draft. */
const botSeatsOf = (seats: readonly SeatRow[]) => seats.filter((s) => s.user_id === null).map((s) => s.seat);

/**
 * Creator only. Fills empty seats with bots, opens every pack, moves to
 * 'drafting', and lets the bots take every pick they can.
 *
 * Every pack is opened here, up front, and the bots' first picks are made
 * in memory before anything is written, so the whole pod goes in with one
 * INSERT whose rows already carry those picks.
 */
export async function startDraft(
  db: PoolLike,
  draftId: number,
  userId: number,
  rng: Rng = Math.random,
): Promise<{ ok: true } | { error: DraftError }> {
  if (validId(draftId) === null || validId(userId) === null) return { error: "not_found" };
  return inTransaction(db, async (tx) => {
    const draft = await lockDraft(tx, "id", draftId);
    const seats = await loadSeats(tx, draft.id);
    if (draft.created_by !== userId) {
      throw new Refusal(seats.some((s) => s.user_id === userId) ? "not_creator" : "not_found");
    }
    if (draft.status !== "lobby") throw new Refusal("not_lobby");

    const rows = await loadSetRows(tx, draft.set_code);
    if (rows.length === 0) throw new Refusal("unknown_set");
    const pool = eligibleCards(rows);
    if (pool.length < draft.pack_size) throw new Refusal("too_few_cards");

    // Bots are seated only now, so the lobby showed only real people.
    await tx.query(
      `INSERT INTO draft_seats (draft_id, seat)
       SELECT $1, g FROM generate_series(0, $2::int - 1) AS g
       ON CONFLICT (draft_id, seat) DO NOTHING`,
      [draft.id, draft.seat_count],
    );
    const humans = new Set(seats.filter((s) => s.user_id !== null).map((s) => s.seat));
    const bots: number[] = [];
    for (let seat = 0; seat < draft.seat_count; seat += 1) if (!humans.has(seat)) bots.push(seat);

    const cards: TableCard[] = [];
    for (let round = 0; round < draft.pack_count; round += 1) {
      for (let origin = 0; origin < draft.seat_count; origin += 1) {
        openPack(pool, draft.pack_size, rng).forEach((card, slot) => {
          cards.push({
            round,
            origin,
            slot,
            scryfall_id: card.id,
            rarity: card.rarity,
            colors: card.colors,
            color_identity: card.color_identity,
            picked_by: null,
            pick_number: null,
          });
        });
      }
    }
    const table = buildTable(shapeOf(draft), cards);
    runBots(table, bots, rng);

    await tx.query(
      `INSERT INTO draft_cards (draft_id, round, origin_seat, slot, scryfall_id, picked_by, pick_number, picked_at)
       SELECT $1, u.round, u.origin, u.slot, u.sid, u.seat, u.pick,
              CASE WHEN u.seat IS NULL THEN NULL ELSE now() END
         FROM unnest($2::int[], $3::int[], $4::int[], $5::uuid[], $6::int[], $7::int[])
              AS u(round, origin, slot, sid, seat, pick)`,
      [
        draft.id,
        cards.map((c) => c.round),
        cards.map((c) => c.origin),
        cards.map((c) => c.slot),
        cards.map((c) => c.scryfall_id),
        cards.map((c) => c.picked_by),
        cards.map((c) => c.pick_number),
      ],
    );
    await tx.query("UPDATE drafts SET status = 'drafting', started_at = now() WHERE id = $1", [draft.id]);
    // Only reachable if every seat is a bot — the creator deleted their
    // account between creating and starting. Harmless; keeps the invariant.
    await finishIfComplete(tx, draft.id, table);
    return { ok: true as const };
  });
}

/** Every card of a pod, with what a bot needs to judge it. At most 960 rows. */
async function loadTable(db: Queryable, draft: DraftRow): Promise<Table> {
  const { rows } = await db.query(
    `SELECT c.id, c.round, c.origin_seat AS origin, c.slot, c.scryfall_id::text AS scryfall_id,
            c.picked_by, c.pick_number,
            -- LEFT JOIN: a card the mirror has since lost is still in the pack,
            -- and a bot still has to be able to take it.
            COALESCE(s.rarity, 'common') AS rarity, s.colors, s.color_identity
       FROM draft_cards c
       LEFT JOIN scryfall_cards s ON s.id = c.scryfall_id
      WHERE c.draft_id = $1`,
    [draft.id],
  );
  return buildTable(shapeOf(draft), rows as TableCard[]);
}

/**
 * Take one card from the pack in front of this person, then let the bots
 * catch up. Marks the draft 'done' when the last card goes.
 *
 * `not_your_turn` covers "no pack in front of you" in every form: waiting on
 * a neighbour, already finished, or a pod still in its lobby.
 */
export async function makePick(
  db: PoolLike,
  draftId: number,
  userId: number,
  draftCardId: number,
  rng: Rng = Math.random,
): Promise<{ ok: true } | { error: DraftError }> {
  if (validId(draftId) === null || validId(userId) === null) return { error: "not_found" };
  // An invalid card id still goes through the membership checks, so a
  // stranger gets not_found and a member gets not_in_pack. 0 is no SERIAL.
  const cardId = validId(draftCardId) ?? 0;
  return inTransaction(db, async (tx) => {
    const draft = await lockDraft(tx, "id", draftId);
    const seats = await loadSeats(tx, draft.id);
    const mine = seats.find((s) => s.user_id === userId);
    if (!mine) throw new Refusal("not_found");
    if (draft.status === "done") throw new Refusal("done");
    if (draft.status !== "drafting") throw new Refusal("not_your_turn");

    const table = await loadTable(tx, draft);
    const pack = packInFront(table, mine.seat);
    if (!pack) throw new Refusal("not_your_turn");
    const card = pack.find((c) => c.id === cardId);
    if (!card) throw new Refusal("not_in_pack");

    takeCard(table, mine.seat, card);
    runBots(table, botSeatsOf(seats), rng);
    await savePicks(tx, draft.id, table);
    await finishIfComplete(tx, draft.id, table);
    return { ok: true as const };
  });
}

/* ------------------------------------------------------------------ *
 * Reading a pod
 * ------------------------------------------------------------------ */

/** Multi-face cards have no top-level art; the front face's is the one to show. */
const CARD_VIEW_COLUMNS = `c.id, c.scryfall_id::text AS scryfall_id,
  COALESCE(s.name, 'Card missing from the mirror') AS name, s.mana_cost, s.type_line,
  COALESCE(s.rarity, 'common') AS rarity, s.colors,
  COALESCE(s.image_uris->>'normal', s.card_faces->0->'image_uris'->>'normal') AS image`;

function toCardView(row: Record<string, unknown>): DraftCardView {
  return {
    id: row.id as number,
    scryfall_id: row.scryfall_id as string,
    name: row.name as string,
    mana_cost: (row.mana_cost as string | null) ?? null,
    type_line: (row.type_line as string | null) ?? null,
    rarity: row.rarity as string,
    colors: (row.colors as string[] | null) ?? null,
    image: (row.image as string | null) ?? null,
  };
}

/**
 * Everything one member sees. null when the pod does not exist or they are
 * not in it — including in the lobby: a non-member finds a pod through its
 * invite (`findDraftBySlug`), not by id.
 *
 * Polled every couple of seconds by everyone waiting, so it is three
 * queries (two in the lobby) on the 0008 indexes, whatever the pod's size:
 * the pod and the viewer's seat; every seat with its label and pick count;
 * then the viewer's current pack and their picks together.
 *
 * `round`/`pick` come straight from the position rule, so a seat that has
 * made every pick reads round = pack_count, pick = 0 — one past the last —
 * with neither a pack nor anyone to wait on. In the lobby both are 0.
 */
export async function loadSeatState(db: Queryable, draftId: number, userId: number): Promise<DraftSeatState | null> {
  if (validId(draftId) === null || validId(userId) === null) return null;
  const { rows: drafts } = await db.query(
    `SELECT ${SUMMARY_COLUMNS}, s.seat AS my_seat
       FROM drafts d
       JOIN draft_seats s ON s.draft_id = d.id AND s.user_id = $2
      WHERE d.id = $1`,
    [draftId, userId],
  );
  if (!drafts[0]) return null;
  const draft = drafts[0] as DraftRow & { my_seat: number };
  const shape = shapeOf(draft);

  const { rows: seatRows } = await db.query(
    `SELECT s.seat, s.user_id, s.deck_id,
            COALESCE(NULLIF(btrim(u.name), ''), NULLIF(split_part(u.email, '@', 1), '')) AS person,
            (SELECT count(*)::int FROM draft_cards c
              WHERE c.draft_id = s.draft_id AND c.picked_by = s.seat) AS picks_made
       FROM draft_seats s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.draft_id = $1
      ORDER BY s.seat`,
    [draft.id],
  );
  const seats: DraftSeatView[] = seatRows.map((r) => ({
    seat: r.seat,
    user_id: r.user_id,
    // 1-based for people: seat 0 is the first chair, and "Bot 0" reads as a bug.
    label: r.user_id === null ? `Bot ${r.seat + 1}` : (r.person ?? `Seat ${r.seat + 1}`),
    is_bot: r.user_id === null,
    picks_made: r.picks_made,
    deck_id: r.deck_id,
  }));
  const me = seats.find((s) => s.seat === draft.my_seat)!;

  const state: DraftSeatState = {
    draft: toSummary(draft),
    seats,
    my_seat: me.seat,
    round: 0,
    pick: 0,
    pack: null,
    waiting_on: null,
    picks: [],
  };
  if (draft.status === "lobby") return state;

  const { round, pick } = seatPosition(me.picks_made, shape);
  state.round = round;
  state.pick = pick;
  const drafting = round < draft.pack_count;
  // The pack this seat holds (or is waiting for), by the position rule.
  const origin = drafting ? packOrigin(me.seat, round, pick, draft.seat_count) : -1;

  const { rows } = await db.query(
    `SELECT ${CARD_VIEW_COLUMNS}, c.round, c.origin_seat, c.picked_by, c.pick_number
       FROM draft_cards c
       LEFT JOIN scryfall_cards s ON s.id = c.scryfall_id
      WHERE c.draft_id = $1
        AND ((c.round = $2 AND c.origin_seat = $3) OR c.picked_by = $4)
      ORDER BY c.round, c.pick_number NULLS LAST, c.slot`,
    [draft.id, round, origin, me.seat],
  );

  const inPack = rows.filter((r) => r.round === round && r.origin_seat === origin);
  state.picks = rows.filter((r) => r.picked_by === me.seat).map(toCardView);
  if (drafting) {
    const taken = inPack.filter((r) => r.picked_by !== null).length;
    if (taken === pick) {
      state.pack = inPack
        .filter((r) => r.picked_by === null)
        .sort((a, b) => (a.slot as number) - (b.slot as number))
        .map(toCardView);
    } else {
      const holder = seatToPickFrom(origin, round, taken, draft.seat_count);
      state.waiting_on = seats.find((s) => s.seat === holder) ?? null;
    }
  }
  return state;
}

/** Pods this person created or sits in, newest first. */
export async function listMyDrafts(db: Queryable, userId: number): Promise<DraftSummary[]> {
  if (validId(userId) === null) return [];
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLUMNS}
       FROM drafts d
      WHERE d.created_by = $1
         OR EXISTS (SELECT 1 FROM draft_seats s WHERE s.draft_id = d.id AND s.user_id = $1)
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT 100`,
    [userId],
  );
  return (rows as DraftRow[]).map(toSummary);
}

/* ------------------------------------------------------------------ *
 * Afterwards
 * ------------------------------------------------------------------ */

/**
 * Save this person's picks as a new deck (format 'limited', every pick in
 * 'main'), remember it on their seat, and return it. Saving twice returns the
 * deck already saved rather than making a second.
 *
 * Allowed once THIS seat has made its last pick, not only once the whole pod
 * is 'done': a person's picks are final the moment they take their last
 * card, and they should not have to wait on a slow friend to start
 * building. Not before, and that is why the rule is not "any time after one
 * pick": saving is idempotent, so a deck saved at pick 20 would be the deck
 * forever, missing the other 22 picks. Before then the answer is
 * `not_your_turn`: it is not yet your turn to save.
 *
 * If the saved deck has since been deleted (deck_id went NULL via ON DELETE
 * SET NULL), saving again makes a fresh one — the picks are still here.
 *
 * `createDeck` makes the deck; the cards go in as one grouped INSERT rather
 * than a call to `addDeckCard` per pick, which would be up to 120 upserts and
 * 120 `touchDeck`s for a deck nobody else can see yet. Two copies of a common
 * are one row with quantity 2, as the deck editor would store them.
 */
export async function savePicksAsDeck(
  db: PoolLike,
  draftId: number,
  userId: number,
): Promise<{ deckId: number } | { error: DraftError }> {
  if (validId(draftId) === null || validId(userId) === null) return { error: "not_found" };
  return inTransaction(db, async (tx) => {
    const draft = await lockDraft(tx, "id", draftId);
    const seats = await loadSeats(tx, draft.id);
    const mine = seats.find((s) => s.user_id === userId);
    if (!mine) throw new Refusal("not_found");

    if (mine.deck_id !== null) {
      const { rows } = await tx.query("SELECT id FROM decks WHERE id = $1 AND user_id = $2", [mine.deck_id, userId]);
      if (rows[0]) return { deckId: rows[0].id as number };
    }

    const { rows: counted } = await tx.query(
      "SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by = $2",
      [draft.id, mine.seat],
    );
    if (counted[0].n < draft.pack_count * draft.pack_size) throw new Refusal("not_your_turn");

    const deck = await createDeck(tx, userId, {
      name: draft.name,
      format: "limited",
      description: `Drafted from ${draft.set_name} (${draft.set_code.toUpperCase()}).`,
    });
    await tx.query(
      `INSERT INTO deck_cards (deck_id, scryfall_id, quantity, board, finish)
       SELECT $1, scryfall_id, count(*)::int, 'main', 'nonfoil'
         FROM draft_cards
        WHERE draft_id = $2 AND picked_by = $3
        GROUP BY scryfall_id`,
      [deck.id, draft.id, mine.seat],
    );
    await tx.query("UPDATE draft_seats SET deck_id = $3 WHERE draft_id = $1 AND seat = $2", [
      draft.id, mine.seat, deck.id,
    ]);
    return { deckId: deck.id };
  });
}
