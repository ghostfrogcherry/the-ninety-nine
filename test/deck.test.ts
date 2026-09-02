/**
 * Deck-building tests — `lib/deck/index.ts`.
 *
 *   npm test
 *
 * The pure tests always run. The database tests run only when
 * TEST_DATABASE_URL is set, e.g.
 *
 *   docker run -d --name nn-deck-test -p 55436:5432 \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=ninetynine -e POSTGRES_USER=ninetynine \
 *     postgres:17-alpine
 *   # the image runs a TEMPORARY server during init and then restarts, so
 *   # pg_isready can pass before the real server exists. Poll a real query:
 *   until docker exec nn-deck-test psql -U ninetynine -d ninetynine -c 'SELECT 1'; do sleep 1; done
 *   for f in db/migrations/*.sql; do
 *     docker exec -i nn-deck-test psql -v ON_ERROR_STOP=1 -U ninetynine -d ninetynine < "$f"
 *   done
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55436/ninetynine \
 *     node --experimental-strip-types --test test/deck.test.ts
 *
 * A DEDICATED variable, not DATABASE_URL: these tests insert placeholder rows
 * into `scryfall_cards` and must never be able to do that to a real instance by
 * inheriting the app's environment. Same rule as test/import.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import pg from "pg";

/**
 * Types come from an extensionless import (erased at runtime, and resolved fine
 * by moduleResolution "bundler"); the values come from a dynamic import whose
 * specifier is a variable, which TypeScript does not try to resolve. Full type
 * checking, and it still runs under Node's type stripping, which needs the
 * real `.ts` extension. Same idiom as test/import.test.ts.
 */
import type * as DeckModule from "../lib/deck";
import type { Queryable } from "../lib/deck";
import type { DeckBoard } from "../lib/commander";

const deckSpecifier = "../lib/deck/index.ts";

const {
  BOARD_LABELS,
  DECK_BOARDS,
  DECK_FINISHES,
  DECK_FORMATS,
  MAX_QUANTITY,
  SEARCH_SCOPES,
  addDeckCard,
  createDeck,
  loadDeckContents,
  loadOwnedDeck,
  moveDeckCard,
  parseAddQuantity,
  parseBoard,
  parseDeckName,
  parseFinish,
  parseFormat,
  parseId,
  parseQuantity,
  parseScope,
  parseScryfallId,
  removeDeckCard,
  searchMirror,
  setDeckCardQuantity,
  toDeckEntries,
  touchDeck,
} = (await import(deckSpecifier)) as typeof DeckModule;

const REPO = path.resolve(import.meta.dirname, "..");
// Synthetic mirror fixture. Deliberately contains a legendary G/W creature
// (Arahbo), a banned card (Black Lotus), an off-identity card (Counterspell),
// a basic land, Rat Colony ("any number"), Seven Dwarves (capped at seven), and
// TWO printings of Sol Ring sharing one oracle_id.
const MIRROR_JSON = path.join(REPO, "db/seed/example-mirror.json");

interface MirrorCard {
  id: string;
  oracle_id: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  layout: string;
  type_line: string | null;
  oracle_text: string | null;
  color_identity: string[];
  legalities: Record<string, string>;
  prices: Record<string, string | null>;
  finishes: string[];
  cmc?: number | null;
  image_uris?: Record<string, string> | null;
  card_faces?: unknown;
}

const mirror: MirrorCard[] = JSON.parse(readFileSync(MIRROR_JSON, "utf8"));

/** Look the fixture up by name rather than hardcoding UUIDs, as import.test.ts does. */
function card(name: string, setCode?: string): MirrorCard {
  const hit = mirror.find((c) => c.name === name && (!setCode || c.set_code === setCode));
  assert.ok(hit, `fixture is missing ${name}${setCode ? ` (${setCode})` : ""}`);
  return hit;
}

/** The two-printings-one-oracle case: same card, different `id`. */
const SOL_C19 = card("Sol Ring", "c19");
const SOL_LCC = card("Sol Ring", "lcc");
const FOREST = card("Forest");
const ARAHBO = card("Arahbo, Roar of the World");
const RAT = card("Rat Colony");
const LOTUS = card("Black Lotus");
const COUNTERSPELL = card("Counterspell");

/* ================================================================== *
 * Pure — input parsing
 *
 * These sit directly behind form posts and JSON bodies, so they are the
 * trust boundary. Each must REJECT rather than coerce.
 * ================================================================== */

/** Values a hand-edited form or a crafted JSON body can actually deliver. */
const GARBAGE: unknown[] = [
  null,
  undefined,
  "",
  "   ",
  0,
  1,
  true,
  false,
  {},
  [],
  ["main"],
  new Date(),
  Symbol("main"),
  () => "main",
  NaN,
];

