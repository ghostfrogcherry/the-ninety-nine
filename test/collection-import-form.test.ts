/**
 * Tests for the browser collection-import front door.
 *
 *   npm test
 *
 * The pure tests always run. The database tests run only when
 * TEST_DATABASE_URL is set, in a throwaway database of this file's own —
 * test/_db.ts has the setup, and why it is never DATABASE_URL.
 *
 * The server actions themselves are not exercised here — they pull in
 * `next/cache` and `next/navigation`, which do not load outside a Next server.
 * Everything they actually decide is in lib/import/form.ts, which is pure and
 * is what these tests hold still.
 */

import assert from "node:assert/strict";
import { describe, it, after, before } from "node:test";

import pg from "pg";

import { SKIP_WITHOUT_DATABASE, createTestDatabase, type TestDatabase } from "./_db.ts";

/**
 * Types come from an extensionless import (erased at runtime, and resolved fine
 * by moduleResolution "bundler"); the values come from a dynamic import whose
 * specifier is a variable, which TypeScript does not try to resolve. Full type
 * checking, and it still runs under Node's type stripping, which needs the real
 * `.ts` extension. Same idiom as test/import.test.ts.
 */
import type * as FormModule from "../lib/import/form";
import type * as IssuesModule from "../lib/import/issues";
import type { ImportSummary } from "../lib/import/form";

const formSpecifier = "../lib/import/form.ts";
const issuesSpecifier = "../lib/import/issues.ts";

const {
  ERROR_PARAM, IMPORT_ERRORS, IMPORT_ERROR_TEXT, IMPORT_PARAM, IMPORT_URL_KEYS,
  MAX_ACTION_BODY_BYTES, MAX_IMPORT_BYTES, MISSED_IN_URL, MISSED_PARAM,
  MORE_PARAM, SOURCE_PARAM,
  decodeImportSummary, encodeImportSummary, isUpload, issueCount,
  parseCheckbox, parseCollectionName, parseImportError, parseImportId,
  parseLanguage, parseOnConflict, readImportSource, truncateMissed,
  unmatchedLines,
} = (await import(formSpecifier)) as typeof FormModule;

const { loadImportIssues } = (await import(issuesSpecifier)) as typeof IssuesModule;

/** A `File`-shaped stand-in. readImportSource is typed structurally so that a
 *  test does not need a DOM, a Blob or an actual file on disk. */
const upload = (name: string, text: string) => ({
  name,
  size: new TextEncoder().encode(text).length,
  text: async () => text,
});

const SUMMARY: ImportSummary = {
  dryRun: false,
  importId: 42,
  linesTotal: 1457,
  linesMatched: 1400,
  rowsWritten: 1395,
  rowsInserted: 1380,
  rowsUpdated: 15,
  cardsMatched: 1650,
  quantityDelta: 1650,
  parseErrors: 3,
  noMatch: 50,
  ambiguous: 4,
};

/* ================================================================== *
 * Pure
 * ================================================================== */

describe("form input parsing", () => {
  it("accepts every spelling an HTML checkbox produces, and nothing else", () => {
    for (const on of ["on", "true", "1"]) assert.equal(parseCheckbox(on), true);
    // An unchecked box submits no entry at all, which FormData returns as null.
    for (const off of [null, undefined, "", "off", "false", "0", "yes", 1]) {
      assert.equal(parseCheckbox(off), false);
    }
  });

  it("only lets the two real conflict modes through", () => {
    assert.equal(parseOnConflict("set"), "set");
    assert.equal(parseOnConflict("add"), "add");
    // Not coerced to a default here: the caller applies `?? "set"`, so an
    // unknown mode must be distinguishable from an absent one.
    for (const bad of ["replace", "SET", "", null, 7, {}]) {
      assert.equal(parseOnConflict(bad), null);
    }
  });

  it("takes a language code by shape, not by whitelist", () => {
    assert.equal(parseLanguage("en"), "en");
    assert.equal(parseLanguage("ZHS"), "zhs");
    assert.equal(parseLanguage(" ja "), "ja");
    // Reserving the right to a language Scryfall has not shipped yet.
    assert.equal(parseLanguage("xyz"), "xyz");
    for (const bad of ["", "e", "engl", "e n", "en;", "12", null]) {
      assert.equal(parseLanguage(bad), null);
    }
  });

  it("caps a collection name at the length the API route accepts", () => {
    assert.equal(parseCollectionName("  Main  "), "Main");
    assert.equal(parseCollectionName("x".repeat(500))?.length, 120);
    for (const bad of ["", "   ", null, 5]) assert.equal(parseCollectionName(bad), null);
  });

  it("bounds an import id at int4, because a larger one is a 500 not a miss", () => {
    assert.equal(parseImportId("42"), 42);
    assert.equal(parseImportId(2147483647), 2147483647);
    // The exact value that took /collections/2147483648 down with 22003.
    assert.equal(parseImportId("2147483648"), null);
    for (const bad of ["0", "-1", "1.5", "1e3", "", "abc", null]) {
      assert.equal(parseImportId(bad), null);
    }
  });

  it("only recognises error codes it can render a sentence for", () => {
    assert.equal(parseImportError("empty"), "empty");
    assert.equal(parseImportError("too_large"), "too_large");
    for (const bad of ["boom", "", null, 1]) assert.equal(parseImportError(bad), null);
    // Every code the parser admits must have prose, or the banner renders
    // `undefined` at the user.
    for (const code of IMPORT_ERRORS) assert.equal(typeof IMPORT_ERROR_TEXT[code], "string");
  });
});

