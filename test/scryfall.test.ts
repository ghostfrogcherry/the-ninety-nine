/**
 * Tests for the weekly Scryfall bulk refresh.
 *
 * Fixtures are REAL Scryfall card objects (lib/scryfall/testdata/), pulled from
 * the live API and stripped only of noise fields the importer never reads
 * (rulings/purchase URIs, marketplace ids). Every value below — prices, layouts,
 * the missing top-level oracle_id — is Scryfall's, not invented. The six cards
 * are chosen to cover the ways this import goes wrong:
 *
 *   znr 26   Makindi Stampede // Makindi Mesas  modal_dfc: card_faces, empty
 *                                               mana_cost, no image_uris, and
 *                                               a usd/usd_foil split
 *   c19 193  Growing Ranks                      plain card, nonfoil price only
 *   khm 400  Reflections of Littjara            usd NULL but usd_foil 2.25 —
 *                                               the case a per-printing price
 *                                               would record as worthless
 *   sld 1544 Adrix and Nev, Twincasters         reversible_card with NO
 *                                               top-level oracle_id
 *   afr A-87 A-Acererak the Archlich            every price null
 *   40k 319  Abaddon the Despoiler              etched-only price
 *
 * The database tests need a real Postgres and are skipped without one:
 *
 *   docker run -d --name nn-scryfall-test -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=ninetynine -e POSTGRES_USER=ninetynine -p 55433:5432 \
 *     postgres:17-alpine
 *   for f in db/migrations/*.sql; do
 *     docker exec -i nn-scryfall-test psql -v ON_ERROR_STOP=1 \
 *       -U ninetynine -d ninetynine < "$f"; done
 *   TEST_DATABASE_URL=postgres://ninetynine:t@127.0.0.1:55433/ninetynine npm test
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

import { resolveOracleId, toCardRow, CARD_COLUMNS } from "../lib/scryfall/card-row.mjs";
import { bulkFileName, fetchBulkEntry } from "../lib/scryfall/http.mjs";
import { runRefresh } from "../lib/scryfall/refresh.mjs";
import { buildCardUpsert, FINISH_PRICE_KEYS, MAX_BATCH_SIZE } from "../lib/scryfall/sql.mjs";
import { parseJsonArray, parseJsonLines, streamCards } from "../lib/scryfall/stream.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTDATA = path.join(HERE, "..", "lib", "scryfall", "testdata");
const JSONL_FIXTURE = path.join(TESTDATA, "default-cards-sample.jsonl");
const JSON_FIXTURE = path.join(TESTDATA, "default-cards-sample.json");

const MAKINDI = "ada9a974-8f1f-4148-bd61-200fc14714b2"; // modal_dfc, usd + usd_foil
const GROWING_RANKS = "6ea45414-4047-4921-b77d-dfcba2fe7694"; // nonfoil price only
const LITTJARA = "4ebaa07d-68f6-4cdb-a5cd-cd715e50abf5"; // foil price only
const ADRIX = "6adadbc9-4a08-4c1d-adf7-edee73799d9e"; // no top-level oracle_id
const ACERERAK = "eb363654-2004-4db8-bbd2-5b121da4f2a0"; // all prices null
const ABADDON = "de313e48-4e68-48ea-973e-37aef5b9c1d0"; // etched price only

type Card = Record<string, any>;

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/** Feed a string to a stream parser in fixed-size pieces, to force boundaries. */
async function* inChunks(text: string, size: number) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

async function* bytesInChunks(buffer: Buffer, size: number) {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}

