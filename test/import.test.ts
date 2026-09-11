/**
 * Import pipeline tests.
 *
 *   npm test
 *
 * The pure tests always run. The database tests run only when
 * TEST_DATABASE_URL is set, e.g.
 *
 * The `test` script passes --test-concurrency=1 and that is load-bearing here,
 * not a preference. Node runs test FILES in parallel processes by default, and
 * every DB-backed file in this directory seeds the same shared fixture into the
 * same tables; run them at once against one database and they delete each
 * other's rows mid-assertion. Serialized the suite is 435/435 green; parallel
 * it fails about fifteen, in whichever files lose the race that run.
 *
 *   docker run -d --name nn-import-test -p 55432:5432 \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=ninetynine -e POSTGRES_USER=ninetynine \
 *     postgres:17-alpine
 *   for f in db/migrations/*.sql; do
 *     docker exec -i nn-import-test psql -v ON_ERROR_STOP=1 -U ninetynine -d ninetynine < "$f"
 *   done
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55432/ninetynine npm test
 *
 * A DEDICATED variable, not DATABASE_URL: these tests insert placeholder rows
 * into `scryfall_cards` and must never be able to do that to a real instance by
 * inheriting the app's environment.
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
 * real `.ts` extension. Same idiom as test/auth.test.ts.
 */
import type * as MoxfieldModule from "../lib/import/moxfield-text";
import type * as ResolveModule from "../lib/import/resolve";
import type { ParsedLine } from "../lib/import/moxfield-text";
import type { ResolvedMatch } from "../lib/import/resolve";

const moxfieldSpecifier = "../lib/import/moxfield-text.ts";
const resolveSpecifier = "../lib/import/resolve.ts";

const { mergeDuplicates, parseMoxfieldText } = (await import(
  moxfieldSpecifier
)) as typeof MoxfieldModule;

const { importCollection, planUpserts, resolveLines, setCollectorKey } = (await import(
  resolveSpecifier
)) as typeof ResolveModule;

const REPO = path.resolve(import.meta.dirname, "..");
// Synthetic fixture, regenerate with `node scripts/make-example-fixture.mjs`.
// Real collections are personal data and deliberately live outside this repo;
// the fixture is shaped to exercise the same edge cases at a readable size:
// foil/non-foil pairs of one printing, " // " split names, and non-numeric
// collector numbers (19b, S4, CHK-19, pp319sb, et45sb).
const SEED_TXT = path.join(REPO, "db/seed/example-collection.txt");
const SEED_JSON = path.join(REPO, "db/seed/example-collection.json");

/** Ground truth for the example fixture, derived from the generator's output. */
const TRUTH = {
  lines: 19,
  physicalCards: 48,
  foils: 3,
  distinctScryfallIds: 17,
  foilNonfoilPairs: 2,
  totalUsd: "62.17",
} as const;

interface SeedCard {
  n: string; sc: string; sn: string; cn: string;
  f: boolean; r: string; q: number; id: string; p: string;
}

const seedCards: SeedCard[] = JSON.parse(readFileSync(SEED_JSON, "utf8"));
const exportText = readFileSync(SEED_TXT, "utf8");

/**
 * A known single printing from the fixture, looked up rather than hardcoded so
 * regenerating the fixture cannot leave a stale UUID behind. The fixture holds
 * a second Sol Ring under a different set, which is deliberate — it is the
 * two-printings-one-oracle case — so pin the set too.
 */
const PROBE = seedCards.find((c) => c.n === "Sol Ring" && c.sc === "C19")!;

function line(over: Partial<ParsedLine> = {}): ParsedLine {
  return {
    quantity: 1, name: "Sol Ring", setCode: "c19", collectorNumber: "193",
    finish: "nonfoil", lineNumber: 1, raw: "1 Sol Ring (C19) 193", ...over,
  };
}

function match(scryfallId: string, over: Partial<ParsedLine> = {}): ResolvedMatch {
  return {
    status: "matched",
    line: line(over),
    scryfallId,
    matchedBy: "set_collector",
    card: {
      id: scryfallId, name: "x", set_code: "x", set_name: "x",
      collector_number: "x", rarity: "x",
    },
  };
}

/* ================================================================== *
 * Pure
 * ================================================================== */