describe("query-string namespace", () => {
  it("lists every key the feature owns", () => {
    assert.deepEqual(
      [...IMPORT_URL_KEYS].sort(),
      [IMPORT_PARAM, SOURCE_PARAM, MISSED_PARAM, MORE_PARAM, ERROR_PARAM].sort(),
    );
  });

  it("collides with none of the collection filters it shares a URL with", () => {
    // Both live in the same query string: the report strips its own keys to
    // build the dismiss link, and the page strips them before replaying the
    // filters to the browse endpoint. A name in both sets would silently drop a
    // filter on either path. Mirrors `parseFilters` in lib/collection/filters.
    const filterKeys = [
      "q", "colors", "colorless", "rarities", "types", "finishes", "set",
      "cmcMin", "cmcMax", "priceMin", "priceMax", "sort", "view", "page",
    ];
    for (const key of IMPORT_URL_KEYS) {
      assert.ok(!filterKeys.includes(key), `${key} collides with a collection filter`);
    }
  });
});

describe("choosing the import source", () => {
  it("reads an uploaded file and keeps its name for the audit row", async () => {
    const r = await readImportSource(upload("batch-02.txt", "1 Sol Ring (C19) 193\n"), "");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.text, "1 Sol Ring (C19) 193\n");
    assert.equal(r.ok && r.filename, "batch-02.txt");
  });

  it("reads a paste when no file was chosen", async () => {
    const r = await readImportSource(null, "1 Sol Ring (C19) 193");
    assert.equal(r.ok, true);
    // No filename: `collection_imports.filename` is nullable and a paste has no
    // honest name to give it.
    assert.equal(r.ok && r.filename, null);
  });

  it("ignores the empty part an untouched file input submits", async () => {
    // The regression this exists for: a user who scrolls past the file picker
    // and pastes instead still submits a zero-byte file part. Treating that as
    // a real upload rejects a perfectly good paste as empty.
    const r = await readImportSource(upload("", ""), "1 Sol Ring (C19) 193");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.text, "1 Sol Ring (C19) 193");
    assert.equal(r.ok && r.filename, null);
  });

  it("lets a file win over a paste rather than concatenating them", async () => {
    // Joining would double any printing in both, and under the default
    // onConflict "set" the doubled quantity looks like a clean import.
    const r = await readImportSource(upload("f.txt", "1 A (X) 1"), "1 A (X) 1");
    assert.equal(r.ok && r.text, "1 A (X) 1");
    assert.equal(r.ok && r.filename, "f.txt");
  });

  it("rejects an empty submission with a code, not an exception", async () => {
    for (const [file, paste] of [[null, ""], [null, "   \n\n"], [upload("f.txt", "  "), ""]] as const) {
      const r = await readImportSource(file, paste);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, "empty");
    }
  });

  it("rejects an oversized file on its declared size, without reading it", async () => {
    let read = false;
    const huge = {
      name: "huge.txt",
      size: MAX_IMPORT_BYTES + 1,
      text: async () => { read = true; return ""; },
    };
    const r = await readImportSource(huge, "");
    assert.equal(!r.ok && r.error, "too_large");
    // Pulling a 900 MB "collection export" into a string to measure it is the
    // failure this ordering prevents.
    assert.equal(read, false);
  });

  it("measures a paste in bytes, not characters", async () => {
    // "é" is two bytes in UTF-8: a string exactly at the limit by `.length` is
    // twice over it once encoded, which is how an accented export sneaks past a
    // naive check.
    const wide = "é".repeat(MAX_IMPORT_BYTES);
    assert.ok(wide.length <= MAX_IMPORT_BYTES);
    const r = await readImportSource(null, wide);
    assert.equal(!r.ok && r.error, "too_large");
  });

  it("accepts a file at the ceiling, which the browser used to refuse", async () => {
    // Browser uploads were capped at 960 KB until next.config.ts raised Next's
    // Server Action body limit. readImportSource now defaults to the ceiling
    // the HTTP route enforces, so a file one front door accepts the other must.
    const r = await readImportSource({
      name: "big.txt",
      size: MAX_IMPORT_BYTES,
      text: async () => "1 Sol Ring (C19) 193\n",
    }, "");
    assert.equal(r.ok, true);
  });

  it("recognises anything File-shaped and nothing else", () => {
    assert.equal(isUpload(upload("a", "b")), true);
    for (const bad of [null, undefined, "text", 5, {}, { size: 1 }, { text: () => "" }]) {
      assert.equal(isUpload(bad), false);
    }
  });
});

