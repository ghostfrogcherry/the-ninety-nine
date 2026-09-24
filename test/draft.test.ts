/**
 * Draft engine against Postgres — `lib/draft/index.ts`.
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * Skipped without TEST_DATABASE_URL. Runs in a throwaway database of this
 * file's own (test/_db.ts), seeded with a synthetic set rather than the demo
 * fixture, because a pod needs a set with real rarity spread: 120 booster
 * cards plus the rows a draft must never deal (showcase variants, basics, a
 * token). The pure half — packs, bots, the position rule — is
 * test/draft-packs.test.ts.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { SKIP_WITHOUT_DATABASE, createTestDatabase, type TestDatabase } from "./_db.ts";

import type * as DraftModule from "../lib/draft";
import type { DraftSeatState } from "../lib/draft";
import type { Rng } from "../lib/draft/packs";

const draftSpecifier = "../lib/draft/index.ts";
const {
  MIN_DRAFTABLE_CARDS,
  createDraft,
  findDraftBySlug,
  isPlausibleJoinSlug,
  joinDraft,
  listDraftableSets,
  listMyDrafts,
  loadSeatState,
  makePick,
  parseSeatCount,
  parseSetCode,
  savePicksAsDeck,
  startDraft,
} = (await import(draftSpecifier)) as typeof DraftModule;

/** mulberry32, as in test/draft-packs.test.ts: replayable packs and bot picks. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SynthCard {
  id: string;
  oracle_id: string;
  name: string;
  set_code: string;
  set_name: string;
  set_type: string | null;
  collector_number: string;
  rarity: string;
  layout: string;
  type_line: string;
  colors: string[];
  booster: boolean | null;
  released_at: string;
}

let serial = 0;
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A set of `counts` cards per rarity, all booster-flagged as given. */
function synthSet(
  setCode: string,
  setName: string,
  counts: Record<string, number>,
  opts: { booster?: boolean | null; setType?: string | null; released?: string } = {},
): SynthCard[] {
  const colours = [["W"], ["U"], ["B"], ["R"], ["G"], []];
  const out: SynthCard[] = [];
  let cn = 0;
  for (const [rarity, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      serial += 1;
      cn += 1;
      out.push({
        id: uuid("aaaaaaaa", serial),
        oracle_id: uuid("bbbbbbbb", serial),
        name: `${setName} ${rarity} ${i + 1}`,
        set_code: setCode,
        set_name: setName,
        set_type: opts.setType === undefined ? "expansion" : opts.setType,
        collector_number: String(cn),
        rarity,
        layout: "normal",
        type_line: "Creature — Test",
        colors: colours[serial % colours.length]!,
        booster: opts.booster === undefined ? true : opts.booster,
        released_at: opts.released ?? "2026-01-01",
      });
    }
  }
  return out;
}

/** The main set: 120 booster cards, plus rows no pack may ever contain. */
const TST = synthSet("tst", "Test Set", { mythic: 10, rare: 25, uncommon: 35, common: 50 }, { released: "2026-06-01" });
const TST_BOOSTER_IDS = new Set(TST.map((c) => c.id));
serial += 1;
const TST_SHOWCASE: SynthCard = {
  ...TST[0]!,
  id: uuid("aaaaaaaa", serial),
  collector_number: "301",
  name: TST[0]!.name,
  booster: false,
};
serial += 1;
const TST_FOREST: SynthCard = {
  ...TST[50]!,
  id: uuid("aaaaaaaa", serial),
  oracle_id: uuid("bbbbbbbb", serial),
  name: "Forest",
  type_line: "Basic Land — Forest",
  collector_number: "280",
  rarity: "common",
  colors: [],
  booster: true,
};
serial += 1;
const TST_TOKEN: SynthCard = {
  ...TST[60]!,
  id: uuid("aaaaaaaa", serial),
  oracle_id: uuid("bbbbbbbb", serial),
  name: "Soldier",
  layout: "token",
  type_line: "Token Creature — Soldier",
  collector_number: "T1",
  booster: true,
};

