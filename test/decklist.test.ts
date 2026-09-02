/**
 * Tests for the pasted-decklist importer.
 *
 *   npm test
 *
 * Pure tests always run. The database tests run only when TEST_DATABASE_URL is
 * set, e.g.
 *
 *   docker run -d --name nn-decklist-test -p 55437:5432 \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=ninetynine -e POSTGRES_USER=ninetynine \
 *     postgres:17-alpine
 *   # NOTE: the postgres image runs a temporary server during init and then
 *   # restarts, so `pg_isready` (and `docker exec psql`) can succeed before the
 *   # real server is listening and your migrations will silently do nothing.
 *   # Poll the PUBLISHED TCP PORT, which the init server never binds.
 *   for f in db/migrations/*.sql; do
 *     docker exec -i nn-decklist-test psql -v ON_ERROR_STOP=1 -U ninetynine -d ninetynine < "$f"
 *   done
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55437/ninetynine npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import pg from "pg";

// Types extensionless (erased before Node sees them), values via a variable
// specifier Node can resolve with type stripping. Same idiom as import.test.ts.
import type * as DecklistModule from "../lib/deck/decklist";
import type { DeckListLine } from "../lib/deck/decklist";

const decklistSpecifier = "../lib/deck/decklist.ts";
const { applyDeckList, parseDeckList, resolveDeckList } = (await import(
  decklistSpecifier
)) as typeof DecklistModule;

const REPO = path.resolve(import.meta.dirname, "..");
const MIRROR = path.join(REPO, "db/seed/example-mirror.json");

interface MirrorCard {
  id: string; oracle_id: string; name: string; set_code: string; set_name: string;
  collector_number: string; rarity: string; layout: string; type_line: string;
  oracle_text: string; color_identity: string[];
  legalities: Record<string, string>; prices: Record<string, string | null>; finishes: string[];
}
const mirror: MirrorCard[] = JSON.parse(readFileSync(MIRROR, "utf8"));
const byName = (n: string) => mirror.find((c) => c.name === n)!;

/* ================================================================== *
 * Pure — parsing
 * ================================================================== */

describe("parseDeckList", () => {
  it("reads a bare `N Name` line, which is what most pasted lists are", () => {
    const r = parseDeckList("1 Sol Ring");
    assert.equal(r.errors.length, 0);
    assert.deepEqual(
      { q: r.lines[0].quantity, n: r.lines[0].name, s: r.lines[0].setCode },
      { q: 1, n: "Sol Ring", s: null },
    );
  });

  it("accepts the `1x` form", () => {
    for (const text of ["1x Sol Ring", "1X Sol Ring", "1 x Sol Ring"]) {
      const r = parseDeckList(text);
      assert.equal(r.lines.length, 1, text);
      assert.equal(r.lines[0].name, "Sol Ring", text);
      assert.equal(r.lines[0].quantity, 1, text);
    }
  });

  it("keeps a ` // ` split name intact", () => {
    const r = parseDeckList("2 Makindi Stampede // Makindi Mesas (ZNR) 26");
    assert.equal(r.lines[0].name, "Makindi Stampede // Makindi Mesas");
    assert.equal(r.lines[0].setCode, "znr");
    assert.equal(r.lines[0].collectorNumber, "26");
  });

  it("keeps non-numeric collector numbers as strings", () => {
    // parseInt("pp319sb") is 319 — a different card entirely.
    const r = parseDeckList("1 Fellwar Stone (PTC) pp319sb");
    assert.equal(r.lines[0].collectorNumber, "pp319sb");
  });

  it("switches board on a section header and keeps it until the next", () => {
    const r = parseDeckList([
      "Commander", "1 Arahbo, Roar of the World",
      "Deck", "1 Sol Ring", "1 Counterspell",
      "Sideboard", "1 Negate",
      "Maybeboard", "1 Forest",
    ].join("\n"));
    assert.deepEqual(r.lines.map((l) => l.board),
      ["commander", "main", "main", "sideboard", "maybe"]);
  });

  it("honours MTGO-style SB:/CM: prefixes without changing the running board", () => {
    const r = parseDeckList(["1 Sol Ring", "SB: 1 Negate", "1 Forest"].join("\n"));
    assert.deepEqual(r.lines.map((l) => l.board), ["main", "sideboard", "main"]);
  });

  it("reads finish markers", () => {
    const r = parseDeckList(["1 A (X) 1 *F*", "1 B (X) 2 *E*", "1 C (X) 3"].join("\n"));
    assert.deepEqual(r.lines.map((l) => l.finish), ["foil", "etched", "nonfoil"]);
  });

  it("skips blanks and comments, and REPORTS junk rather than dropping it", () => {
    const r = parseDeckList(["", "# note", "// note", "1 Sol Ring", "nonsense", "0 Zero"].join("\n"));
    assert.equal(r.lines.length, 1);
    assert.equal(r.errors.length, 2);
    assert.deepEqual(r.errors.map((e) => e.raw), ["nonsense", "0 Zero"]);
    // Line numbers must point at the original text, not the filtered list.
    assert.deepEqual(r.errors.map((e) => e.lineNumber), [5, 6]);
  });

  it("totals physical cards, not lines", () => {
    const r = parseDeckList(["12 Forest", "1 Sol Ring"].join("\n"));
    assert.equal(r.lines.length, 2);
    assert.equal(r.totalCards, 13);
  });

  it("respects the caller's default board", () => {
    assert.equal(parseDeckList("1 Sol Ring", "sideboard").lines[0].board, "sideboard");
  });
});