describe("parser contract the resolver depends on", () => {
  it("reproduces the fixture totals", () => {
    const parsed = parseMoxfieldText(exportText);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.cards.length, TRUTH.lines);
    assert.equal(parsed.totalCards, TRUTH.physicalCards);
    assert.equal(parsed.cards.filter((c) => c.finish === "foil").length, TRUTH.foils);
  });

  it("every parsed line has a (set, collector) key present in the resolved index", () => {
    const known = new Set(seedCards.map((c) => setCollectorKey(c.sc, c.cn)));
    const parsed = parseMoxfieldText(exportText);
    const missing = parsed.cards.filter(
      (c) => !known.has(setCollectorKey(c.setCode, c.collectorNumber)),
    );
    assert.deepEqual(missing, []);
  });

  it("does not fold a foil into its non-foil twin", () => {
    const merged = mergeDuplicates([
      line({ quantity: 2, finish: "nonfoil" }),
      line({ quantity: 1, finish: "foil", lineNumber: 2 }),
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((m) => [m.finish, m.quantity]).sort(), [
      ["foil", 1],
      ["nonfoil", 2],
    ]);
  });
});

describe("setCollectorKey", () => {
  it("is case-insensitive on both halves", () => {
    assert.equal(setCollectorKey("PLST", "CHK-19"), setCollectorKey("plst", "chk-19"));
    assert.equal(setCollectorKey("PTC", "pp319sb"), setCollectorKey("ptc", "PP319SB"));
  });

  it("keeps non-numeric collector numbers distinct", () => {
    // parseInt("pp319sb") === 319, which is a different card entirely.
    assert.notEqual(setCollectorKey("ptc", "pp319sb"), setCollectorKey("ptc", "319"));
    assert.notEqual(setCollectorKey("fem", "19b"), setCollectorKey("fem", "19"));
  });
});

describe("planUpserts", () => {
  const ID = "00000000-0000-4000-8000-000000000001";

  it("keys on (scryfall_id, finish, language), so foil and non-foil stay separate", () => {
    const plan = planUpserts([
      match(ID, { quantity: 2, finish: "nonfoil" }),
      match(ID, { quantity: 1, finish: "foil", lineNumber: 2 }),
    ]);
    assert.equal(plan.length, 2);
    assert.equal(plan.find((r) => r.finish === "foil")?.quantity, 1);
    assert.equal(plan.find((r) => r.finish === "nonfoil")?.quantity, 2);
  });

  it("sums two lines that resolve to the same printing and finish", () => {
    // Reachable via the name fallback: two differently-written lines can land
    // on one printing. If they were not folded here, the single
    // INSERT ... ON CONFLICT would fail with "cannot affect row a second time".
    const plan = planUpserts([
      match(ID, { quantity: 2, collectorNumber: "193" }),
      match(ID, { quantity: 3, collectorNumber: "193★", lineNumber: 2 }),
    ]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].quantity, 5);
    assert.deepEqual(plan[0].lineNumbers, [1, 2]);
  });

  it("folds the fixture to one row per (printing, finish)", () => {
    const byKey = new Map(seedCards.map((c) => [setCollectorKey(c.sc, c.cn), c.id]));
    const parsed = parseMoxfieldText(exportText);
    const matched = parsed.cards.map((l) =>
      match(byKey.get(setCollectorKey(l.setCode, l.collectorNumber))!, l),
    );
    const plan = planUpserts(matched);
    assert.equal(plan.length, TRUTH.lines);
    assert.equal(plan.reduce((s, r) => s + r.quantity, 0), TRUTH.physicalCards);
    assert.equal(new Set(plan.map((r) => r.scryfallId)).size, TRUTH.distinctScryfallIds);
    assert.equal(plan.filter((r) => r.finish === "foil").length, TRUTH.foils);
  });
});

/* ================================================================== *
 * Database
 * ================================================================== */

const DB_URL = process.env.TEST_DATABASE_URL;