describe("parseBoard", () => {
  it("accepts exactly the four boards in 0004_decks.sql", () => {
    for (const b of DECK_BOARDS) assert.equal(parseBoard(b), b);
    assert.deepEqual([...DECK_BOARDS], ["main", "commander", "sideboard", "maybe"]);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseBoard("  main  "), "main");
    assert.equal(parseBoard("\tsideboard\n"), "sideboard");
  });

  it("rejects garbage rather than passing it through", () => {
    for (const g of GARBAGE) assert.equal(parseBoard(g), null, `accepted ${String(g)}`);
  });

  it("rejects near-misses, case variants and injection attempts", () => {
    for (const bad of [
      "Main",
      "MAIN",
      "mainboard",
      "side",
      "deck",
      "main'; DROP TABLE deck_cards; --",
      "main,commander",
      "main main",
      // Prototype keys: `includes` on an array is immune, but a Record lookup
      // would not be, so pin it.
      "__proto__",
      "constructor",
      "toString",
    ]) {
      assert.equal(parseBoard(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("has a label for every board (the select cannot render a hole)", () => {
    for (const b of DECK_BOARDS) assert.equal(typeof BOARD_LABELS[b], "string");
    assert.equal(Object.keys(BOARD_LABELS).length, DECK_BOARDS.length);
  });
});

describe("parseFinish", () => {
  it("accepts the three offered finishes", () => {
    for (const f of DECK_FINISHES) assert.equal(parseFinish(f), f);
    assert.deepEqual([...DECK_FINISHES], ["nonfoil", "foil", "etched"]);
  });

  it("rejects garbage", () => {
    for (const g of GARBAGE) assert.equal(parseFinish(g), null, `accepted ${String(g)}`);
  });

  it("rejects finishes the editor does not offer", () => {
    // `deck_cards.finish` is bare TEXT with no CHECK (0004_decks.sql), so this
    // list is the ONLY thing keeping the column tidy. "glossy" is a real
    // Scryfall finish and still must not get in.
    for (const bad of ["glossy", "Foil", "FOIL", "nonfoil ".repeat(3), "foil;", "etched2"]) {
      assert.equal(parseFinish(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("parseFormat", () => {
  it("accepts every offered format, case-insensitively", () => {
    for (const f of DECK_FORMATS) {
      assert.equal(parseFormat(f), f);
      assert.equal(parseFormat(f.toUpperCase()), f);
      assert.equal(parseFormat(`  ${f}  `), f);
    }
  });

  it("rejects garbage and unlisted formats", () => {
    for (const g of GARBAGE) assert.equal(parseFormat(g), null, `accepted ${String(g)}`);
    for (const bad of ["commanderr", "edh", "cube", "commander,standard", "'commander'"]) {
      assert.equal(parseFormat(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("parseScope", () => {
  it("is total — never null, because a bad scope must not 400 a search", () => {
    assert.equal(parseScope("all"), "all");
    assert.equal(parseScope("owned"), "owned");
    assert.deepEqual([...SEARCH_SCOPES], ["owned", "all"]);
  });

  it("falls back to owned for anything else (this is a collection app)", () => {
    for (const g of [...GARBAGE, "ALL", "All", "everything", "owned "]) {
      assert.equal(parseScope(g), "owned", `did not default: ${String(g)}`);
    }
  });
});

describe("parseDeckName", () => {
  it("accepts a trimmed non-empty name", () => {
    assert.equal(parseDeckName("  Arahbo Cats  "), "Arahbo Cats");
  });

  it("rejects empty, whitespace-only and non-strings", () => {
    for (const g of GARBAGE) assert.equal(parseDeckName(g), null, `accepted ${String(g)}`);
    assert.equal(parseDeckName("\t\n  "), null);
  });

  it("truncates at 120 rather than rejecting a long name", () => {
    assert.equal(parseDeckName("x".repeat(120))?.length, 120);
    assert.equal(parseDeckName("x".repeat(121))?.length, 120);
    assert.equal(parseDeckName("x".repeat(10_000))?.length, 120);
  });
});

describe("parseQuantity (edit)", () => {
  it("accepts 0..MAX_QUANTITY — 0 is legal here and means delete the row", () => {
    assert.equal(parseQuantity("0"), 0);
    assert.equal(parseQuantity(0), 0);
    assert.equal(parseQuantity("1"), 1);
    assert.equal(parseQuantity(MAX_QUANTITY), MAX_QUANTITY);
    assert.equal(parseQuantity(String(MAX_QUANTITY)), MAX_QUANTITY);
    assert.equal(parseQuantity("  7  "), 7);
  });

  it("rejects out-of-range rather than clamping", () => {
    assert.equal(parseQuantity(MAX_QUANTITY + 1), null);
    assert.equal(parseQuantity("1000"), null);
    assert.equal(parseQuantity("99999"), null);
    assert.equal(parseQuantity(Number.MAX_SAFE_INTEGER), null);
  });

  it("rejects negatives, fractions, exponents and junk", () => {
    for (const bad of [
      "-1", -1, "-0", "1.5", 1.5, "1e3", 1e3, "0x10", "١٢", "1 2", "12abc", "abc",
      " ", "+1", "Infinity", Infinity, -Infinity, NaN, true, null, undefined, {}, [],
    ]) {
      assert.equal(parseQuantity(bad), null, `accepted ${String(bad)}`);
    }
  });

  it("accepts leading zeros (documented, not a hole — value is still bounded)", () => {
    assert.equal(parseQuantity("007"), 7);
    assert.equal(parseQuantity("0000000999"), 999);
    assert.equal(parseQuantity("0000001000"), null);
  });
});

describe("parseAddQuantity (add)", () => {
  it("is parseQuantity minus zero — adding 0 copies is not a thing", () => {
    assert.equal(parseAddQuantity("0"), null);
    assert.equal(parseAddQuantity(0), null);
    assert.equal(parseAddQuantity("1"), 1);
    assert.equal(parseAddQuantity(MAX_QUANTITY), MAX_QUANTITY);
    assert.equal(parseAddQuantity(MAX_QUANTITY + 1), null);
    assert.equal(parseAddQuantity("-1"), null);
  });

  it("rejects everything parseQuantity rejects", () => {
    for (const g of GARBAGE) {
      if (g === 1) continue; // 1 is a legal quantity
      assert.equal(parseAddQuantity(g), null, `accepted ${String(g)}`);
    }
  });
});

describe("parseId", () => {
  it("accepts a positive integer as string or number", () => {
    assert.equal(parseId("1"), 1);
    assert.equal(parseId(1), 1);
    assert.equal(parseId("  42  "), 42);
    assert.equal(parseId(2_147_483_647), 2_147_483_647); // int4 max, a real SERIAL
  });

  it("rejects 0, negatives, fractions and junk", () => {
    for (const bad of [
      "0", 0, "-1", -1, "1.0", 1.5, "1e3", "abc", "", "  ", "1;--", null, undefined,
      true, {}, [], NaN, Infinity,
    ]) {
      assert.equal(parseId(bad), null, `accepted ${String(bad)}`);
    }
  });

  it("rejects integers too large to be a JS-safe integer", () => {
    assert.equal(parseId("9007199254740993"), null);
    assert.equal(parseId("9".repeat(30)), null);
  });

  /**
   * Regression guard. This WAS a live bug.
   *
   * `decks.id` / `deck_cards.id` are SERIAL, i.e. int4, max 2147483647. parseId
   * bounded only by Number.isSafeInteger, so everything from 2^31 to 2^53-1
   * reached `WHERE id = $1` against an integer column. `pg` infers the bind
   * type from that column, so it did not match zero rows — Postgres raised
   * 22003 and /decks/2147483648 returned 500 while /decks/999999999 correctly
   * returned 404. Fixed by bounding at MAX_INT4.
   */
  it("rejects ids beyond int4, which SERIAL cannot hold", () => {
    assert.equal(parseId("2147483647"), 2147483647, "int4 max is still valid");
    assert.equal(parseId("2147483648"), null, "one past int4 max must be rejected");
    assert.equal(parseId(Number.MAX_SAFE_INTEGER), null);
  });
});

describe("parseScryfallId", () => {
  it("accepts a real fixture UUID and normalises case", () => {
    assert.equal(parseScryfallId(SOL_C19.id), SOL_C19.id);
    assert.equal(parseScryfallId(SOL_C19.id.toUpperCase()), SOL_C19.id);
    assert.equal(parseScryfallId(`  ${SOL_C19.id}  `), SOL_C19.id);
  });

  it("rejects garbage", () => {
    for (const g of GARBAGE) assert.equal(parseScryfallId(g), null, `accepted ${String(g)}`);
  });

  it("rejects near-UUIDs Postgres would otherwise take or choke on", () => {
    const u = SOL_C19.id;
    for (const bad of [
      u.replace(/-/g, ""), // Postgres accepts this form; the app does not
      `{${u}}`, // ditto, braced
      u.slice(0, -1), // one char short
      `${u}0`, // one char long
      u.replace("a", "g"), // non-hex
      `${u}'; DROP TABLE deck_cards; --`,
      "00000000-0000-0000-0000-00000000000z",
      "not-a-uuid-at-all",
    ]) {
      assert.equal(parseScryfallId(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("accepts the all-zero UUID (valid hex; nothing in the mirror matches it)", () => {
    assert.equal(
      parseScryfallId("00000000-0000-0000-0000-000000000000"),
      "00000000-0000-0000-0000-000000000000",
    );
  });
});

/* ================================================================== *
 * Pure — searchMirror's pre-query logic
 *
 * A Queryable is a structural interface, so a stub proves the parts that
 * never reach SQL without needing a database.
 * ================================================================== */

function stubDb(): Queryable & { calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      return { rows: [] };
    },
  };
}

describe("searchMirror before it reaches SQL", () => {
  it("short-circuits an empty query without touching the database", async () => {
    const db = stubDb();
    for (const q of ["", "   ", "\t\n"]) {
      assert.deepEqual(await searchMirror(db, { userId: 1, q, scope: "all" }), []);
    }
    assert.equal(db.calls.length, 0, "an empty search must not run a seq scan");
  });

  it("clamps the limit into 1..100", async () => {
    const cases: [number | undefined, number][] = [
      [undefined, 25],
      [0, 1],
      [-5, 1],
      [1, 1],
      [100, 100],
      [1000, 100],
      [Number.MAX_SAFE_INTEGER, 100],
    ];
    for (const [limit, expected] of cases) {
      const db = stubDb();
      await searchMirror(db, { userId: 1, q: "Sol Ring", scope: "all", limit });
      assert.equal(db.calls[0].values[2], expected, `limit ${String(limit)}`);
    }
  });

  it("passes the user id and trimmed term as bind parameters, never inlined", async () => {
    const db = stubDb();
    await searchMirror(db, { userId: 7, q: "  Sol Ring'; DROP TABLE decks; --  ", scope: "owned" });
    const { text, values } = db.calls[0];
    assert.equal(values[0], 7);
    assert.equal(values[1], "Sol Ring'; DROP TABLE decks; --");
    assert.ok(!text.includes("DROP TABLE"), "search term must not be interpolated into SQL");
  });

  it("only emits the EXISTS scope filter for scope owned", async () => {
    const owned = stubDb();
    await searchMirror(owned, { userId: 1, q: "Sol Ring", scope: "owned" });
    assert.match(owned.calls[0].text, /EXISTS \(SELECT 1 FROM collection_cards/);

    const all = stubDb();
    await searchMirror(all, { userId: 1, q: "Sol Ring", scope: "all" });
    assert.doesNotMatch(all.calls[0].text, /EXISTS \(SELECT 1 FROM collection_cards/);
  });
});

describe("toDeckEntries", () => {
  it("carries board and quantity through to the validator's shape", () => {
    const rows = [
      { id: "a", oracle_id: "o", name: "Sol Ring", row_id: 1, quantity: 2, board: "main" },
      { id: "b", oracle_id: "p", name: "Arahbo", row_id: 2, quantity: 1, board: "commander" },
    ] as unknown as Parameters<typeof toDeckEntries>[0];
    assert.deepEqual(
      toDeckEntries(rows).map((e) => [e.card.name, e.quantity, e.board]),
      [
        ["Sol Ring", 2, "main"],
        ["Arahbo", 1, "commander"],
      ],
    );
  });
});

/* ================================================================== *
 * Database
 *
 * Everything below asserts a decision that is easy to regress silently:
 * upsert-not-insert, delete-not-quantity-zero, deck_id scoping, the
 * merge-on-move, and the two counting queries (unresolved / owned).
 * ================================================================== */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Extra mirror rows, on top of db/seed/example-mirror.json.
 *
 * Deterministic fake UUIDs in an obviously-synthetic namespace, inserted
 * ON CONFLICT DO NOTHING so a real mirror always wins — same approach as
 * test/import.test.ts. They exist because the fixture has no name that is a
 * strict substring of another (so exact-vs-prefix ranking is unprovable with it
 * alone) and no card_faces (so the multi-face image fallback is unprovable).
 */
const EXTRA_MIRROR: MirrorCard[] = [
  {
    id: "00000000-0000-4000-8000-0000000000f1",
    oracle_id: "00000000-0000-4000-8000-0000000000e1",
    name: "Forest Bear", // prefix match for "Forest", not exact
    set_code: "tsp", set_name: "Time Spiral", collector_number: "201",
    rarity: "common", layout: "normal", type_line: "Creature — Bear",
    oracle_text: "", color_identity: ["G"], legalities: { commander: "legal" },
    prices: { usd: "0.15", usd_foil: "0.60" }, finishes: ["nonfoil", "foil"],
    cmc: 3,
    image_uris: { normal: "https://example.invalid/forest-bear.jpg" },
    card_faces: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000f2",
    oracle_id: "00000000-0000-4000-8000-0000000000e2",
    name: "Snow-Covered Forest", // substring match only: neither exact nor prefix
    set_code: "khm", set_name: "Kaldheim", collector_number: "285",
    rarity: "common", layout: "normal", type_line: "Basic Snow Land — Forest",
    oracle_text: "", color_identity: ["G"], legalities: { commander: "legal" },
    prices: { usd: "0.99", usd_foil: null }, finishes: ["nonfoil", "foil"],
    cmc: 0, image_uris: null, card_faces: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000f3",
    oracle_id: "00000000-0000-4000-8000-0000000000e3",
    // Multi-face: art lives on the front face, top-level image_uris is NULL.
    name: "Nine Ninety // Ninety Nine",
    set_code: "znr", set_name: "Zendikar Rising", collector_number: "999",
    rarity: "rare", layout: "modal_dfc", type_line: "Sorcery // Land",
    oracle_text: "", color_identity: ["W"], legalities: { commander: "legal" },
    prices: { usd: "1.00", usd_foil: "2.00", usd_etched: "3.00" },
    finishes: ["nonfoil", "foil", "etched"],
    cmc: 5,
    image_uris: null,
    card_faces: [{ name: "Nine Ninety", image_uris: { normal: "https://example.invalid/front.jpg" } }],
  },
];

const FOREST_BEAR = EXTRA_MIRROR[0];
const SNOW_FOREST = EXTRA_MIRROR[1];
const TWO_FACED = EXTRA_MIRROR[2];

/** A UUID that is deliberately NOT in the mirror. There is no FK (0004). */
const ABSENT_ID = "deadbeef-0000-4000-8000-000000000099";

describe("deck domain against postgres", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, () => {
  let pool: pg.Pool;
  let userId: number;
  let otherUserId: number;
  let colA: number;
  let colB: number;
  let otherCol: number;
  const stamp = `${process.pid}-${Date.now()}`;

  async function newDeck(name: string, owner?: number): Promise<number> {
    const deck = await createDeck(pool, owner ?? userId, { name, format: "commander" });
    return deck.id;
  }

  async function own(collectionId: number, scryfallId: string, quantity: number, finish = "nonfoil") {
    await pool.query(
      `INSERT INTO collection_cards (collection_id, scryfall_id, quantity, finish)
       VALUES ($1, $2, $3, $4)`,
      [collectionId, scryfallId, quantity, finish],
    );
  }

  async function rawRows(deckId: number) {
    const { rows } = await pool.query(
      `SELECT id, scryfall_id::text AS scryfall_id, quantity, board, finish
         FROM deck_cards WHERE deck_id = $1 ORDER BY id`,
      [deckId],
    );
    return rows as { id: number; scryfall_id: string; quantity: number; board: string; finish: string }[];
  }

  /** Park updated_at in the past so "did touchDeck run?" is a strict question. */
  async function pinUpdatedAt(deckId: number) {
    await pool.query("UPDATE decks SET updated_at = TIMESTAMPTZ '2000-01-01' WHERE id = $1", [deckId]);
  }
  async function updatedAt(deckId: number): Promise<string> {
    const { rows } = await pool.query("SELECT updated_at::text AS t FROM decks WHERE id = $1", [deckId]);
    return rows[0].t;
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

    for (const c of [...mirror, ...EXTRA_MIRROR]) {
      await pool.query(
        `INSERT INTO scryfall_cards
           (id, oracle_id, name, set_code, set_name, collector_number, rarity, layout,
            type_line, oracle_text, color_identity, legalities, prices, finishes,
            cmc, image_uris, card_faces)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13::jsonb,
                 $14::text[],$15,$16::jsonb,$17::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number,
          c.rarity, c.layout, c.type_line, c.oracle_text, c.color_identity,
          JSON.stringify(c.legalities), JSON.stringify(c.prices), c.finishes,
          c.cmc ?? null,
          c.image_uris ? JSON.stringify(c.image_uris) : null,
          c.card_faces ? JSON.stringify(c.card_faces) : null,
        ],
      );
    }

    const u = await pool.query("INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id", [
      "deck test",
      `deck-test-${stamp}@ninetynine.invalid`,
    ]);
    userId = u.rows[0].id;
    const o = await pool.query("INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id", [
      "deck test other",
      `deck-test-other-${stamp}@ninetynine.invalid`,
    ]);
    otherUserId = o.rows[0].id;

    const mk = async (uid: number, name: string) =>
      (await pool.query("INSERT INTO collections (user_id, name) VALUES ($1,$2) RETURNING id", [uid, name]))
        .rows[0].id as number;
    colA = await mk(userId, "Binder A");
    colB = await mk(userId, "Binder B");
    otherCol = await mk(otherUserId, "Someone else's binder");

    // THE owned-count setup: one printing, two of the SAME user's collections.
    // 2 + 3 = 5 copies, and it must read as 5 on ONE row, not 5 twice and not 10.
    await own(colA, SOL_C19.id, 2);
    await own(colB, SOL_C19.id, 3);
    // A foil elsewhere, to prove loadDeckContents' owned is finish-sensitive.
    await own(colA, SOL_C19.id, 4, "foil");
    // Another user holds it too. Must never leak into this user's counts.
    await own(otherCol, SOL_C19.id, 99);
    await own(otherCol, SOL_LCC.id, 7);

    // Ranking fixture, all owned so the scope filter pins the result set to
    // exactly these three regardless of what else the mirror holds.
    await own(colA, FOREST.id, 1);
    await own(colA, FOREST_BEAR.id, 1);
    await own(colA, SNOW_FOREST.id, 1);
  });

  after(async () => {
    if (!pool) return;
    // Cascades to collections -> collection_cards and decks -> deck_cards.
    await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [[userId, otherUserId]]);
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Schema assumptions the module's design rests on
   * ---------------------------------------------------------------- */

  describe("the constraints the write path is written around", () => {
    it("(deck_id, scryfall_id, board, finish) really is unique — 23505 on a raw duplicate", async () => {
      const deckId = await newDeck("unique probe");
      await pool.query(
        "INSERT INTO deck_cards (deck_id, scryfall_id, quantity, board, finish) VALUES ($1,$2,1,'main','nonfoil')",
        [deckId, SOL_C19.id],
      );
      await assert.rejects(
        () =>
          pool.query(
            "INSERT INTO deck_cards (deck_id, scryfall_id, quantity, board, finish) VALUES ($1,$2,1,'main','nonfoil')",
            [deckId, SOL_C19.id],
          ),
        (e: { code?: string }) => e.code === "23505",
        "if this stops throwing the upsert tests below prove nothing",
      );
    });

    it("quantity really is CHECK (> 0) — 23514 on a raw zero", async () => {
      const deckId = await newDeck("check probe");
      await assert.rejects(
        () =>
          pool.query(
            "INSERT INTO deck_cards (deck_id, scryfall_id, quantity) VALUES ($1,$2,0)",
            [deckId, SOL_C19.id],
          ),
        (e: { code?: string }) => e.code === "23514",
        "if quantity may be 0 then routing 0 to DELETE is no longer load-bearing",
      );
    });

    it("there is NO foreign key from deck_cards.scryfall_id into the mirror", async () => {
      const deckId = await newDeck("no fk probe");
      // Would be a 23503 if a FK existed. It must not.
      const { rows } = await pool.query(
        "INSERT INTO deck_cards (deck_id, scryfall_id, quantity) VALUES ($1,$2,1) RETURNING id",
        [deckId, ABSENT_ID],
      );
      assert.equal(rows.length, 1);
    });
  });

  /* ---------------------------------------------------------------- *
   * createDeck / loadOwnedDeck
   * ---------------------------------------------------------------- */

  describe("loadOwnedDeck", () => {
    it("reads back a deck the user owns", async () => {
      const created = await createDeck(pool, userId, { name: "Arahbo Cats", format: "commander" });
      const loaded = await loadOwnedDeck(pool, created.id, userId);
      assert.equal(loaded?.id, created.id);
      assert.equal(loaded?.name, "Arahbo Cats");
      assert.equal(loaded?.format, "commander");
      assert.equal(loaded?.is_public, false);
      assert.equal(loaded?.public_slug, null);
    });

    it("returns null for another user's deck — absent, never forbidden", async () => {
      const theirs = await newDeck("not yours", otherUserId);
      assert.equal(await loadOwnedDeck(pool, theirs, userId), null);
      // ... and the deck genuinely exists, so null is scoping and not absence.
      assert.equal((await loadOwnedDeck(pool, theirs, otherUserId))?.id, theirs);
    });

    it("returns null for a deck id that does not exist", async () => {
      assert.equal(await loadOwnedDeck(pool, 2_147_483_646, userId), null);
    });

    /**
     * The DB half of the int4 regression guard.
     *
     * parseId now refuses out-of-int4 ids, so they never reach a query. This
     * test pins BOTH halves: the parser rejects, and — if the bound is ever
     * removed — Postgres really does raise 22003 rather than quietly matching
     * nothing, which is what made it a 500 instead of a 404.
     */
    it("out-of-int4 ids are rejected before they can reach Postgres", async () => {
      assert.equal(parseId("2147483648"), null, "the parse layer must stop it");

      // Prove the danger is real, so the guard above cannot be dismissed as
      // paranoia: bypass the parser and Postgres rejects the bind outright.
      await assert.rejects(
        () => loadOwnedDeck(pool, 2147483648, userId),
        (e: { code?: string }) => e.code === "22003",
        "bypassing parseId must still hit 22003 — this is why the bound exists",
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * addDeckCard — THE upsert
   * ---------------------------------------------------------------- */

  describe("addDeckCard", () => {
    it("is an UPSERT: adding a card already on that board BUMPS quantity, never 23505", async () => {
      const deckId = await newDeck("upsert");
      const first = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 1, board: "main", finish: "nonfoil",
      });
      assert.equal(first.quantity, 1);

      // Clicking "+ Add" again is additive by design, not an error and not a no-op.
      const second = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 2, board: "main", finish: "nonfoil",
      });
      assert.equal(second.quantity, 3, "1 then +2 must be 3");
      assert.equal(second.id, first.id, "the upsert must reuse the row, not make a second one");

      const rows = await rawRows(deckId);
      assert.equal(rows.length, 1, "one row, not two");
      assert.equal(rows[0].quantity, 3);
    });

    it("caps at MAX_QUANTITY rather than exceeding it", async () => {
      const deckId = await newDeck("cap");
      await addDeckCard(pool, deckId, {
        scryfallId: RAT.id, quantity: MAX_QUANTITY, board: "main", finish: "nonfoil",
      });
      const bumped = await addDeckCard(pool, deckId, {
        scryfallId: RAT.id, quantity: 5, board: "main", finish: "nonfoil",
      });
      assert.equal(bumped.quantity, MAX_QUANTITY, "LEAST() must clamp, not overflow the view");

      // And repeatedly, so the clamp is not a one-shot.
      const again = await addDeckCard(pool, deckId, {
        scryfallId: RAT.id, quantity: MAX_QUANTITY, board: "main", finish: "nonfoil",
      });
      assert.equal(again.quantity, MAX_QUANTITY);
    });

    it("keys on all four columns: board and finish each split the row", async () => {
      const deckId = await newDeck("four columns");
      for (const [board, finish] of [
        ["main", "nonfoil"], ["main", "foil"], ["maybe", "nonfoil"], ["sideboard", "etched"],
      ] as [DeckBoard, string][]) {
        await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board, finish });
      }
      const rows = await rawRows(deckId);
      assert.equal(rows.length, 4, "one printing, four (board, finish) slots, four rows");
      assert.deepEqual(
        rows.map((r) => `${r.board}/${r.finish}`).sort(),
        ["main/foil", "main/nonfoil", "maybe/nonfoil", "sideboard/etched"],
      );
    });

    it("treats two printings of one oracle_id as separate rows", async () => {
      const deckId = await newDeck("two printings");
      assert.equal(SOL_C19.oracle_id, SOL_LCC.oracle_id, "fixture must share the oracle_id");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: SOL_LCC.id, quantity: 1, board: "main", finish: "nonfoil" });
      // Singleton is an oracle_id rule and lives in lib/commander/, NOT here.
      assert.equal((await rawRows(deckId)).length, 2);
    });

    it("stores a banned card, an off-identity card and an unmirrored id without complaint", async () => {
      const deckId = await newDeck("no validation on write");
      assert.equal(LOTUS.legalities.commander, "banned");
      assert.deepEqual(COUNTERSPELL.color_identity, ["U"]);
      assert.deepEqual(ARAHBO.color_identity, ["G", "W"]);

      await addDeckCard(pool, deckId, { scryfallId: ARAHBO.id, quantity: 1, board: "commander", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: LOTUS.id, quantity: 1, board: "main", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: COUNTERSPELL.id, quantity: 1, board: "main", finish: "nonfoil" });
      const absent = await addDeckCard(pool, deckId, {
        scryfallId: ABSENT_ID, quantity: 1, board: "main", finish: "nonfoil",
      });
      assert.equal(absent.scryfall_id, ABSENT_ID);
      assert.equal((await rawRows(deckId)).length, 4, "a builder that refuses a WIP save is useless");
    });

    it("bumps decks.updated_at", async () => {
      const deckId = await newDeck("touch on add");
      await pinUpdatedAt(deckId);
      await addDeckCard(pool, deckId, { scryfallId: FOREST.id, quantity: 1, board: "main", finish: "nonfoil" });
      assert.notEqual(await updatedAt(deckId), "2000-01-01 00:00:00+00");
    });
  });

  /* ---------------------------------------------------------------- *
   * setDeckCardQuantity
   * ---------------------------------------------------------------- */

  describe("setDeckCardQuantity", () => {
    it("sets absolutely, unlike addDeckCard which accumulates", async () => {
      const deckId = await newDeck("absolute");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 5, board: "main", finish: "nonfoil",
      });
      const set = await setDeckCardQuantity(pool, deckId, row.id, 2);
      assert.equal(set?.quantity, 2, "2 means 2, not 7");
      assert.equal(set?.id, row.id);
    });

    it("quantity 0 DELETEs the row and returns null — never a CHECK violation", async () => {
      const deckId = await newDeck("zero deletes");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 3, board: "main", finish: "nonfoil",
      });
      const result = await setDeckCardQuantity(pool, deckId, row.id, 0);
      assert.equal(result, null);
      assert.deepEqual(await rawRows(deckId), [], "the row must be gone, not sitting at 0");
    });

    it("a negative quantity takes the same DELETE route", async () => {
      const deckId = await newDeck("negative deletes");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 3, board: "main", finish: "nonfoil",
      });
      assert.equal(await setDeckCardQuantity(pool, deckId, row.id, -5), null);
      assert.deepEqual(await rawRows(deckId), []);
    });

    it("changes nothing and returns null for a row belonging to ANOTHER deck", async () => {
      const mine = await newDeck("mine");
      const theirs = await newDeck("theirs", otherUserId);
      const theirRow = await addDeckCard(pool, theirs, {
        scryfallId: FOREST.id, quantity: 4, board: "main", finish: "nonfoil",
      });
      await pinUpdatedAt(mine);

      // The row id is real and guessable; only the deck_id scoping stops it.
      assert.equal(await setDeckCardQuantity(pool, mine, theirRow.id, 1), null);

      const after = await rawRows(theirs);
      assert.equal(after.length, 1);
      assert.equal(after[0].quantity, 4, "someone else's quantity must not move");
      assert.equal(await updatedAt(mine), "2000-01-01 00:00:00+00", "a miss must not touch the deck");
    });

    it("returns null for a row id that does not exist at all", async () => {
      const deckId = await newDeck("missing row");
      assert.equal(await setDeckCardQuantity(pool, deckId, 2_147_483_646, 3), null);
    });

    it("does NOT clamp to MAX_QUANTITY — unlike addDeckCard (parse layer is the only bound)", async () => {
      const deckId = await newDeck("no clamp");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 1, board: "main", finish: "nonfoil",
      });
      const set = await setDeckCardQuantity(pool, deckId, row.id, MAX_QUANTITY + 1000);
      assert.equal(
        set?.quantity,
        MAX_QUANTITY + 1000,
        "if this now clamps, a LEAST() was added here — update the report's note",
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * removeDeckCard
   * ---------------------------------------------------------------- */

  describe("removeDeckCard", () => {
    it("deletes and reports true, then false the second time", async () => {
      const deckId = await newDeck("remove");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: FOREST.id, quantity: 2, board: "main", finish: "nonfoil",
      });
      assert.equal(await removeDeckCard(pool, deckId, row.id), true);
      assert.deepEqual(await rawRows(deckId), []);
      assert.equal(await removeDeckCard(pool, deckId, row.id), false);
    });

    it("returns false for another deck's row id and leaves it alone", async () => {
      const mine = await newDeck("mine 2");
      const theirs = await newDeck("theirs 2", otherUserId);
      const theirRow = await addDeckCard(pool, theirs, {
        scryfallId: FOREST.id, quantity: 2, board: "main", finish: "nonfoil",
      });
      await pinUpdatedAt(mine);
      assert.equal(await removeDeckCard(pool, mine, theirRow.id), false);
      assert.equal((await rawRows(theirs)).length, 1, "someone else's row must survive");
      assert.equal(await updatedAt(mine), "2000-01-01 00:00:00+00");
    });
  });

  /* ---------------------------------------------------------------- *
   * moveDeckCard
   * ---------------------------------------------------------------- */

  describe("moveDeckCard", () => {
    it("moves a row to an empty board", async () => {
      const deckId = await newDeck("plain move");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: ARAHBO.id, quantity: 1, board: "main", finish: "nonfoil",
      });
      const moved = await moveDeckCard(pool, deckId, row.id, "commander");
      assert.equal(moved?.board, "commander");
      assert.equal(moved?.quantity, 1);
      const rows = await rawRows(deckId);
      assert.equal(rows.length, 1, "never on both boards, never on neither");
      assert.equal(rows[0].board, "commander");
    });

    it("MERGES when the destination already holds that printing in that finish", async () => {
      const deckId = await newDeck("merge");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });
      const maybe = await addDeckCard(pool, deckId, {
        scryfallId: SOL_C19.id, quantity: 2, board: "maybe", finish: "nonfoil",
      });

      const moved = await moveDeckCard(pool, deckId, maybe.id, "main");
      assert.equal(moved?.board, "main");
      assert.equal(moved?.quantity, 3, "2 + 1 summed, not a 23505 from the unique index");

      const rows = await rawRows(deckId);
      assert.equal(rows.length, 1, "one row survives the merge");
      assert.equal(rows[0].board, "main");
      assert.equal(rows[0].quantity, 3);
    });

    it("caps the merged quantity at MAX_QUANTITY", async () => {
      const deckId = await newDeck("merge cap");
      await addDeckCard(pool, deckId, {
        scryfallId: RAT.id, quantity: MAX_QUANTITY, board: "main", finish: "nonfoil",
      });
      const maybe = await addDeckCard(pool, deckId, {
        scryfallId: RAT.id, quantity: 10, board: "maybe", finish: "nonfoil",
      });
      const moved = await moveDeckCard(pool, deckId, maybe.id, "main");
      assert.equal(moved?.quantity, MAX_QUANTITY);
      assert.equal((await rawRows(deckId)).length, 1);
    });

    /**
     * The `board <> $3` clause is what makes this a no-op.
     *
     * Remove it and Postgres 17 does NOT raise "cannot affect row a second
     * time": the CTE's DELETE takes the row out and the INSERT lands a BRAND NEW
     * row (verified by hand against 17.11 — the id went 1 -> 2). So a no-op move
     * would silently churn `deck_cards.id`, which is the handle the editor posts
     * back for every later edit, and reset `added_at`.
     *
     * This test therefore pins all three observable things at once: the null
     * return, the stable row id, and the untouched quantity. Deleting the clause
     * fails the first two.
     */
    it("moving to the SAME board is a genuine no-op returning null", async () => {
      const deckId = await newDeck("same board no-op");
      const row = await addDeckCard(pool, deckId, {
        scryfallId: SOL_C19.id, quantity: 2, board: "main", finish: "nonfoil",
      });
      const before = await rawRows(deckId);
      await pinUpdatedAt(deckId);

      const result = await moveDeckCard(pool, deckId, row.id, "main");

      assert.equal(result, null, "a no-op move must return null, not a re-inserted row");
      const after = await rawRows(deckId);
      assert.equal(after.length, 1);
      assert.equal(after[0].id, row.id, "the row id must NOT churn: the editor posts it back");
      assert.deepEqual(after, before);
      assert.equal(await updatedAt(deckId), "2000-01-01 00:00:00+00", "a no-op must not touch the deck");
    });

    it("does not merge across finishes", async () => {
      const deckId = await newDeck("finish sensitive move");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });
      const foil = await addDeckCard(pool, deckId, {
        scryfallId: SOL_C19.id, quantity: 1, board: "maybe", finish: "foil",
      });
      const moved = await moveDeckCard(pool, deckId, foil.id, "main");
      assert.equal(moved?.finish, "foil");
      assert.equal(moved?.quantity, 1, "a foil must not be folded into its non-foil twin");
      const rows = await rawRows(deckId);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => `${r.board}/${r.finish}`).sort(), ["main/foil", "main/nonfoil"]);
    });

    it("returns null and moves nothing for another deck's row id", async () => {
      const mine = await newDeck("mine 3");
      const theirs = await newDeck("theirs 3", otherUserId);
      const theirRow = await addDeckCard(pool, theirs, {
        scryfallId: FOREST.id, quantity: 1, board: "main", finish: "nonfoil",
      });
      assert.equal(await moveDeckCard(pool, mine, theirRow.id, "sideboard"), null);
      const after = await rawRows(theirs);
      assert.equal(after[0].board, "main", "someone else's card must not move boards");
      assert.deepEqual(await rawRows(mine), [], "and nothing may appear in the attacker's deck");
    });
  });

  /* ---------------------------------------------------------------- *
   * loadDeckContents
   * ---------------------------------------------------------------- */

  describe("loadDeckContents", () => {
    it("COUNTS rows missing from the mirror instead of dropping them", async () => {
      const deckId = await newDeck("unresolved");
      await addDeckCard(pool, deckId, { scryfallId: FOREST.id, quantity: 1, board: "main", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });
      // No FK (0004_decks.sql), so this is a row the mirror simply does not know.
      await addDeckCard(pool, deckId, { scryfallId: ABSENT_ID, quantity: 4, board: "main", finish: "nonfoil" });

      const { cards, unresolved } = await loadDeckContents(pool, deckId, userId);
      assert.equal(unresolved, 1, "a stale mirror must read as 'N unresolved'");
      assert.equal(cards.length, 2);
      assert.equal(
        cards.length + unresolved,
        (await rawRows(deckId)).length,
        "the deck must not silently shrink",
      );
      assert.ok(!cards.some((c) => c.id === null), "unresolved rows must not leak into cards");
    });

    it("does NOT inflate owned when one printing sits in two of the user's collections", async () => {
      const deckId = await newDeck("owned not inflated");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });

      const { cards } = await loadDeckContents(pool, deckId, userId);
      assert.equal(cards.length, 1, "a join would have doubled this deck row to 2");
      // colA holds 2 non-foil, colB holds 3 non-foil => 5. Not 10, not 2, not 3.
      assert.equal(cards[0].owned, 5);
      assert.equal(cards[0].quantity, 1, "and the deck quantity itself must not be multiplied");
    });

    it("counts owned per finish, and never another user's copies", async () => {
      const deckId = await newDeck("owned per finish");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "foil" });
      await addDeckCard(pool, deckId, { scryfallId: SOL_LCC.id, quantity: 1, board: "main", finish: "nonfoil" });

      const { cards } = await loadDeckContents(pool, deckId, userId);
      const byFinish = new Map(cards.map((c) => [`${c.id}|${c.finish}`, c.owned]));
      assert.equal(byFinish.get(`${SOL_C19.id}|foil`), 4, "only the 4 foils in Binder A");
      // The other user holds 7 of the LCC printing; this user holds none.
      assert.equal(byFinish.get(`${SOL_LCC.id}|nonfoil`), 0, "another user's copies must not leak");
    });

    it("returns zero owned for the same deck read by a user who owns nothing", async () => {
      const deckId = await newDeck("owned is per caller");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });
      const { cards } = await loadDeckContents(pool, deckId, otherUserId + 100000);
      assert.equal(cards[0].owned, 0);
    });

    it("picks unit_price by finish, and tolerates a null price", async () => {
      const deckId = await newDeck("prices");
      await addDeckCard(pool, deckId, { scryfallId: TWO_FACED.id, quantity: 1, board: "main", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: TWO_FACED.id, quantity: 1, board: "main", finish: "foil" });
      await addDeckCard(pool, deckId, { scryfallId: TWO_FACED.id, quantity: 1, board: "main", finish: "etched" });
      // Arahbo has usd: null but usd_foil: "37.99" in the fixture.
      await addDeckCard(pool, deckId, { scryfallId: ARAHBO.id, quantity: 1, board: "commander", finish: "nonfoil" });

      const { cards } = await loadDeckContents(pool, deckId, userId);
      const price = new Map(cards.map((c) => [`${c.id}|${c.finish}`, c.unit_price]));
      assert.equal(price.get(`${TWO_FACED.id}|nonfoil`), "1.00");
      assert.equal(price.get(`${TWO_FACED.id}|foil`), "2.00");
      assert.equal(price.get(`${TWO_FACED.id}|etched`), "3.00");
      assert.equal(price.get(`${ARAHBO.id}|nonfoil`), null, "a card with no recorded sale is null, not 0");
    });

    it("falls back to the front face for a multi-face card's image", async () => {
      const deckId = await newDeck("image fallback");
      await addDeckCard(pool, deckId, { scryfallId: TWO_FACED.id, quantity: 1, board: "main", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: FOREST_BEAR.id, quantity: 1, board: "main", finish: "nonfoil" });
      const { cards } = await loadDeckContents(pool, deckId, userId);
      const image = new Map(cards.map((c) => [c.id, c.image]));
      // Top-level image_uris is NULL on a modal_dfc; without the COALESCE this
      // would render as a broken image.
      assert.equal(image.get(TWO_FACED.id), "https://example.invalid/front.jpg");
      assert.equal(image.get(FOREST_BEAR.id), "https://example.invalid/forest-bear.jpg");
    });

    it("carries board through, and sorts unresolved rows last", async () => {
      const deckId = await newDeck("ordering");
      await addDeckCard(pool, deckId, { scryfallId: SOL_C19.id, quantity: 1, board: "main", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: ARAHBO.id, quantity: 1, board: "commander", finish: "nonfoil" });
      await addDeckCard(pool, deckId, { scryfallId: FOREST.id, quantity: 1, board: "main", finish: "nonfoil" });

      const { cards } = await loadDeckContents(pool, deckId, userId);
      assert.deepEqual(
        cards.map((c) => c.name),
        ["Arahbo, Roar of the World", "Forest", "Sol Ring"],
      );
      assert.equal(cards.find((c) => c.name === "Arahbo, Roar of the World")?.board, "commander");
      assert.deepEqual(toDeckEntries(cards).map((e) => e.board), ["commander", "main", "main"]);
    });

    it("reads an empty deck as empty rather than throwing", async () => {
      const deckId = await newDeck("empty");
      assert.deepEqual(await loadDeckContents(pool, deckId, userId), { cards: [], unresolved: 0 });
    });
  });

  /* ---------------------------------------------------------------- *
   * searchMirror
   * ---------------------------------------------------------------- */

  describe("searchMirror", () => {
    it("scope 'owned' restricts to the user's cards; scope 'all' does not", async () => {
      const owned = await searchMirror(pool, { userId, q: "Sol Ring", scope: "owned", limit: 100 });
      assert.deepEqual(
        owned.map((r) => r.id),
        [SOL_C19.id],
        "only the C19 printing is in this user's collections",
      );

      const all = await searchMirror(pool, { userId, q: "Sol Ring", scope: "all", limit: 100 });
      const ids = all.map((r) => r.id);
      assert.ok(ids.includes(SOL_C19.id) && ids.includes(SOL_LCC.id), "scope all opens the whole mirror");
      assert.ok(all.length >= 2);
    });

    it("returns ONE row for a printing held in two collections, with the summed count", async () => {
      const owned = await searchMirror(pool, { userId, q: "Sol Ring", scope: "owned", limit: 100 });
      assert.equal(owned.length, 1, "EXISTS, not a join — two collections must not mean two rows");
      // 2 (Binder A) + 3 (Binder B) + 4 foil (Binder A) = 9. searchMirror's
      // owned is all-finishes, unlike loadDeckContents' per-finish count.
      assert.equal(owned[0].owned, 9);
    });

    it("does not count another user's copies, or show their cards under scope owned", async () => {
      // The other user owns the LCC printing (7 copies); this user owns none.
      const all = await searchMirror(pool, { userId, q: "Sol Ring", scope: "all", limit: 100 });
      assert.equal(all.find((r) => r.id === SOL_LCC.id)?.owned, 0);
      const theirs = await searchMirror(pool, { userId: otherUserId, q: "Sol Ring", scope: "owned", limit: 100 });
      assert.deepEqual(theirs.map((r) => r.id).sort(), [SOL_C19.id, SOL_LCC.id].sort());
    });

    /**
     * This pins the user-visible ordering, not a particular clause.
     *
     * The first ORDER BY tier, `(LOWER(s.name) = LOWER($2)) DESC`, turns out to
     * be unreachable-by-effect: an exact match also satisfies the prefix tier,
     * and it is the SHORTEST string with that prefix, so `s.name ASC` already
     * puts it first. Deleting that tier changes no result — verified by
     * mutation (the whole suite still passed) and by replaying every name in the
     * mirror as a query with and without it (19 terms, 0 order differences).
     * See the report; it is redundancy, not a bug.
     */
    it("ranks an exact name first, then a prefix match, then alphabetically", async () => {
      // Scoped to owned so the result set is exactly these three regardless of
      // what else the mirror holds.
      const rows = await searchMirror(pool, { userId, q: "Forest", scope: "owned", limit: 100 });
      assert.deepEqual(
        rows.map((r) => r.name),
        ["Forest", "Forest Bear", "Snow-Covered Forest"],
        "exact must not be buried under a longer name",
      );
      assert.equal(rows[0].id, FOREST.id);
    });

    it("is case-insensitive on the search term", async () => {
      const lower = await searchMirror(pool, { userId, q: "forest", scope: "owned", limit: 100 });
      const upper = await searchMirror(pool, { userId, q: "FOREST", scope: "owned", limit: 100 });
      assert.deepEqual(lower.map((r) => r.id), upper.map((r) => r.id));
      assert.equal(lower[0].id, FOREST.id, "exact ranking survives a case difference");
    });

    it("matches a substring anywhere in the name", async () => {
      const rows = await searchMirror(pool, { userId, q: "Covered", scope: "owned", limit: 100 });
      assert.deepEqual(rows.map((r) => r.id), [SNOW_FOREST.id]);
    });

    it("returns the mirror columns the picker renders", async () => {
      const [row] = await searchMirror(pool, { userId, q: "Arahbo", scope: "all", limit: 1 });
      assert.equal(row.name, "Arahbo, Roar of the World");
      assert.equal(row.set_code, "c17");
      assert.equal(row.set_name, "Commander 2017");
      assert.equal(row.collector_number, "27");
      assert.deepEqual(row.color_identity, ["G", "W"]);
      assert.deepEqual(row.legalities, { commander: "legal" });
      assert.deepEqual(row.finishes, ["nonfoil", "foil"]);
      assert.equal(row.owned, 0);
    });

    it("honours the limit", async () => {
      const rows = await searchMirror(pool, { userId, q: "Forest", scope: "owned", limit: 1 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "Forest");
    });

    it("returns nothing for a term that matches nothing", async () => {
      assert.deepEqual(
        await searchMirror(pool, { userId, q: "Nonexistent Ninety Nine Card", scope: "all" }),
        [],
      );
    });

    /**
     * MINOR FINDING, recorded not fixed: the search term is concatenated into
     * the ILIKE pattern without escaping, so `%` and `_` are wildcards. Not an
     * injection (it is still a bind parameter), but a user searching "50_" or
     * "%" gets pattern semantics rather than literal ones.
     */
    it("KNOWN: LIKE metacharacters in the term are not escaped", async () => {
      const wild = await searchMirror(pool, { userId, q: "%", scope: "owned", limit: 100 });
      assert.ok(wild.length > 1, "'%' matched everything owned rather than nothing");
      const underscore = await searchMirror(pool, { userId, q: "F_rest", scope: "owned", limit: 100 });
      assert.ok(
        underscore.some((r) => r.id === FOREST.id),
        "'_' behaved as a single-character wildcard",
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * touchDeck
   * ---------------------------------------------------------------- */

  describe("touchDeck", () => {
    it("moves updated_at forward", async () => {
      const deckId = await newDeck("touch");
      await pinUpdatedAt(deckId);
      await touchDeck(pool, deckId);
      assert.notEqual(await updatedAt(deckId), "2000-01-01 00:00:00+00");
    });

    it("is harmless for a deck id that does not exist", async () => {
      await touchDeck(pool, 2_147_483_646);
    });
  });
});