/** Unknown booster flag everywhere (pre-0008 data): drafted from every row. */
const OLD = synthSet("old", "Old Set", { rare: 10, uncommon: 20, common: 30 }, { booster: null, setType: null, released: "2001-01-01" });
/** Too small to fill a 14-card pack. */
const TNY = synthSet("tny", "Tiny Set", { rare: 3, uncommon: 4, common: 6 });
/** Big enough for a pack, below the listing threshold. */
const SML = synthSet("sml", "Small Set", { rare: 5, uncommon: 10, common: 15 });
/** Plenty of cards, but a set_type the listing never offers. */
const TOK = synthSet("tok", "Token Set", { common: 60 }, { setType: "token" });

const MIRROR = [...TST, TST_SHOWCASE, TST_FOREST, TST_TOKEN, ...OLD, ...TNY, ...SML, ...TOK];

describe("draft engine against postgres", { skip: SKIP_WITHOUT_DATABASE }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  const users: Record<string, number> = {};

  const q = async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows;

  async function mustState(draftId: number, userId: number): Promise<DraftSeatState> {
    const state = await loadSeatState(pool, draftId, userId);
    assert.ok(state, "a member must see their pod");
    return state;
  }

  async function newPod(owner: number, over: Partial<Parameters<typeof createDraft>[1]> = {}) {
    const out = await createDraft(pool, { userId: owner, name: "Friday pod", setCode: "tst", seatCount: 4, ...over });
    assert.ok("id" in out, `createDraft refused: ${JSON.stringify(out)}`);
    return out.id;
  }

  const slugOf = async (draftId: number) => (await q("SELECT join_slug FROM drafts WHERE id = $1", [draftId]))[0].join_slug as string;

  before(async () => {
    db = await createTestDatabase("draft");
    pool = new pg.Pool({ connectionString: db.url, max: 6 });
    for (const c of MIRROR) {
      await pool.query(
        `INSERT INTO scryfall_cards
           (id, oracle_id, name, set_code, set_name, collector_number, rarity, layout,
            type_line, colors, color_identity, booster, set_type, released_at, image_uris)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$10::text[],$11,$12,$13,$14::jsonb)`,
        [
          c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity, c.layout,
          c.type_line, c.colors, c.booster, c.set_type, c.released_at,
          JSON.stringify({ normal: `https://img.invalid/${c.id}.jpg` }),
        ],
      );
    }
    for (const [key, name] of [["alice", "Alice"], ["bob", null], ["carol", "Carol"], ["dave", "Dave"]] as const) {
      const { rows } = await pool.query("INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id", [
        name,
        `${key}@draft.invalid`,
      ]);
      users[key] = rows[0].id;
    }
  });

  after(async () => {
    // No row-by-row cleanup: the whole database goes. See test/_db.ts.
    await pool?.end();
    await db?.drop();
  });

  /* ---------------------------------------------------------------- *
   * Sets
   * ---------------------------------------------------------------- */

  describe("listDraftableSets", () => {
    it("offers sets with enough eligible cards, newest first, and says whether booster is known", async () => {
      const sets = await listDraftableSets(pool);
      const codes = sets.map((s) => s.set_code);
      assert.deepEqual(codes, ["tst", "old"], "tny/sml are too small, tok is a token set_type");
      const tst = sets[0]!;
      // 120 booster cards; the showcase shares an oracle_id and is not booster,
      // the Forest is a basic, the Soldier a token.
      assert.equal(tst.card_count, 120);
      assert.equal(tst.booster_known, true);
      assert.equal(tst.set_type, "expansion");
      assert.equal(tst.released_at, "2026-06-01");
      const old = sets[1]!;
      assert.equal(old.booster_known, false);
      assert.equal(old.card_count, 60, "unknown booster: every row counts");
      assert.equal(old.set_type, null);
      assert.ok(SML.length < MIN_DRAFTABLE_CARDS);
    });

    it("searches name and code, and treats LIKE wildcards as text", async () => {
      assert.deepEqual((await listDraftableSets(pool, "test")).map((s) => s.set_code), ["tst"]);
      assert.deepEqual((await listDraftableSets(pool, "OLD")).map((s) => s.set_code), ["old"]);
      assert.deepEqual(await listDraftableSets(pool, "%"), []);
      assert.deepEqual(await listDraftableSets(pool, "_st"), []);
    });
  });

  /* ---------------------------------------------------------------- *
   * Lobby
   * ---------------------------------------------------------------- */

  describe("createDraft and joining", () => {
    it("creates a lobby with the creator in seat 0 and a random invite slug", async () => {
      const id = await newPod(users.alice!);
      const [row] = await q("SELECT * FROM drafts WHERE id = $1", [id]);
      assert.equal(row.status, "lobby");
      assert.equal(row.set_name, "Test Set");
      assert.equal(row.pack_size, 14);
      assert.equal(row.pack_count, 3);
      assert.ok(isPlausibleJoinSlug(row.join_slug));
      assert.deepEqual(await q("SELECT seat, user_id FROM draft_seats WHERE draft_id = $1", [id]), [
        { seat: 0, user_id: users.alice },
      ]);
      const found = await findDraftBySlug(pool, row.join_slug);
      assert.equal(found?.id, id);
      assert.equal(typeof found?.created_at, "string");
      assert.equal(await findDraftBySlug(pool, "not-a-slug"), null);
      assert.equal(await findDraftBySlug(pool, "0".repeat(20)), null);
    });

    it("names an unnamed pod after its set, and accepts an uppercase set code", async () => {
      const out = await createDraft(pool, { userId: users.alice!, name: "   ", setCode: " TST ", seatCount: 2 });
      assert.ok("id" in out);
      const [row] = await q("SELECT name, set_code FROM drafts WHERE id = $1", [out.id]);
      assert.deepEqual(row, { name: "Test Set draft", set_code: "tst" });
    });

    it("refuses unknown and too-small sets, and throws on out-of-range numbers", async () => {
      const base = { userId: users.alice!, name: "x", seatCount: 4 };
      assert.deepEqual(await createDraft(pool, { ...base, setCode: "zzz" }), { error: "unknown_set" });
      assert.deepEqual(await createDraft(pool, { ...base, setCode: "'; drop" }), { error: "unknown_set" });
      assert.deepEqual(await createDraft(pool, { ...base, setCode: "tny" }), { error: "too_few_cards" });
      // 13 eligible cards: a 12-card pack fits, a 14-card one does not.
      assert.ok("id" in (await createDraft(pool, { ...base, setCode: "tny", packSize: 12 })));
      await assert.rejects(() => createDraft(pool, { ...base, setCode: "tst", seatCount: 9 }), RangeError);
      await assert.rejects(() => createDraft(pool, { ...base, setCode: "tst", packSize: 21 }), RangeError);
      await assert.rejects(() => createDraft(pool, { ...base, setCode: "tst", packCount: 0 }), RangeError);
      await assert.rejects(() => createDraft(pool, { ...base, userId: 2 ** 31, setCode: "tst" }), RangeError);
      assert.equal(parseSeatCount("8"), 8);
      assert.equal(parseSeatCount("1e1"), null);
      assert.equal(parseSetCode("DSK"), "dsk");
    });

    it("seats joiners in the lowest free seat; rejoining is a no-op; a full pod says so", async () => {
      const id = await newPod(users.alice!, { seatCount: 2 });
      const slug = await slugOf(id);
      assert.deepEqual(await joinDraft(pool, slug, users.bob!), { id });
      assert.deepEqual(await joinDraft(pool, slug, users.bob!), { id }, "joining twice is not an error");
      assert.deepEqual(await joinDraft(pool, slug, users.carol!), { error: "full" });
      assert.deepEqual(await joinDraft(pool, "0".repeat(20), users.carol!), { error: "not_found" });
      assert.deepEqual(await joinDraft(pool, "junk", users.carol!), { error: "not_found" });
      const seats = await q("SELECT seat, user_id FROM draft_seats WHERE draft_id = $1 ORDER BY seat", [id]);
      assert.deepEqual(seats, [
        { seat: 0, user_id: users.alice },
        { seat: 1, user_id: users.bob },
      ]);
    });

    it("keeps non-members out: no state, no start, no pick", async () => {
      const id = await newPod(users.alice!);
      assert.equal(await loadSeatState(pool, id, users.carol!), null, "not yours reads as not there");
      assert.equal(await loadSeatState(pool, 2 ** 31, users.alice!), null, "out-of-int4 id is null, not a 500");
      assert.equal(await loadSeatState(pool, 999999, users.alice!), null);
      assert.deepEqual(await startDraft(pool, id, users.carol!), { error: "not_found" });
      assert.deepEqual(await makePick(pool, id, users.carol!, 1), { error: "not_found" });
      assert.deepEqual(await savePicksAsDeck(pool, id, users.carol!), { error: "not_found" });
      assert.deepEqual(await startDraft(pool, 2 ** 31, users.alice!), { error: "not_found" });

      const slug = await slugOf(id);
      await joinDraft(pool, slug, users.bob!);
      assert.deepEqual(await startDraft(pool, id, users.bob!), { error: "not_creator" });
      const lobby = await mustState(id, users.bob!);
      assert.equal(lobby.draft.status, "lobby");
      assert.equal(lobby.my_seat, 1);
      assert.equal(lobby.pack, null);
      assert.equal(lobby.waiting_on, null);
      assert.deepEqual(lobby.seats.map((s) => s.label), ["Alice", "bob"], "no name: the email's local part");
      assert.deepEqual(await makePick(pool, id, users.bob!, 1), { error: "not_your_turn" });
    });

    it("rolls a refused start back: no bots seated when the set cannot fill the packs", async () => {
      const id = await newPod(users.alice!, { setCode: "sml" });
      // The mirror is refreshed between create and start, and the set shrinks.
      await q("UPDATE scryfall_cards SET booster = false WHERE set_code = 'sml' AND collector_number::int > 10");
      assert.deepEqual(await startDraft(pool, id, users.alice!), { error: "too_few_cards" });
      assert.equal((await q("SELECT count(*)::int AS n FROM draft_seats WHERE draft_id = $1", [id]))[0].n, 1);
      assert.equal((await q("SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1", [id]))[0].n, 0);
      assert.equal((await q("SELECT status FROM drafts WHERE id = $1", [id]))[0].status, "lobby");

      await q("DELETE FROM scryfall_cards WHERE set_code = 'sml'");
      assert.deepEqual(await startDraft(pool, id, users.alice!), { error: "unknown_set" });
    });
  });

  /* ---------------------------------------------------------------- *
   * A whole draft
   * ---------------------------------------------------------------- */

  describe("a four-seat pod, two people and two bots", () => {
    let id: number;
    const PACK = 14;
    const ROUNDS = 3;

    before(async () => {
      id = await newPod(users.alice!, { seatCount: 4 });
      await joinDraft(pool, await slugOf(id), users.bob!);
    });

    it("starts: bots fill seats 2 and 3, every pack is opened, and the bots take their first picks", async () => {
      assert.deepEqual(await startDraft(pool, id, users.alice!, seeded(1)), { ok: true });
      assert.deepEqual(await startDraft(pool, id, users.alice!, seeded(1)), { error: "not_lobby" });

      const seats = await q("SELECT seat, user_id FROM draft_seats WHERE draft_id = $1 ORDER BY seat", [id]);
      assert.deepEqual(seats.map((s) => s.user_id), [users.alice, users.bob, null, null]);
      const cards = await q("SELECT * FROM draft_cards WHERE draft_id = $1", [id]);
      assert.equal(cards.length, 4 * PACK * ROUNDS);
      for (const c of cards) assert.ok(TST_BOOSTER_IDS.has(c.scryfall_id), "only booster cards of the set");
      assert.ok(!cards.some((c) => [TST_SHOWCASE.id, TST_FOREST.id, TST_TOKEN.id].includes(c.scryfall_id)));
      const packs = new Map<string, string[]>();
      for (const c of cards) packs.set(`${c.round}:${c.origin_seat}`, [...(packs.get(`${c.round}:${c.origin_seat}`) ?? []), c.scryfall_id]);
      assert.equal(packs.size, 12);
      for (const pack of packs.values()) assert.equal(new Set(pack).size, PACK, "no duplicate within a pack");

      // Seat 2's bot took from its own pack; seat 3's took its own and then
      // seat 2's (which seat 2 had just picked from). Neither person has.
      const bySeat = await q(
        "SELECT picked_by, count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by IS NOT NULL GROUP BY 1 ORDER BY 1",
        [id],
      );
      assert.deepEqual(bySeat, [{ picked_by: 2, n: 1 }, { picked_by: 3, n: 2 }]);
      assert.equal((await q("SELECT status FROM drafts WHERE id = $1", [id]))[0].status, "drafting");
    });

    it("joining after the start is refused, except for someone already seated", async () => {
      const slug = await slugOf(id);
      assert.deepEqual(await joinDraft(pool, slug, users.carol!), { error: "not_lobby" });
      assert.deepEqual(await joinDraft(pool, slug, users.bob!), { id });
    });

    it("shows each person their own pack, with card details from the mirror", async () => {
      const alice = await mustState(id, users.alice!);
      assert.equal(alice.my_seat, 0);
      assert.equal(alice.round, 0);
      assert.equal(alice.pick, 0);
      assert.equal(alice.waiting_on, null);
      assert.equal(alice.pack?.length, PACK);
      const card = alice.pack![0]!;
      assert.match(card.name, /^Test Set /);
      assert.equal(card.image, `https://img.invalid/${card.scryfall_id}.jpg`);
      assert.deepEqual(alice.seats.map((s) => [s.label, s.is_bot, s.picks_made]), [
        ["Alice", false, 0],
        ["bob", false, 0],
        ["Bot 3", true, 1],
        ["Bot 4", true, 2],
      ]);
    });

    it("refuses a card that is not in the pack, and a double-submitted pick", async () => {
      const alice = await mustState(id, users.alice!);
      const bob = await mustState(id, users.bob!);
      assert.deepEqual(await makePick(pool, id, users.alice!, bob.pack![0]!.id), { error: "not_in_pack" });
      assert.deepEqual(await makePick(pool, id, users.alice!, 2 ** 31), { error: "not_in_pack" });

      const cardId = alice.pack![0]!.id;
      assert.deepEqual(await makePick(pool, id, users.alice!, cardId, seeded(2)), { ok: true });
      const again = await makePick(pool, id, users.alice!, cardId, seeded(2));
      assert.ok("error" in again && ["not_your_turn", "not_in_pack"].includes(again.error), JSON.stringify(again));
      const [{ n }] = await q("SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by = 0", [id]);
      assert.equal(n, 1, "one pick, not two");
    });

    it("says who a person is waiting on when they get ahead", async () => {
      // Alice keeps picking while Bob does nothing. Her pick 3 of round 0 is
      // Bob's own pack, which cannot move until he takes from it.
      for (let i = 0; i < 5; i += 1) {
        const state = await mustState(id, users.alice!);
        if (!state.pack) break;
        assert.deepEqual(await makePick(pool, id, users.alice!, state.pack[0]!.id, seeded(3 + i)), { ok: true });
      }
      const alice = await mustState(id, users.alice!);
      assert.equal(alice.pick, 3);
      assert.equal(alice.pack, null);
      assert.equal(alice.waiting_on?.seat, 1);
      assert.equal(alice.waiting_on?.label, "bob");
      assert.deepEqual(await makePick(pool, id, users.alice!, 1), { error: "not_your_turn" });
      assert.equal(alice.picks.length, 3);

      const bob = await mustState(id, users.bob!);
      assert.equal(bob.pick, 0);
      assert.equal(bob.pack?.length, PACK);
    });

    it("lets exactly one of two simultaneous picks for the same seat through", async () => {
      const bob = await mustState(id, users.bob!);
      const [a, b] = bob.pack!;
      const results = await Promise.all([
        makePick(pool, id, users.bob!, a!.id, seeded(7)),
        makePick(pool, id, users.bob!, b!.id, seeded(8)),
      ]);
      assert.equal(results.filter((r) => "ok" in r).length, 1, JSON.stringify(results));
      const [{ n }] = await q("SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by = 1", [id]);
      assert.equal(n, 1);
    });

    it("refuses to save a deck before the person's last pick", async () => {
      assert.deepEqual(await savePicksAsDeck(pool, id, users.bob!), { error: "not_your_turn" });
    });

    it("drafts to the end with both people picking and the bots in between", async () => {
      const people = [users.alice!, users.bob!];
      let status = "drafting";
      for (let turn = 0; turn < 500 && status !== "done"; turn += 1) {
        let progressed = false;
        for (const who of people) {
          const state = await mustState(id, who);
          status = state.draft.status;
          if (state.round < ROUNDS && status === "drafting") {
            assert.ok((state.pack === null) !== (state.waiting_on === null), "exactly one of pack / waiting_on");
          }
          if (!state.pack) continue;
          assert.equal(state.pack.length, PACK - state.pick, "a pack shrinks by one per pick");
          const choice = state.pack[turn % state.pack.length]!;
          assert.deepEqual(await makePick(pool, id, who, choice.id, seeded(100 + turn)), { ok: true });
          progressed = true;
        }
        if (!progressed) status = (await q("SELECT status FROM drafts WHERE id = $1", [id]))[0].status;
        assert.ok(progressed || status === "done", "nobody could pick, yet the draft is not over");
      }

      const [draft] = await q("SELECT status, finished_at FROM drafts WHERE id = $1", [id]);
      assert.equal(draft.status, "done");
      assert.ok(draft.finished_at);

      const cards = await q("SELECT * FROM draft_cards WHERE draft_id = $1", [id]);
      assert.equal(cards.length, 4 * PACK * ROUNDS);
      assert.ok(cards.every((c) => c.picked_by !== null && c.picked_at !== null), "every card picked exactly once");
      const perSeat = new Map<number, number>();
      for (const c of cards) perSeat.set(c.picked_by, (perSeat.get(c.picked_by) ?? 0) + 1);
      assert.deepEqual([...perSeat.entries()].sort(), [[0, 42], [1, 42], [2, 42], [3, 42]]);
      // Pass direction: the k-th card out of a pack went k seats along,
      // leftwards in rounds 0 and 2 and rightwards in round 1.
      for (const c of cards) {
        const dir = c.round % 2 === 0 ? 1 : -1;
        assert.equal(c.picked_by, (((c.origin_seat + c.pick_number * dir) % 4) + 4) % 4);
      }

      const done = await mustState(id, users.alice!);
      assert.equal(done.pack, null);
      assert.equal(done.waiting_on, null);
      assert.equal(done.round, ROUNDS);
      assert.equal(done.picks.length, 42);
      assert.deepEqual(
        done.picks.map((p) => p.id),
        cards.filter((c) => c.picked_by === 0).sort((a, b) => a.round - b.round || a.pick_number - b.pick_number).map((c) => c.id),
        "picks come back in pick order",
      );
      assert.deepEqual(await makePick(pool, id, users.alice!, done.picks[0]!.id), { error: "done" });
    });

    it("saves a person's picks as a limited deck, once", async () => {
      const first = await savePicksAsDeck(pool, id, users.bob!);
      assert.ok("deckId" in first);
      assert.deepEqual(await savePicksAsDeck(pool, id, users.bob!), first, "idempotent");

      const [deck] = await q("SELECT user_id, name, format FROM decks WHERE id = $1", [first.deckId]);
      assert.deepEqual(deck, { user_id: users.bob, name: "Friday pod", format: "limited" });
      const deckCards = await q(
        "SELECT scryfall_id::text AS id, quantity, board, finish FROM deck_cards WHERE deck_id = $1",
        [first.deckId],
      );
      const picks = await q(
        "SELECT scryfall_id::text AS id, count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by = 1 GROUP BY 1",
        [id],
      );
      assert.deepEqual(
        deckCards.map((c) => [c.id, c.quantity, c.board, c.finish]).sort(),
        picks.map((p) => [p.id, p.n, "main", "nonfoil"]).sort(),
      );
      assert.equal(deckCards.reduce((n, c) => n + c.quantity, 0), 42);
      const bob = await mustState(id, users.bob!);
      assert.equal(bob.seats[1]!.deck_id, first.deckId);

      // Delete the deck: the seat forgets it, and saving again makes a new one.
      await q("DELETE FROM decks WHERE id = $1", [first.deckId]);
      const second = await savePicksAsDeck(pool, id, users.bob!);
      assert.ok("deckId" in second && second.deckId !== first.deckId);
    });

    it("lists the pod for its members only", async () => {
      assert.ok((await listMyDrafts(pool, users.alice!)).some((d) => d.id === id));
      assert.ok((await listMyDrafts(pool, users.bob!)).some((d) => d.id === id));
      assert.ok(!(await listMyDrafts(pool, users.carol!)).some((d) => d.id === id));
      assert.deepEqual(await listMyDrafts(pool, 2 ** 31), []);
    });
  });

  describe("a set with no booster flag (pre-0008 data)", () => {
    it("drafts from every row", async () => {
      const id = await newPod(users.carol!, { setCode: "old", seatCount: 2, packCount: 1 });
      assert.deepEqual(await startDraft(pool, id, users.carol!, seeded(5)), { ok: true });
      const [{ n }] = await q("SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1", [id]);
      assert.equal(n, 2 * 14);
    });
  });

  /* ---------------------------------------------------------------- *
   * Speed: the page polls loadSeatState, and a pick sets off every bot
   * ---------------------------------------------------------------- */

  describe("an eight-seat pod with seven bots", () => {
    const BUDGET_MS = 300;

    it(`starts, picks and reads well inside ${BUDGET_MS}ms each`, async (t) => {
      const id = await newPod(users.dave!, { seatCount: 8, packSize: 15, packCount: 3 });

      let t0 = performance.now();
      assert.deepEqual(await startDraft(pool, id, users.dave!, seeded(11)), { ok: true });
      const startMs = performance.now() - t0;

      // At the start seven bots have picked all they can; the person's first
      // pick releases a cascade through all seven.
      const before = (await q("SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by IS NOT NULL", [id]))[0].n;
      const state = await mustState(id, users.dave!);
      t0 = performance.now();
      assert.deepEqual(await makePick(pool, id, users.dave!, state.pack![0]!.id, seeded(12)), { ok: true });
      const pickMs = performance.now() - t0;
      const after = (await q("SELECT count(*)::int AS n FROM draft_cards WHERE draft_id = $1 AND picked_by IS NOT NULL", [id]))[0].n;
      assert.ok(after - before >= 8, `one human pick released ${after - before - 1} bot picks`);

      t0 = performance.now();
      await mustState(id, users.dave!);
      const readMs = performance.now() - t0;

      // Every remaining pick, to be sure the budget holds at the end too.
      let slowest = 0;
      for (let i = 0; i < 200; i += 1) {
        const s = await mustState(id, users.dave!);
        if (!s.pack) break;
        const t1 = performance.now();
        await makePick(pool, id, users.dave!, s.pack[0]!.id, seeded(13 + i));
        slowest = Math.max(slowest, performance.now() - t1);
      }
      assert.equal((await q("SELECT status FROM drafts WHERE id = $1", [id]))[0].status, "done");

      t.diagnostic(
        `startDraft ${startMs.toFixed(1)}ms, first makePick ${pickMs.toFixed(1)}ms ` +
          `(+${after - before - 1} bot picks), loadSeatState ${readMs.toFixed(1)}ms, slowest pick ${slowest.toFixed(1)}ms`,
      );
      assert.ok(startMs < BUDGET_MS, `startDraft took ${startMs}ms`);
      assert.ok(pickMs < BUDGET_MS, `makePick took ${pickMs}ms`);
      assert.ok(readMs < BUDGET_MS, `loadSeatState took ${readMs}ms`);
      assert.ok(slowest < BUDGET_MS, `slowest makePick took ${slowest}ms`);
    });
  });
});