/* ================================================================== *
 * Database
 * ================================================================== */

const DB_URL = process.env.TEST_DATABASE_URL;

describe("decklist resolution against postgres", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, () => {
  let pool: pg.Pool;
  let userId: number;
  let otherUserId: number;
  let deckId: number;

  const q = async <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> =>
    (await pool.query(text, params)).rows as T[];

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

    for (const c of mirror) {
      await q(
        `INSERT INTO scryfall_cards
           (id, oracle_id, name, set_code, set_name, collector_number, rarity, layout,
            type_line, oracle_text, color_identity, legalities, prices, finishes, released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13::jsonb,$14::text[],$15)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
         c.layout, c.type_line, c.oracle_text, c.color_identity,
         JSON.stringify(c.legalities), JSON.stringify(c.prices), c.finishes, "2020-01-01"],
      );
    }

    [{ id: userId }] = await q<{ id: number }>(
      "INSERT INTO users (name,email) VALUES ('dl','dl@example.invalid') RETURNING id",
    );
    [{ id: otherUserId }] = await q<{ id: number }>(
      "INSERT INTO users (name,email) VALUES ('other','other@example.invalid') RETURNING id",
    );
    [{ id: deckId }] = await q<{ id: number }>(
      "INSERT INTO decks (user_id,name,format) VALUES ($1,'dl deck','commander') RETURNING id",
      [userId],
    );
  });

  after(async () => {
    if (!pool) return;
    await q("DELETE FROM users WHERE email IN ('dl@example.invalid','other@example.invalid')");
    await q("DELETE FROM scryfall_cards WHERE id = ANY($1::uuid[])", [mirror.map((c) => c.id)]);
    await pool.end();
  });

  const line = (over: Partial<DeckListLine> = {}): DeckListLine => ({
    quantity: 1, name: "Sol Ring", setCode: null, collectorNumber: null,
    finish: "nonfoil", board: "main", lineNumber: 1, raw: "1 Sol Ring", ...over,
  });

  it("matches an exact printing by (set, collector) — including a non-numeric one", async () => {
    const fellwar = byName("Fellwar Stone");
    const r = await resolveDeckList(pool, [
      line({ name: "Fellwar Stone", setCode: fellwar.set_code, collectorNumber: fellwar.collector_number }),
    ], userId);
    assert.equal(r.resolved.length, 1);
    assert.equal(r.resolved[0].scryfallId, fellwar.id);
    assert.equal(r.resolved[0].via, "set_collector");
  });

  it("a WRONG collector number falls back to the name rather than losing the card", async () => {
    const r = await resolveDeckList(pool, [
      line({ name: "Fellwar Stone", setCode: "ptc", collectorNumber: "not-a-real-number" }),
    ], userId);
    assert.equal(r.unresolved.length, 0, "the card must not be dropped");
    assert.equal(r.resolved.length, 1);
    assert.equal(r.resolved[0].name, "Fellwar Stone");
  });

  it("reports an unknown name instead of silently dropping the line", async () => {
    const r = await resolveDeckList(pool, [line({ name: "Totally Made Up Card" })], userId);
    assert.equal(r.resolved.length, 0);
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].name, "Totally Made Up Card");
  });

  it("prefers a printing the user OWNS over the newest one", async () => {
    // The fixture holds two Sol Ring printings sharing an oracle_id. Own only
    // the one that is NOT picked by the default ordering, then prove the
    // preference flips to it.
    const rows = await q<{ id: string }>(
      "SELECT id::text AS id FROM scryfall_cards WHERE name='Sol Ring' ORDER BY set_code",
    );
    assert.ok(rows.length >= 2, "fixture must have two Sol Ring printings");

    const before = await resolveDeckList(pool, [line({ name: "Sol Ring" })], userId);
    assert.equal(before.resolved[0].via, "newest_printing");
    const notPicked = rows.find((r) => r.id !== before.resolved[0].scryfallId)!;

    const [{ id: colId }] = await q<{ id: number }>(
      "INSERT INTO collections (user_id,name) VALUES ($1,'owned') RETURNING id", [userId],
    );
    await q(
      "INSERT INTO collection_cards (collection_id,scryfall_id,quantity,finish) VALUES ($1,$2,2,'nonfoil')",
      [colId, notPicked.id],
    );

    const afterOwn = await resolveDeckList(pool, [line({ name: "Sol Ring" })], userId);
    assert.equal(afterOwn.resolved[0].scryfallId, notPicked.id, "must switch to the owned printing");
    assert.equal(afterOwn.resolved[0].via, "owned_printing");
    assert.equal(afterOwn.resolved[0].owned, 2);

    // Ownership is per user: someone else's collection must not steer the pick.
    const other = await resolveDeckList(pool, [line({ name: "Sol Ring" })], otherUserId);
    assert.equal(other.resolved[0].via, "newest_printing");
    assert.equal(other.resolved[0].owned, 0);

    await q("DELETE FROM collections WHERE id = $1", [colId]);
  });

  it("folds a printing named twice in one paste into a single row", async () => {
    // Two lines, one printing. Without folding the single INSERT fails with
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const forest = byName("Forest");
    const resolved = [
      { line: line({ name: "Forest", quantity: 4 }), scryfallId: forest.id, via: "newest_printing" as const, name: "Forest", owned: 0 },
      { line: line({ name: "Forest", quantity: 3, lineNumber: 2 }), scryfallId: forest.id, via: "newest_printing" as const, name: "Forest", owned: 0 },
    ];
    const applied = await applyDeckList(pool, deckId, resolved);
    assert.equal(applied.rows, 1, "one row, not two");
    assert.equal(applied.cards, 7, "4 + 3");

    const [row] = await q<{ quantity: number }>(
      "SELECT quantity FROM deck_cards WHERE deck_id=$1 AND scryfall_id=$2", [deckId, forest.id],
    );
    assert.equal(row.quantity, 7);
  });

  it("is additive on re-import, not destructive", async () => {
    const forest = byName("Forest");
    const resolved = [{
      line: line({ name: "Forest", quantity: 2 }), scryfallId: forest.id,
      via: "newest_printing" as const, name: "Forest", owned: 0,
    }];
    await applyDeckList(pool, deckId, resolved);
    const [row] = await q<{ quantity: number }>(
      "SELECT quantity FROM deck_cards WHERE deck_id=$1 AND scryfall_id=$2", [deckId, forest.id],
    );
    assert.equal(row.quantity, 9, "7 already there + 2 more");
  });

  it("keeps the same printing on different boards as separate rows", async () => {
    const sol = byName("Sol Ring");
    await applyDeckList(pool, deckId, [
      { line: line({ name: "Sol Ring", board: "main" }), scryfallId: sol.id, via: "newest_printing", name: "Sol Ring", owned: 0 },
      { line: line({ name: "Sol Ring", board: "sideboard" }), scryfallId: sol.id, via: "newest_printing", name: "Sol Ring", owned: 0 },
    ]);
    const rows = await q<{ board: string }>(
      "SELECT board FROM deck_cards WHERE deck_id=$1 AND scryfall_id=$2 ORDER BY board", [deckId, sol.id],
    );
    assert.deepEqual(rows.map((r) => r.board), ["main", "sideboard"]);
  });

  it("clamps at the quantity ceiling rather than violating it", async () => {
    const lotus = byName("Black Lotus");
    await applyDeckList(pool, deckId, [{
      line: line({ name: "Black Lotus", quantity: 900 }), scryfallId: lotus.id,
      via: "newest_printing", name: "Black Lotus", owned: 0,
    }]);
    await applyDeckList(pool, deckId, [{
      line: line({ name: "Black Lotus", quantity: 900 }), scryfallId: lotus.id,
      via: "newest_printing", name: "Black Lotus", owned: 0,
    }]);
    const [row] = await q<{ quantity: number }>(
      "SELECT quantity FROM deck_cards WHERE deck_id=$1 AND scryfall_id=$2", [deckId, lotus.id],
    );
    assert.equal(row.quantity, 999);
  });

  it("writes nothing for an empty resolution", async () => {
    const before = await q("SELECT id FROM deck_cards WHERE deck_id=$1", [deckId]);
    const applied = await applyDeckList(pool, deckId, []);
    assert.deepEqual(applied, { rows: 0, cards: 0 });
    const after = await q("SELECT id FROM deck_cards WHERE deck_id=$1", [deckId]);
    assert.equal(after.length, before.length);
  });
});