describe("the Server Action body limit", () => {
  it("leaves room for a file over the ceiling to reach the action", () => {
    // Next refuses a body over its limit with a 500 before the action runs, so
    // the limit must clear MAX_IMPORT_BYTES by enough that an export somewhat
    // over it is still refused by readImportSource, in words.
    assert.ok(MAX_ACTION_BODY_BYTES >= MAX_IMPORT_BYTES + 512 * 1024);
  });

  it("is what next.config.ts actually hands Next", async () => {
    // The constant is only half the fix. Replacing the import in next.config.ts
    // with a literal that later drifts, or dropping the key, would silently
    // bring back Next's 1 MB default and a 500 for any upload over it. The
    // config imports only the `next` types (erased) and lib/import/form.ts, so
    // it loads here without a Next server.
    const configSpecifier = "../next.config.ts";
    const { default: config } = (await import(configSpecifier)) as {
      default: { experimental?: { serverActions?: { bodySizeLimit?: unknown } } };
    };
    assert.equal(config.experimental?.serverActions?.bodySizeLimit, MAX_ACTION_BODY_BYTES);
  });
});

describe("summary round trip", () => {
  it("survives encode -> decode unchanged", () => {
    assert.deepEqual(decodeImportSummary(encodeImportSummary(SUMMARY)), SUMMARY);
  });

  it("carries a dry run, which has no import id", () => {
    const dry: ImportSummary = { ...SUMMARY, dryRun: true, importId: null };
    assert.deepEqual(decodeImportSummary(encodeImportSummary(dry)), dry);
  });

  it("keeps a negative quantity delta negative", () => {
    // `set` mode shrinking a row is a real outcome and must not read as +N.
    const shrunk: ImportSummary = { ...SUMMARY, quantityDelta: -212 };
    assert.equal(decodeImportSummary(encodeImportSummary(shrunk))?.quantityDelta, -212);
  });

  it("refuses a stale version rather than shifting every count one place", () => {
    const encoded = encodeImportSummary(SUMMARY);
    assert.equal(decodeImportSummary(encoded.replace(/^v1/, "v0")), null);
    // A field added or dropped changes the arity, which is also refused.
    assert.equal(decodeImportSummary(`${encoded}.9`), null);
    assert.equal(decodeImportSummary(encoded.split(".").slice(0, -1).join(".")), null);
  });

  it("refuses a hand-edited value instead of rendering junk", () => {
    for (const bad of ["", "v1", "nonsense", null, 5, "v1.2.-.1.1.1.1.1.1.1.1.1.1"]) {
      assert.equal(decodeImportSummary(bad), null);
    }
    const encoded = encodeImportSummary(SUMMARY);
    assert.equal(decodeImportSummary(encoded.replace(".1457.", ".x.")), null);
  });

  it("range-checks the import id, the one field that reaches SQL", () => {
    const encoded = encodeImportSummary({ ...SUMMARY, importId: 2147483647 });
    assert.equal(decodeImportSummary(encoded)?.importId, 2147483647);
    assert.equal(decodeImportSummary(encoded.replace(".2147483647.", ".2147483648.")), null);
    assert.equal(decodeImportSummary(encoded.replace(".2147483647.", ".0.")), null);
  });

  it("derives the numbers the report leads with", () => {
    assert.equal(issueCount(SUMMARY), 57);
    // 1457 lines in, 1400 resolved: the collection is 57 lines short of the
    // file, and saying so is the entire point of the report.
    assert.equal(unmatchedLines(SUMMARY), 57);
    // Never negative, even if a hand-edited URL claims more matches than lines.
    assert.equal(unmatchedLines({ ...SUMMARY, linesMatched: 9999 }), 0);
  });
});