async function loadFixtureCards(): Promise<Card[]> {
  const text = await readFile(JSONL_FIXTURE, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Streaming parser
// ---------------------------------------------------------------------------

describe("streaming bulk parser", () => {
  it("reads every card out of the JSON Lines fixture", async () => {
    const text = await readFile(JSONL_FIXTURE, "utf8");
    const cards = (await collect(parseJsonLines(inChunks(text, 4096)))) as Card[];
    assert.equal(cards.length, 6);
    assert.deepEqual(
      cards.map((c) => c.id),
      [MAKINDI, GROWING_RANKS, LITTJARA, ADRIX, ACERERAK, ABADDON],
    );
  });

  it("reads the same cards out of the legacy top-level JSON array", async () => {
    const arrayText = await readFile(JSON_FIXTURE, "utf8");
    const fromArray = await collect(parseJsonArray(inChunks(arrayText, 4096)));
    assert.deepEqual(fromArray, await loadFixtureCards());
  });

  it("gives identical results at every chunk boundary", async () => {
    const expected = await loadFixtureCards();
    const arrayText = await readFile(JSON_FIXTURE, "utf8");
    const linesText = await readFile(JSONL_FIXTURE, "utf8");

    // 1 byte at a time splits mid-string, mid-escape and mid-number everywhere.
    for (const size of [1, 2, 3, 7, 64, 999, 4096, 1 << 20]) {
      assert.deepEqual(
        await collect(parseJsonArray(inChunks(arrayText, size))),
        expected,
        `JSON array failed at chunk size ${size}`,
      );
      assert.deepEqual(
        await collect(parseJsonLines(inChunks(linesText, size))),
        expected,
        `JSON Lines failed at chunk size ${size}`,
      );
    }
  });

  it("does not let braces or quotes inside string values move the depth counter", async () => {
    // Real data already covers this — Adrix's oracle_text contains "{T}" and
    // every card carries mana symbols — but the pathological cases are worth
    // pinning explicitly: an escaped quote followed by a brace, and a trailing
    // backslash right before the closing quote.
    const nasty = [
      { name: 'quote " then brace {', oracle_text: 'say \\"}]}\\" and stop' },
      { name: "backslash at end \\\\", nested: { a: ["}", "]", "{"], b: '"' } },
      { name: "unicode — Æther {2}{G/W}", cmc: 4 },
    ];
    const text = JSON.stringify(nasty);
    for (const size of [1, 5, 33, 4096]) {
      assert.deepEqual(await collect(parseJsonArray(inChunks(text, size))), nasty);
    }
  });

  it("handles an empty array and rejects malformed input", async () => {
    assert.deepEqual(await collect(parseJsonArray(inChunks("  [ ]  ", 2))), []);

    await assert.rejects(
      () => collect(parseJsonArray(inChunks('[{"id":1},', 3))),
      /never closed/,
      "a truncated download must fail loudly, not import a partial mirror",
    );
    await assert.rejects(
      () => collect(parseJsonArray(inChunks('[{"id":1}] {"id":2}', 3))),
      /trailing data/,
    );
    await assert.rejects(() => collect(parseJsonArray(inChunks('{"id":1}', 3))), /expected '\['/);
    await assert.rejects(() => collect(parseJsonArray(inChunks("[1,2]", 3))), /unexpected character/);
  });

  it("auto-detects gzip and format through streamCards", async () => {
    const expected = await loadFixtureCards();
    const linesRaw = await readFile(JSONL_FIXTURE);
    const arrayRaw = await readFile(JSON_FIXTURE);

    const cases: Array<[string, Buffer]> = [
      ["plain jsonl", linesRaw],
      ["gzipped jsonl", gzipSync(linesRaw)],
      ["plain json array", arrayRaw],
      ["gzipped json array", gzipSync(arrayRaw)],
    ];
    for (const [label, buffer] of cases) {
      // 3-byte chunks also split the two-byte gzip magic number.
      assert.deepEqual(await collect(streamCards(bytesInChunks(buffer, 3))), expected, label);
    }
  });

  it("decodes multi-byte UTF-8 split across chunk boundaries", async () => {
    const cards = (await collect(
      streamCards(bytesInChunks(await readFile(JSONL_FIXTURE), 1)),
    )) as Card[];
    const abaddon = cards.find((c) => c.id === ABADDON)!;
    assert.match(abaddon.type_line, /—/, "em dash survived a 1-byte-chunk read");
  });
});

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

describe("card row mapping", () => {
  let cards: Card[];
  before(async () => {
    cards = await loadFixtureCards();
  });

  const find = (id: string) => cards.find((c) => c.id === id)!;
  const col = (row: unknown[], name: string) => row[CARD_COLUMNS.indexOf(name)];

  it("falls back to a face oracle_id for reversible_card", () => {
    const adrix = find(ADRIX);
    assert.equal("oracle_id" in adrix, false, "fixture really has no top-level oracle_id");
    assert.equal(resolveOracleId(adrix), adrix.card_faces[0].oracle_id);
    assert.equal(col(toCardRow(adrix), "oracle_id"), "12a6cad9-eb42-43bd-9e68-aaf862cd83db");
  });

  it("stores multi-face cards with their faces and a null top-level mana cost", () => {
    const makindi = find(MAKINDI);
    // Scryfall OMITS mana_cost entirely on modal_dfc — it is absent, not "".
    // (Verified against the real fixture: the key is not present on the object.)
    assert.equal(makindi.mana_cost, undefined, "Scryfall omits it; it is not an empty string");
    assert.equal(makindi.image_uris, undefined);

    const row = toCardRow(makindi);
    assert.equal(col(row, "mana_cost"), null);
    assert.equal(col(row, "oracle_text"), null);
    assert.equal(col(row, "image_uris"), null);
    assert.equal(col(row, "colors"), null, "absent colors stays NULL, not empty");
    // Mono-white: {3}{W}{W} sorcery on the front, colourless land on the back.
    assert.deepEqual(col(row, "color_identity"), ["W"]);
    assert.equal(JSON.parse(col(row, "card_faces") as string).length, 2);
  });

  it("keeps ordinary cards intact", () => {
    const row = toCardRow(find(GROWING_RANKS));
    // Growing Ranks is {2}{G/W}{G/W} — two hybrid symbols, not one.
    assert.equal(col(row, "mana_cost"), "{2}{G/W}{G/W}");
    assert.equal(col(row, "collector_number"), "193");
    assert.equal(col(row, "set_code"), "c19");
    assert.equal(row.length, CARD_COLUMNS.length);
  });

  it("rejects rows that cannot fill a NOT NULL column", () => {
    const ok = find(GROWING_RANKS);
    assert.throws(() => toCardRow({ ...ok, id: undefined }), /missing required field 'id'/);
    assert.throws(() => toCardRow({ ...ok, set: "" }), /missing required field 'set'/);
    assert.throws(
      () => toCardRow({ ...ok, oracle_id: undefined }),
      /no oracle_id on the card or any of its faces/,
    );
  });
});

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

describe("sql builders", () => {
  it("numbers placeholders across a multi-row insert", () => {
    const sql = buildCardUpsert(3);
    const width = CARD_COLUMNS.length;
    assert.match(sql, /^INSERT INTO scryfall_cards \(id, oracle_id, /);
    assert.ok(sql.includes(`$${width}`) && sql.includes(`$${width * 3}`));
    assert.ok(!sql.includes(`$${width * 3 + 1}`));
    assert.match(sql, /ON CONFLICT \(id\) DO UPDATE SET/);
    assert.match(sql, /imported_at = now\(\)/);
    assert.ok(!/id = EXCLUDED\.id/.test(sql), "the conflict key must not be re-assigned");
  });

  it("refuses a batch that would exceed the bound-parameter limit", () => {
    assert.ok(MAX_BATCH_SIZE * CARD_COLUMNS.length <= 65535);
    assert.throws(() => buildCardUpsert(MAX_BATCH_SIZE + 1), /parameter limit/);
    assert.throws(() => buildCardUpsert(0), /positive integer/);
  });

  it("maps each finish to its own Scryfall price keys", () => {
    assert.equal(FINISH_PRICE_KEYS.nonfoil.usd, "usd");
    assert.equal(FINISH_PRICE_KEYS.foil.usd, "usd_foil");
    assert.equal(FINISH_PRICE_KEYS.etched.usd, "usd_etched");
  });

  it("derives a safe filename from the download URI", () => {
    assert.equal(
      bulkFileName(
        "https://data.scryfall.io/default-cards/default-cards-20260901210543.jsonl.gz",
        "default_cards",
      ),
      "default-cards-20260901210543.jsonl.gz",
    );
    assert.equal(bulkFileName("not a url", "default_cards"), "default_cards.data");
  });
});

// ---------------------------------------------------------------------------
// A stand-in for api.scryfall.com
// ---------------------------------------------------------------------------

interface FakeScryfall {
  url: string;
  hits: Array<{ path: string; userAgent?: string; accept?: string }>;
  setPayload(updatedAt: string, cards: Card[]): void;
  close(): Promise<void>;
}

async function startFakeScryfall(): Promise<FakeScryfall> {
  let updatedAt = "";
  let body = Buffer.alloc(0);
  let fileName = "";
  const hits: FakeScryfall["hits"] = [];

  const server = createServer((req, res) => {
    hits.push({
      path: req.url ?? "",
      userAgent: req.headers["user-agent"],
      accept: req.headers["accept"],
    });
    if (req.url === "/bulk-data") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { object: "bulk_data", type: "oracle_cards", updated_at: updatedAt },
            {
              object: "bulk_data",
              type: "default_cards",
              updated_at: updatedAt,
              // Matches the shape Scryfall actually serves: no download_uri.
              jsonl_download_uri: `${baseUrl}/${fileName}`,
              compressed_size: body.length,
            },
          ],
        }),
      );
      return;
    }
    if (req.url === `/${fileName}`) {
      res.setHeader("content-type", "application/gzip");
      res.end(body);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: `${baseUrl}/bulk-data`,
    hits,
    setPayload(nextUpdatedAt, cards) {
      updatedAt = nextUpdatedAt;
      // Same wire format as production: gzipped JSON Lines.
      body = gzipSync(Buffer.from(cards.map((c) => JSON.stringify(c)).join("\n") + "\n"));
      fileName = `default-cards-${nextUpdatedAt.replace(/\D/g, "")}.jsonl.gz`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("refresh against postgres", { skip: DATABASE_URL ? false : "TEST_DATABASE_URL not set" }, () => {
  let pool: any;
  let server: FakeScryfall;
  let dataDir: string;
  let fixture: Card[];

  const WEEK_ONE = "2026-08-25T21:05:43.649+00:00";
  const WEEK_TWO = "2026-09-01T21:05:43.649+00:00";

  const q = async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows;

  before(async () => {
    const pg = (await import("pg")).default;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query("TRUNCATE scryfall_cards, card_price_history, scryfall_bulk_imports");
    server = await startFakeScryfall();
    dataDir = await mkdtemp(path.join(tmpdir(), "ninetynine-scryfall-"));
    fixture = await loadFixtureCards();
  });

  after(async () => {
    // These tests run a REAL refresh against the shared database: it writes
    // scryfall_cards, scryfall_bulk_imports and price history, none of which
    // hangs off a user and so none of which any cascade removes. Left behind,
    // they are the next file's starting conditions — and this file asserts
    // exact mirror counts, so a second run against the same database fails on
    // its own residue. Scoped to the fixture's ids rather than a TRUNCATE,
    // because a real instance may be pointed at by mistake.
    if (pool) {
      const ids = fixture.map((c) => c.id as string);
      await pool.query("DELETE FROM card_price_history WHERE scryfall_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM scryfall_cards WHERE id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM scryfall_bulk_imports");
    }
    await server?.close();
    await pool?.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const refresh = (extra: Record<string, unknown> = {}) =>
    runRefresh({ pool, dataDir, bulkDataUrl: server.url, log: () => {}, ...extra });

  it("imports every card on a first run", async () => {
    server.setPayload(WEEK_ONE, fixture);
    const result: any = await refresh();

    assert.equal(result.status, "ok");
    assert.equal(result.cardCount, 6);
    assert.equal(result.skipped, 0);
    assert.equal(result.downloaded, true);

    const [{ n }] = await q("SELECT count(*)::int AS n FROM scryfall_cards");
    assert.equal(n, 6);

    const [run] = await q("SELECT * FROM scryfall_bulk_imports ORDER BY id DESC LIMIT 1");
    assert.equal(run.status, "ok");
    assert.equal(run.card_count, 6);
    assert.equal(run.bulk_type, "default_cards");
    assert.equal(run.error, null);
    assert.ok(run.finished_at);
    assert.equal(new Date(run.source_updated_at).toISOString(), new Date(WEEK_ONE).toISOString());
  });

  it("sent the User-Agent and Accept headers Scryfall requires", () => {
    assert.ok(server.hits.length >= 2, "index + download");
    for (const hit of server.hits) {
      assert.match(hit.userAgent ?? "", /ninetynine/, `no descriptive UA on ${hit.path}`);
      assert.ok(hit.accept, `no Accept header on ${hit.path}`);
    }
    assert.equal(server.hits.find((h) => h.path === "/bulk-data")?.accept, "application/json");
  });

  it("stored the awkward cards correctly", async () => {
    const [adrix] = await q("SELECT * FROM scryfall_cards WHERE id = $1", [ADRIX]);
    assert.equal(adrix.oracle_id, "12a6cad9-eb42-43bd-9e68-aaf862cd83db");
    assert.equal(adrix.layout, "reversible_card");
    assert.equal(adrix.cmc, null);

    const [makindi] = await q("SELECT * FROM scryfall_cards WHERE id = $1", [MAKINDI]);
    assert.equal(makindi.mana_cost, null);
    assert.equal(makindi.image_uris, null);
    assert.equal(makindi.colors, null);
    assert.deepEqual(makindi.color_identity, ["W"]);
    assert.equal(makindi.card_faces.length, 2);
    assert.equal(makindi.card_faces[0].name, "Makindi Stampede");
    assert.equal(makindi.legalities.commander, "legal");
    assert.equal(makindi.prices.usd, "0.20");
    assert.deepEqual(makindi.finishes, ["nonfoil", "foil"]);
    assert.equal(makindi.released_at.toISOString().slice(0, 10), "2020-09-25");
  });

  it("exits early without downloading when source_updated_at has not moved", async () => {
    const before = server.hits.length;
    const result: any = await refresh();

    assert.equal(result.status, "skipped");
    assert.equal(result.downloaded, false);
    assert.equal(result.reason, "source_updated_at unchanged");

    const paths = server.hits.slice(before).map((h) => h.path);
    assert.deepEqual(paths, ["/bulk-data"], "must hit the index and nothing else");

    const [{ n }] = await q("SELECT count(*)::int AS n FROM scryfall_bulk_imports");
    assert.equal(n, 1, "an early exit must not log a run row");
  });

  it("is idempotent when the same payload is re-imported", async () => {
    const rowsBefore = await q("SELECT id, oracle_id, prices FROM scryfall_cards ORDER BY id");
    const result: any = await refresh({ force: true });

    assert.equal(result.status, "ok");
    assert.equal(result.cardCount, 6);

    const rowsAfter = await q("SELECT id, oracle_id, prices FROM scryfall_cards ORDER BY id");
    assert.equal(rowsAfter.length, 6, "upsert must not duplicate rows");
    assert.deepEqual(rowsAfter, rowsBefore);
  });

  it("snapshots the OUTGOING prices, one row per finish, before overwriting them", async () => {
    // The preceding force-re-import legitimately snapshotted the week-one
    // prices (the snapshot is unconditional — it always preserves outgoing
    // prices before an overwrite). Those rows are dated today, whereas this
    // test back-dates the mirror to a week ago, and the lookups below match on
    // (id, finish) without a date. Clear history so this test measures ONLY
    // what the week-two import snapshots.
    await q("DELETE FROM card_price_history");

    // Pretend the mirror was written a week ago, so the snapshot dates itself
    // to when those prices were true rather than to today.
    await q("UPDATE scryfall_cards SET imported_at = now() - interval '7 days'");
    const [{ d: lastWeek }] = await q(
      "SELECT ((now() - interval '7 days') AT TIME ZONE 'UTC')::date::text AS d",
    );

    // Week two: Makindi moves in both finishes. The history must keep the OLD
    // numbers; scryfall_cards must end up with the new ones.
    const moved = fixture.map((card) =>
      card.id === MAKINDI
        ? { ...card, prices: { ...card.prices, usd: "0.99", usd_foil: "1.99" } }
        : card,
    );
    server.setPayload(WEEK_TWO, moved);
    const result: any = await refresh();
    assert.equal(result.status, "ok");

    const history = await q(
      `SELECT scryfall_id, finish, recorded_on::text AS recorded_on, usd, eur, tix
       FROM card_price_history ORDER BY scryfall_id, finish`,
    );

    const rowsFor = (id: string) => history.filter((r: any) => r.scryfall_id === id);
    const one = (id: string, finish: string) =>
      history.find((r: any) => r.scryfall_id === id && r.finish === finish);

    // Foil and non-foil are separate rows carrying different money.
    assert.deepEqual(one(MAKINDI, "nonfoil"), {
      scryfall_id: MAKINDI,
      finish: "nonfoil",
      recorded_on: lastWeek,
      usd: "0.20",
      eur: "0.19",
      tix: "0.03",
    });
    assert.deepEqual(one(MAKINDI, "foil"), {
      scryfall_id: MAKINDI,
      finish: "foil",
      recorded_on: lastWeek,
      usd: "0.30",
      eur: "0.28",
      tix: null,
    });

    // ...and the live mirror now holds the NEW prices.
    const [makindi] = await q("SELECT prices FROM scryfall_cards WHERE id = $1", [MAKINDI]);
    assert.equal(makindi.prices.usd, "0.99");
    assert.equal(makindi.prices.usd_foil, "1.99");

    // usd null / usd_foil 2.25: a foil row only. Collapsing this to one price
    // per printing would value a $2.25 card at nothing.
    assert.deepEqual(
      rowsFor(LITTJARA).map((r: any) => r.finish),
      ["foil"],
    );
    assert.equal(one(LITTJARA, "foil")!.usd, "2.25");
    assert.equal(one(LITTJARA, "foil")!.eur, "1.28");

    // Inverse case: nonfoil price only.
    assert.deepEqual(
      rowsFor(GROWING_RANKS).map((r: any) => r.finish),
      ["nonfoil"],
    );
    assert.equal(one(GROWING_RANKS, "nonfoil")!.usd, "0.49");

    // Etched is its own finish, keyed off usd_etched.
    assert.deepEqual(
      rowsFor(ABADDON).map((r: any) => r.finish),
      ["etched"],
    );
    assert.equal(one(ABADDON, "etched")!.usd, "0.39");

    // Every price null: no rows at all, rather than three empty ones.
    assert.equal(rowsFor(ACERERAK).length, 0);

    // 2 (makindi: nonfoil+foil) + 1 (littjara: foil only) + 1 (growing ranks:
    // nonfoil only) + 2 (adrix) + 0 (acererak: all prices null) + 1 (abaddon:
    // etched) = 7.
    assert.equal(history.length, 7, "2 (makindi) + 1 + 1 + 2 (adrix) + 0 + 1 (abaddon)");
    assert.equal(result.priceRowsSnapshotted, 7);
  });

  it("re-snapshotting the same day overwrites rather than conflicting", async () => {
    // Two refreshes in one day must leave that day holding the latest price.
    await q("UPDATE scryfall_cards SET imported_at = now() - interval '7 days'");
    const bumped = fixture.map((card) =>
      card.id === MAKINDI ? { ...card, prices: { ...card.prices, usd: "5.55" } } : card,
    );
    server.setPayload("2026-09-08T21:05:43.649+00:00", bumped);
    await refresh();

    const rows = await q(
      "SELECT usd FROM card_price_history WHERE scryfall_id = $1 AND finish = 'nonfoil'",
      [MAKINDI],
    );
    assert.equal(rows.length, 1, "still one row for that (card, finish, day)");
    assert.equal(rows[0].usd, "0.99", "holds the price that was live going in");
  });

  it("records a failure on the import row instead of leaving it 'running'", async () => {
    server.setPayload("2026-09-15T21:05:43.649+00:00", fixture);
    await assert.rejects(
      () => refresh({ dataDir: path.join(dataDir, "sub"), bulkDataUrl: `${server.url}-nope` }),
      /404/,
    );
    const [{ n }] = await q(
      "SELECT count(*)::int AS n FROM scryfall_bulk_imports WHERE status = 'running'",
    );
    assert.equal(n, 0);
  });

  it("keeps only the current download in the data directory", async () => {
    const files = await readdir(dataDir);
    const archives = files.filter((f) => f.endsWith(".gz"));
    assert.equal(archives.length, 1, `expected one bulk file, got ${files.join(", ")}`);
    assert.match(archives[0], /^default-cards-\d+\.jsonl\.gz$/);
    assert.equal(files.filter((f) => f.endsWith(".part")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bulk-index parsing (no network, no database)
// ---------------------------------------------------------------------------

describe("bulk-data index", () => {
  const respond = (payload: unknown, ok = true) =>
    (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? "OK" : "Server Error",
        json: async () => payload,
      }) as any) as unknown as typeof fetch;

  it("prefers download_uri but accepts jsonl_download_uri", async () => {
    const withJsonl = await fetchBulkEntry("default_cards", {
      bulkDataUrl: "http://example.invalid/bulk-data",
      fetchImpl: respond({
        data: [
          {
            type: "default_cards",
            updated_at: "2026-09-01T21:05:43.649+00:00",
            jsonl_download_uri: "http://example.invalid/x.jsonl.gz",
            compressed_size: 5,
          },
        ],
      }),
    });
    assert.equal(withJsonl.downloadUri, "http://example.invalid/x.jsonl.gz");
    assert.equal(withJsonl.compressedSize, 5);

    const withLegacy = await fetchBulkEntry("default_cards", {
      bulkDataUrl: "http://example.invalid/bulk-data",
      fetchImpl: respond({
        data: [
          {
            type: "default_cards",
            updated_at: "2026-09-01T21:05:43.649+00:00",
            download_uri: "http://example.invalid/x.json",
            size: 9,
          },
        ],
      }),
    });
    assert.equal(withLegacy.downloadUri, "http://example.invalid/x.json");
  });

  it("fails clearly when the entry or its URI is missing", async () => {
    await assert.rejects(
      () =>
        fetchBulkEntry("default_cards", {
          bulkDataUrl: "http://example.invalid/bulk-data",
          fetchImpl: respond({ data: [{ type: "rulings", updated_at: "x" }] }),
        }),
      /no 'default_cards' entry in bulk data \(available: rulings\)/,
    );

    await assert.rejects(
      () =>
        fetchBulkEntry("default_cards", {
          bulkDataUrl: "http://example.invalid/bulk-data",
          fetchImpl: respond({ data: [{ type: "default_cards", updated_at: "x" }] }),
        }),
      /neither download_uri nor jsonl_download_uri/,
    );
  });
});