describe("resolve + import against postgres", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, () => {
  let pool: pg.Pool;
  let userId: number;
  let collectionId: number;
  const email = `import-test-${process.pid}-${Date.now()}@ninetynine.invalid`;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

    // A minimal mirror built from the already-resolved index, so resolution can
    // be tested end to end without the 500 MB bulk download. Only the columns
    // resolve.ts matches on are real; oracle_id/layout are placeholders that
    // satisfy NOT NULL. ON CONFLICT DO NOTHING so a real mirror wins.
    //
    // set_code is loaded in the export's UPPERCASE while the parser lowercases,
    // which is what makes the case-insensitive match load-bearing here.
    const byId = new Map(seedCards.map((c) => [c.id, c]));
    const cards = [...byId.values()];
    await pool.query(
      `INSERT INTO scryfall_cards
         (id, oracle_id, name, set_code, set_name, collector_number, rarity, layout)
       SELECT k.id, k.oracle, k.name, k.sc, k.sn, k.cn, k.r, k.layout
         FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[],
                     $5::text[], $6::text[], $7::text[], $8::text[])
              AS k(id, oracle, name, sc, sn, cn, r, layout)
       ON CONFLICT (id) DO NOTHING`,
      [
        cards.map((c) => c.id),
        // Deterministic stand-in; nothing under test keys on oracle_id.
        cards.map((c) => c.id),
        cards.map((c) => c.n),
        cards.map((c) => c.sc),
        cards.map((c) => c.sn),
        cards.map((c) => c.cn),
        cards.map((c) => c.r),
        cards.map((c) => (c.n.includes(" // ") ? "split" : "normal")),
      ],
    );

    // Prices keyed on (id, finish) — a printing held in both finishes has two.
    const priced = new Map(seedCards.map((c) => [`${c.id}|${c.f ? "foil" : "nonfoil"}`, c]));
    const rows = [...priced.entries()];
    await pool.query(
      `INSERT INTO card_price_history (scryfall_id, finish, recorded_on, usd)
       SELECT k.id, k.finish, DATE '2026-09-01', k.usd::numeric
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS k(id, finish, usd)
       ON CONFLICT DO NOTHING`,
      [
        rows.map(([, c]) => c.id),
        rows.map(([key]) => key.split("|")[1]),
        rows.map(([, c]) => c.p),
      ],
    );

    const user = await pool.query(
      "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
      ["import test", email],
    );
    userId = user.rows[0].id;
    const collection = await pool.query(
      "INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id",
      [userId, "Import test"],
    );
    collectionId = collection.rows[0].id;
  });

  after(async () => {
    if (!pool) return;
    // Cascades to collections -> collection_cards / imports / issues.
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    // `scryfall_cards` and `card_price_history` are NOT owned by that user, so
    // nothing cascades them away. They have to go explicitly, or this file
    // hands the next one a mirror it never asked for: the seed ids are the
    // shared fixture's, so a later file that seeds the same printings inherits
    // prices it did not write and a "collection with no price history" quietly
    // acquires one. Scoped to the ids this file inserted rather than a
    // TRUNCATE, because a real database may be pointed at by mistake.
    const ids = seedCards.map((c) => c.id);
    await pool.query("DELETE FROM card_price_history WHERE scryfall_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM scryfall_cards WHERE id = ANY($1::uuid[])", [ids]);

    await pool.end();
  });

  it("resolves every line by (set_code, collector_number)", async () => {
    const parsed = parseMoxfieldText(exportText);
    const summary = await resolveLines(pool, parsed.cards);
    assert.equal(summary.counts.total, TRUTH.lines);
    assert.equal(summary.counts.matched, TRUTH.lines);
    assert.equal(summary.counts.bySetCollector, TRUTH.lines);
    assert.equal(summary.counts.byNameInSet, 0);
    assert.equal(summary.counts.byName, 0);
    assert.equal(summary.counts.noMatch, 0);
    assert.equal(summary.counts.ambiguous, 0);
  });

  it("resolves the oddball collector numbers to the right printings", async () => {
    const odd = [
      { setCode: "plst", collectorNumber: "CHK-19", name: "Isamaru, Hound of Konda" },
      { setCode: "ptc", collectorNumber: "pp319sb", name: "Fellwar Stone" },
      { setCode: "8ed", collectorNumber: "S4", name: "Sea Eagle" },
      { setCode: "fem", collectorNumber: "19b", name: "Homarid" },
      { setCode: "ptc", collectorNumber: "et45sb", name: "Reverse Damage" },
    ];
    const summary = await resolveLines(
      pool,
      odd.map((o, i) => line({ ...o, lineNumber: i + 1 })),
    );
    for (const r of summary.results) {
      assert.equal(r.status, "matched", `${r.line.setCode} ${r.line.collectorNumber} unresolved`);
      assert.equal((r as ResolvedMatch).card.name, r.line.name);
    }
  });

  it("reports a miss rather than dropping it", async () => {
    const summary = await resolveLines(pool, [
      line({ name: "Nonexistent The Ninety Nine Test Card", setCode: "zzz", collectorNumber: "999" }),
    ]);
    assert.equal(summary.counts.noMatch, 1);
    assert.equal(summary.unresolved.length, 1);
    assert.equal(summary.unresolved[0].status, "no_match");
    assert.equal(summary.unresolved[0].line.name, "Nonexistent The Ninety Nine Test Card");
  });

  it("falls back to name+set when the collector number is wrong", async () => {
    // Right set, mangled collector number. Stage (a) misses; stage (b) recovers.
    const summary = await resolveLines(pool, [
      line({ name: PROBE.n, setCode: PROBE.sc.toLowerCase(), collectorNumber: "not-a-real-number" }),
    ]);
    assert.equal(summary.counts.matched, 1);
    assert.equal(summary.matched[0].matchedBy, "name_in_set");
    assert.equal(summary.matched[0].card.collector_number, PROBE.cn);
  });

  it("imports batch 01 to exactly the known totals", async () => {
    const parsed = parseMoxfieldText(exportText);
    const result = await importCollection(
      pool,
      { cards: mergeDuplicates(parsed.cards), errors: parsed.errors },
      { collectionId, filename: "example-collection.txt" },
    );

    assert.equal(result.linesMatched, TRUTH.lines);
    assert.equal(result.rowsWritten, TRUTH.lines);
    assert.equal(result.rowsInserted, TRUTH.lines);
    assert.equal(result.cardsMatched, TRUTH.physicalCards);
    assert.equal(result.issues, 0);

    const stored = await pool.query(
      `SELECT count(*)::int AS rows, sum(quantity)::int AS qty,
              count(*) FILTER (WHERE finish = 'foil')::int AS foils,
              count(DISTINCT scryfall_id)::int AS ids
         FROM collection_cards WHERE collection_id = $1`,
      [collectionId],
    );
    assert.deepEqual(stored.rows[0], {
      rows: TRUTH.lines,
      qty: TRUTH.physicalCards,
      foils: TRUTH.foils,
      ids: TRUTH.distinctScryfallIds,
    });

    const issues = await pool.query(
      `SELECT count(*)::int AS n FROM collection_import_issues WHERE import_id = $1`,
      [result.importId],
    );
    assert.equal(issues.rows[0].n, 0);

    const value = await pool.query(
      "SELECT total_usd::text AS total FROM collection_values WHERE collection_id = $1",
      [collectionId],
    );
    assert.equal(value.rows[0].total, TRUTH.totalUsd);
  });

  it("is idempotent — re-importing the same file changes nothing", async () => {
    const parsed = parseMoxfieldText(exportText);
    const result = await importCollection(
      pool,
      { cards: mergeDuplicates(parsed.cards), errors: parsed.errors },
      { collectionId, filename: "example-collection.txt" },
    );

    assert.equal(result.rowsInserted, 0, "second run must insert nothing");
    assert.equal(result.rowsUpdated, TRUTH.lines);
    assert.equal(result.quantityDelta, 0, "quantities must not move");

    const stored = await pool.query(
      `SELECT count(*)::int AS rows, sum(quantity)::int AS qty,
              count(*) FILTER (WHERE finish = 'foil')::int AS foils
         FROM collection_cards WHERE collection_id = $1`,
      [collectionId],
    );
    assert.deepEqual(stored.rows[0], {
      rows: TRUTH.lines,
      qty: TRUTH.physicalCards,
      foils: TRUTH.foils,
    });
  });

  it("keeps foil and non-foil of the same printing as two rows", async () => {
    const pairs = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT scryfall_id FROM collection_cards WHERE collection_id = $1
         GROUP BY scryfall_id HAVING count(DISTINCT finish) > 1) t`,
      [collectionId],
    );
    assert.equal(pairs.rows[0].n, TRUTH.foilNonfoilPairs);

    // ... and they carry independent prices, which is the reason it matters.
    const priced = await pool.query(
      `SELECT s.name, cc.finish, h.usd::text AS usd
         FROM collection_cards cc
         JOIN scryfall_cards s ON s.id = cc.scryfall_id
         JOIN card_price_history h
           ON h.scryfall_id = cc.scryfall_id AND h.finish = cc.finish
        WHERE cc.collection_id = $1 AND s.set_code = 'ZNR' AND s.collector_number = '26'
        ORDER BY cc.finish`,
      [collectionId],
    );
    assert.deepEqual(
      priced.rows.map((r: { finish: string; usd: string }) => [r.finish, r.usd]),
      [["foil", "0.79"], ["nonfoil", "0.35"]],
    );
  });

  it("records unresolved lines as issues instead of dropping them", async () => {
    const text = [
      `1 ${PROBE.n} (${PROBE.sc}) ${PROBE.cn}`,
      "1 Totally Made Up Card (ZZZ) 999",
      "this line is not parseable at all",
    ].join("\n");
    const parsed = parseMoxfieldText(text);
    assert.equal(parsed.errors.length, 1, "the junk line must be a parse error");

    const result = await importCollection(
      pool,
      { cards: mergeDuplicates(parsed.cards), errors: parsed.errors },
      { collectionId, filename: "mixed.txt" },
    );

    assert.equal(result.linesMatched, 1);
    assert.equal(result.issues, 2);
    assert.equal(result.issueBreakdown.no_match, 1);
    assert.equal(result.issueBreakdown.parse_error, 1);

    const issues = await pool.query(
      `SELECT reason, raw_line FROM collection_import_issues
        WHERE import_id = $1 ORDER BY reason`,
      [result.importId],
    );
    assert.deepEqual(
      issues.rows.map((r: { reason: string }) => r.reason),
      ["no_match", "parse_error"],
    );

    const audit = await pool.query(
      "SELECT status, lines_total, lines_matched FROM collection_imports WHERE id = $1",
      [result.importId],
    );
    assert.deepEqual(audit.rows[0], { status: "ok", lines_total: 2, lines_matched: 1 });
  });

  it("dry run writes nothing", async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS rows, sum(quantity)::int AS qty FROM collection_cards
        WHERE collection_id = $1`,
      [collectionId],
    );
    const importsBefore = await pool.query(
      "SELECT count(*)::int AS n FROM collection_imports WHERE collection_id = $1",
      [collectionId],
    );

    const parsed = parseMoxfieldText(exportText);
    const result = await importCollection(
      pool,
      { cards: mergeDuplicates(parsed.cards), errors: parsed.errors },
      { collectionId, dryRun: true, onConflict: "add" },
    );
    assert.equal(result.importId, null);
    assert.equal(result.dryRun, true);
    assert.equal(result.rowsUpdated, TRUTH.lines);
    assert.equal(result.quantityDelta, TRUTH.physicalCards, "add mode would add every physical card");

    const after = await pool.query(
      `SELECT count(*)::int AS rows, sum(quantity)::int AS qty FROM collection_cards
        WHERE collection_id = $1`,
      [collectionId],
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
    const importsAfter = await pool.query(
      "SELECT count(*)::int AS n FROM collection_imports WHERE collection_id = $1",
      [collectionId],
    );
    assert.equal(importsAfter.rows[0].n, importsBefore.rows[0].n);
  });

  it("add mode accumulates when asked explicitly", async () => {
    const one = `1 ${PROBE.n} (${PROBE.sc}) ${PROBE.cn}\n`;
    const before = await pool.query(
      `SELECT quantity FROM collection_cards
        WHERE collection_id = $1 AND scryfall_id = $2
          AND finish = 'nonfoil'`,
      [collectionId, PROBE.id],
    );
    const parsed = parseMoxfieldText(one);
    await importCollection(
      pool,
      { cards: parsed.cards, errors: parsed.errors },
      { collectionId, onConflict: "add" },
    );
    const after = await pool.query(
      `SELECT quantity FROM collection_cards
        WHERE collection_id = $1 AND scryfall_id = $2
          AND finish = 'nonfoil'`,
      [collectionId, PROBE.id],
    );
    assert.equal(after.rows[0].quantity, before.rows[0].quantity + 1);
  });
});