describe("unresolved lines carried in a dry-run URL", () => {
  it("caps the list and reports the remainder", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `junk line ${i}`);
    const { shown, more } = truncateMissed(lines);
    assert.equal(shown.length, MISSED_IN_URL);
    assert.equal(more, 30 - MISSED_IN_URL);
  });

  it("truncates each line so a junk file cannot build a kilobyte redirect", () => {
    const { shown } = truncateMissed(["x".repeat(4000)]);
    assert.equal(shown[0].length, 80);
  });

  it("drops blank lines rather than listing them as failures", () => {
    const { shown, more } = truncateMissed(["  ", "", "1 Real Line"]);
    assert.deepEqual(shown, ["1 Real Line"]);
    assert.equal(more, 0);
  });
});

/* ================================================================== *
 * Database
 * ================================================================== */

describe("import issues read back", { skip: SKIP_WITHOUT_DATABASE }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let userId: number;
  let mine: number;
  let theirs: number;
  let myImport: number;
  let theirImport: number;
  const email = `import-form-test-${process.pid}-${Date.now()}@ninetynine.invalid`;

  before(async () => {
    db = await createTestDatabase("import-form");
    pool = new pg.Pool({ connectionString: db.url, max: 4 });

    const user = await pool.query(
      "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
      ["import form test", email],
    );
    userId = user.rows[0].id;

    // Two collections under one user: the predicate under test scopes by
    // collection, so proving it needs a second collection to fail against.
    const cols = await pool.query(
      `INSERT INTO collections (user_id, name)
       SELECT $1, k.n FROM unnest($2::text[]) AS k(n) RETURNING id`,
      [userId, ["Mine", "Theirs"]],
    );
    [mine, theirs] = cols.rows.map((r: { id: number }) => r.id);

    const imports = await pool.query(
      `INSERT INTO collection_imports (collection_id, source_format, filename, lines_total, status)
       SELECT k.c, 'moxfield_text', 'x.txt', 3, 'ok' FROM unnest($1::int[]) AS k(c)
       RETURNING id, collection_id`,
      [[mine, theirs]],
    );
    myImport = imports.rows.find((r: { collection_id: number }) => r.collection_id === mine).id;
    theirImport = imports.rows.find((r: { collection_id: number }) => r.collection_id === theirs).id;

    await pool.query(
      `INSERT INTO collection_import_issues (import_id, line_number, raw_line, reason, candidates)
       VALUES ($1, 9, 'nine', 'no_match', NULL),
              ($1, 2, 'two', 'ambiguous', '[{"name":"Sol Ring"}]'::jsonb),
              ($1, NULL, 'no line number', 'parse_error', NULL),
              ($2, 1, 'other collection line', 'no_match', NULL)`,
      [myImport, theirImport],
    );
  });

  after(async () => {
    // No row-by-row cleanup: the whole database goes. See test/_db.ts.
    await pool?.end();
    await db?.drop();
  });

  it("returns this import's issues in line order, nulls last", async () => {
    const rows = await loadImportIssues(pool, myImport, mine);
    assert.deepEqual(rows.map((r) => r.raw_line), ["two", "nine", "no line number"]);
    assert.equal(rows[0].reason, "ambiguous");
    // JSONB comes back parsed, which is what the report's candidate list needs.
    assert.deepEqual(rows[0].candidates, [{ name: "Sol Ring" }]);
    assert.equal(rows[2].line_number, null);
  });

  it("returns nothing for an import belonging to another collection", async () => {
    // The leak this closes: a hand-edited ?imp= would otherwise print the raw
    // lines of an import the caller has no claim to.
    assert.deepEqual(await loadImportIssues(pool, theirImport, mine), []);
  });

  it("reads a nonexistent import as empty, not as an error", async () => {
    // Same shape as "not yours", so this cannot be used to probe which import
    // ids exist.
    assert.deepEqual(await loadImportIssues(pool, 2147483647, mine), []);
  });

  it("honours the render cap", async () => {
    assert.equal((await loadImportIssues(pool, myImport, mine, 2)).length, 2);
  });
});
