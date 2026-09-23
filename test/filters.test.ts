/**
 * Collection browser filter tests — lib/collection/filters.ts.
 *
 *   npm test
 *
 * The pure tests always run. The database tests run only when
 * TEST_DATABASE_URL is set, in a throwaway database of this file's own —
 * test/_db.ts has the setup, and why it is never DATABASE_URL.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { SKIP_WITHOUT_DATABASE, createTestDatabase, type TestDatabase } from "./_db.ts";

/**
 * Types come from an extensionless import (erased at runtime, and resolved fine
 * by moduleResolution "bundler"); the values come from a dynamic import whose
 * specifier is a variable, which TypeScript does not try to resolve. Full type
 * checking, and it still runs under Node's type stripping, which needs the
 * real `.ts` extension. Same idiom as test/import.test.ts.
 */
import type * as FiltersModule from "../lib/collection/filters";
import type { Filters, SortKey, View } from "../lib/collection/filters";

const filtersSpecifier = "../lib/collection/filters.ts";

const {
  COLORS, FINISHES, IMAGE_SQL, PAGE_SIZES, RARITIES, SORT_LABELS, TYPES,
  UNIT_PRICE_SQL, buildWhere, isFiltered, parseFilters, toggleParam, withParam,
} = (await import(filtersSpecifier)) as typeof FiltersModule;

const REPO = path.resolve(import.meta.dirname, "..");

// Synthetic fixture — public card names, invented ownership, deterministic fake
// UUIDs. Regenerate with `node scripts/make-example-fixture.mjs`. Small
// (19 lines / 48 cards) but deliberately holds the awkward cases this file
// leans on: two modal-DFC lands whose type_line is "Sorcery // Land", two
// printings held in BOTH finishes at different prices, a foil-only card whose
// non-foil price is null, and a card priced at exactly "0.00".
const SEED_MIRROR = path.join(REPO, "db/seed/example-mirror.json");
const SEED_COLLECTION = path.join(REPO, "db/seed/example-collection.json");

interface MirrorCard {
  id: string; oracle_id: string; name: string; set_code: string;
  set_name: string; collector_number: string; rarity: string; layout: string;
  type_line: string; oracle_text: string; color_identity: string[];
  legalities: Record<string, string>;
  prices: Record<string, string | null>;
  finishes: string[];
}

interface SeedCard {
  n: string; sc: string; sn: string; cn: string;
  f: boolean; r: string; q: number; id: string; p: string;
}

const mirrorCards: MirrorCard[] = JSON.parse(readFileSync(SEED_MIRROR, "utf8"));
const seedCards: SeedCard[] = JSON.parse(readFileSync(SEED_COLLECTION, "utf8"));

/** Ground truth for the example fixture, as test/import.test.ts pins it. */
const TRUTH = {
  lines: 19,
  physicalCards: 48,
  foils: 3,
  distinctScryfallIds: 17,
  foilNonfoilPairs: 2,
} as const;

/** A filter object with everything at its parsed default, then overridden. */
function f(over: Partial<Filters> = {}): Filters {
  return { ...parseFilters({}), ...over };
}

/** Every `$n` in the clause, in the order it appears. */
function placeholders(where: string): number[] {
  return [...where.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
}

/* ================================================================== *
 * parseFilters
 * ================================================================== */

describe("parseFilters — shape normalisation", () => {
  it("accepts a repeated param as an array and a single one as a string", () => {
    assert.deepEqual(parseFilters({ colors: ["G", "W"] }).colors, ["W", "G"]);
    assert.deepEqual(parseFilters({ colors: "G" }).colors, ["G"]);
  });

  it("splits comma-separated values inside one param", () => {
    assert.deepEqual(parseFilters({ colors: "G,W" }).colors, ["W", "G"]);
    assert.deepEqual(parseFilters({ types: "Land,Creature" }).types, ["Creature", "Land"]);
  });

  it("mixes the two forms — repeated params that are themselves comma lists", () => {
    assert.deepEqual(
      parseFilters({ rarities: ["common,rare", "mythic"] }).rarities,
      ["common", "rare", "mythic"],
    );
  });

  it("returns values in the module's canonical order, not the URL's", () => {
    // The output is `allowed.filter(...)`, so it is stable regardless of how
    // the user happened to order the query string. Two URLs that mean the same
    // thing therefore build the same SQL and the same bind list.
    assert.deepEqual(
      parseFilters({ rarities: "mythic,common" }).rarities,
      parseFilters({ rarities: "common,mythic" }).rarities,
    );
    assert.deepEqual(parseFilters({ rarities: "mythic,common" }).rarities, ["common", "mythic"]);
  });

  it("de-duplicates", () => {
    assert.deepEqual(parseFilters({ colors: ["G", "G", "G"] }).colors, ["G"]);
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseFilters({ colors: " G , W " }).colors, ["W", "G"]);
    assert.equal(parseFilters({ q: "  sol ring  " }).q, "sol ring");
    assert.equal(parseFilters({ set: " znr " }).set, "znr");
  });

  it("takes the first element when a scalar param is repeated", () => {
    assert.equal(parseFilters({ set: ["znr", "bro"] }).set, "znr");
  });

  it("treats a missing param and an empty array alike", () => {
    assert.deepEqual(parseFilters({}), parseFilters({ q: [], colors: [], set: undefined }));
  });
});

describe("parseFilters — the whitelist drops garbage", () => {
  it("keeps only `common` from `?rarities=common,' OR 1=1`", () => {
    // The literal decoded value of ?rarities=common,%27%20OR%201=1
    const parsed = parseFilters({ rarities: "common,' OR 1=1" });
    assert.deepEqual(parsed.rarities, ["common"]);
  });

  it("drops every unknown value in each whitelisted list param", () => {
    const parsed = parseFilters({
      colors: ["W", "Z", "'; DROP TABLE collection_cards; --", "green"],
      rarities: ["mythic", "legendary", "*"],
      types: ["Land", "Tribal", "1=1"],
      finishes: ["foil", "holographic"],
    });
    assert.deepEqual(parsed.colors, ["W"]);
    assert.deepEqual(parsed.rarities, ["mythic"]);
    assert.deepEqual(parsed.types, ["Land"]);
    assert.deepEqual(parsed.finishes, ["foil"]);
  });

  it("yields an empty list, not a partial one, when nothing is recognised", () => {
    const parsed = parseFilters({ colors: "z,y,x", rarities: "nope", types: "junk" });
    assert.deepEqual(parsed.colors, []);
    assert.deepEqual(parsed.rarities, []);
    assert.deepEqual(parsed.types, []);
  });

  it("is case-sensitive — the whitelists are exact", () => {
    // Lowercase colour codes and lowercase type names are not in the tables, so
    // they are dropped rather than silently coerced.
    assert.deepEqual(parseFilters({ colors: "g" }).colors, []);
    assert.deepEqual(parseFilters({ types: "land" }).types, []);
    assert.deepEqual(parseFilters({ rarities: "COMMON" }).rarities, []);
  });

  it("accepts every documented member of each whitelist", () => {
    assert.deepEqual(parseFilters({ colors: COLORS.join(",") }).colors, [...COLORS]);
    assert.deepEqual(parseFilters({ rarities: RARITIES.join(",") }).rarities, [...RARITIES]);
    assert.deepEqual(parseFilters({ types: TYPES.join(",") }).types, [...TYPES]);
    assert.deepEqual(parseFilters({ finishes: FINISHES.join(",") }).finishes, [...FINISHES]);
  });
});

describe("parseFilters — scalars", () => {
  it("truncates q at 100 characters", () => {
    const long = "x".repeat(250);
    assert.equal(parseFilters({ q: long }).q.length, 100);
    assert.equal(parseFilters({ q: long }).q, "x".repeat(100));
    // Exactly 100 is untouched.
    assert.equal(parseFilters({ q: "y".repeat(100) }).q, "y".repeat(100));
  });

  it("truncates set at 10 characters", () => {
    assert.equal(parseFilters({ set: "abcdefghijklmnop" }).set, "abcdefghij");
  });

  it("does not sanitise q or set beyond length — they are parameterised, not escaped", () => {
    // Deliberate: escaping is the wrong fix. buildWhere binds these, and the
    // SQL-shape tests below prove the value never reaches the clause text.
    const nasty = "'; DROP TABLE collection_cards; --";
    assert.equal(parseFilters({ q: nasty }).q, nasty);
  });

  it("clamps page to >= 1", () => {
    assert.equal(parseFilters({ page: "5" }).page, 5);
    assert.equal(parseFilters({ page: "1" }).page, 1);
    assert.equal(parseFilters({ page: "0" }).page, 1);
    assert.equal(parseFilters({ page: "-9" }).page, 1);
    assert.equal(parseFilters({ page: "" }).page, 1);
    assert.equal(parseFilters({}).page, 1);
  });

  it("truncates a fractional page rather than producing a fractional OFFSET", () => {
    assert.equal(parseFilters({ page: "2.9" }).page, 2);
    assert.equal(parseFilters({ page: "0.5" }).page, 1);
  });

  it("falls back to page 1 for non-numeric and non-finite page values", () => {
    for (const bad of ["abc", "NaN", "Infinity", "-Infinity", "1e999", "'; --"]) {
      assert.equal(parseFilters({ page: bad }).page, 1, `page=${bad}`);
    }
  });

  it("parses the numeric ranges, and leaves an absent one null", () => {
    const parsed = parseFilters({ cmcMin: "0", cmcMax: "7.5", priceMin: "0.35" });
    assert.equal(parsed.cmcMin, 0);
    assert.equal(parsed.cmcMax, 7.5);
    assert.equal(parsed.priceMin, 0.35);
    assert.equal(parsed.priceMax, null);
  });

  it("nulls a non-numeric range bound instead of passing NaN to SQL", () => {
    const parsed = parseFilters({ cmcMin: "three", priceMax: "$5", cmcMax: "Infinity" });
    assert.equal(parsed.cmcMin, null);
    assert.equal(parsed.priceMax, null);
    assert.equal(parsed.cmcMax, null);
  });

  it("keeps a zero bound — 0 is a filter, absent is not", () => {
    assert.equal(parseFilters({ cmcMin: "0" }).cmcMin, 0);
    assert.equal(parseFilters({ priceMin: "0" }).priceMin, 0);
    assert.equal(parseFilters({ cmcMin: "" }).cmcMin, null);
  });

  it("defaults view to grid and accepts only `table` as the alternative", () => {
    assert.equal(parseFilters({}).view, "grid");
    assert.equal(parseFilters({ view: "table" }).view, "table");
    assert.equal(parseFilters({ view: "grid" }).view, "grid");
    assert.equal(parseFilters({ view: "list" }).view, "grid");
    assert.equal(parseFilters({ view: "TABLE" }).view, "grid");
    assert.equal(parseFilters({ view: "" }).view, "grid");
  });

  it("reads colorless only from the exact string `1`", () => {
    assert.equal(parseFilters({ colorless: "1" }).colorless, true);
    assert.equal(parseFilters({ colorless: "0" }).colorless, false);
    assert.equal(parseFilters({ colorless: "true" }).colorless, false);
    assert.equal(parseFilters({}).colorless, false);
  });

  it("falls back to `name` for an unknown sort key", () => {
    assert.equal(parseFilters({ sort: "rarity" }).sort, "rarity");
    assert.equal(parseFilters({ sort: "totally_unknown" }).sort, "name");
    assert.equal(parseFilters({ sort: "" }).sort, "name");
    assert.equal(parseFilters({}).sort, "name");
    assert.equal(parseFilters({ sort: "name; DROP TABLE collection_cards" }).sort, "name");
    assert.equal(parseFilters({ sort: "price_desc, (SELECT 1)" }).sort, "name");
  });

  it("accepts every key advertised in SORT_LABELS", () => {
    for (const [key] of SORT_LABELS) {
      assert.equal(parseFilters({ sort: key }).sort, key, `sort=${key}`);
    }
  });

  it("defaults everything when handed a completely empty query string", () => {
    assert.deepEqual(parseFilters({}), {
      q: "", colors: [], colorless: false, rarities: [], types: [], finishes: [],
      set: "", cmcMin: null, cmcMax: null, priceMin: null, priceMax: null,
      sort: "name", view: "grid", page: 1,
    });
  });
});

/* ================================================================== *
 * buildWhere — the security property
 * ================================================================== */

describe("buildWhere — every user value is parameterised", () => {
  it("binds the collection id as $1 and nothing else when unfiltered", () => {
    const built = buildWhere(f(), 42);
    assert.equal(built.where, "cc.collection_id = $1");
    assert.deepEqual(built.params, [42]);
  });

  it("numbers placeholders 1..n, each appearing exactly once, in bind order", () => {
    const built = buildWhere(
      f({
        q: "goblin", colors: ["G"], colorless: true, rarities: ["rare"],
        finishes: ["foil"], set: "ZNR", types: ["Land", "Creature"],
        cmcMin: 1, cmcMax: 6, priceMin: 0.1, priceMax: 99,
      }),
      7,
    );
    const seen = placeholders(built.where);
    // Order of first appearance is 1,2,3,... — the clause is assembled in the
    // same order as the bind list, which is what makes positional binding safe.
    assert.deepEqual(seen, seen.map((_, i) => i + 1));
    assert.equal(seen.length, built.params.length);
    assert.equal(new Set(seen).size, seen.length, "each $n must appear exactly once");
  });

  it("lines the bind list up positionally with the placeholders", () => {
    const built = buildWhere(
      f({
        q: "goblin", colors: ["G", "W"], colorless: true, rarities: ["rare", "mythic"],
        finishes: ["foil"], set: "ZNR", types: ["Land", "Creature"],
        cmcMin: 1, cmcMax: 6, priceMin: 0.1, priceMax: 99,
      }),
      7,
    );
    assert.deepEqual(built.params, [
      7,                    // $1  collection id
      "%goblin%",           // $2  name ILIKE
      "%goblin%",           // $3  type_line ILIKE
      ["G", "W"],           // $4  color_identity &&
      ["rare", "mythic"],   // $5  rarity = ANY
      ["foil"],             // $6  finish = ANY
      "znr",                // $7  set_code (lowercased)
      "%Land%",             // $8  type_line ILIKE
      "%Creature%",         // $9  type_line ILIKE
      1,                    // $10 cmc >=
      6,                    // $11 cmc <=
      0.1,                  // $12 unit price >=
      99,                   // $13 unit price <=
    ]);
  });

  it("puts no user value into the clause text", () => {
    const q = "'; DROP TABLE collection_cards; --";
    const set = "z')--";
    const built = buildWhere(f({ q, set, cmcMin: 1234.5, priceMax: 6789 }), 1);

    assert.ok(!built.where.includes(q), "q leaked into the clause");
    assert.ok(!built.where.includes(set), "set leaked into the clause");
    assert.ok(!built.where.includes("DROP"), "attacker text leaked into the clause");
    assert.ok(!built.where.includes("1234.5"), "a numeric bound was interpolated");
    assert.ok(!built.where.includes("6789"), "a numeric bound was interpolated");
    // ...and the values are all still present, in the bind list where they belong.
    assert.ok(built.params.includes(`%${q}%`));
    assert.ok(built.params.includes("z')--"));
    assert.ok(built.params.includes(1234.5));
  });

  it("produces a byte-identical clause for two filters that differ only in user VALUES", () => {
    // The strongest form of the property: the SQL text is a function of the
    // filter SHAPE alone. If any value could reach the clause, these would
    // differ. Only the bind lists may differ.
    const shape = {
      colors: ["G", "W"], colorless: true, rarities: ["rare"], finishes: ["foil"],
      types: ["Land", "Creature"], cmcMin: 0, cmcMax: 1, priceMin: 2, priceMax: 3,
    };
    const benign = buildWhere(f({ ...shape, q: "goblin", set: "znr" }), 1);
    const hostile = buildWhere(
      f({
        ...shape,
        q: "') OR 1=1 UNION SELECT password_hash FROM users --",
        set: "'; --",
        cmcMin: 999, cmcMax: -1, priceMin: 1e9, priceMax: 0,
      }),
      99999,
    );
    assert.equal(hostile.where, benign.where);
    assert.equal(hostile.params.length, benign.params.length);
    assert.notDeepEqual(hostile.params, benign.params);
  });

  it("emits only the clauses that are actually filtered", () => {
    assert.equal(buildWhere(f({ q: "x" }), 1).params.length, 3);
    assert.equal(buildWhere(f({ colors: ["G"] }), 1).params.length, 2);
    assert.equal(buildWhere(f({ colorless: true }), 1).params.length, 1, "colorless binds nothing");
    assert.equal(buildWhere(f({ types: ["Land", "Creature", "Instant"] }), 1).params.length, 4);
    // page / view / sort are not WHERE concerns.
    assert.equal(buildWhere(f({ page: 9, view: "table", sort: "rarity" }), 1).params.length, 1);
  });

  it("lowercases the set code for the comparison rather than relying on the caller", () => {
    const built = buildWhere(f({ set: "ZNR" }), 1);
    assert.deepEqual(built.params, [1, "znr"]);
  });

  it("wraps q in % on both sides so it is a substring match, not a prefix", () => {
    const built = buildWhere(f({ q: "ring" }), 1);
    assert.deepEqual(built.params.slice(1), ["%ring%", "%ring%"]);
    assert.match(built.where, /s\.name ILIKE \$2 OR s\.type_line ILIKE \$3/);
  });

  it("ORs colour identity with the independent colourless toggle", () => {
    const both = buildWhere(f({ colors: ["G"], colorless: true }), 1);
    assert.match(both.where, /s\.color_identity && \$2::text\[\] OR s\.color_identity = '\{\}'::text\[\]/);

    const onlyColors = buildWhere(f({ colors: ["G"] }), 1);
    assert.ok(!onlyColors.where.includes("'{}'::text[]"));

    const onlyColorless = buildWhere(f({ colorless: true }), 1);
    assert.match(onlyColorless.where, /s\.color_identity = '\{\}'::text\[\]/);
    assert.ok(!onlyColorless.where.includes("&&"));
  });

  it("uses overlap (&&) for colours, never containment", () => {
    // A Golgari card must show up under a Green filter. `@>` or `=` here would
    // silently hide every multicolour card.
    const built = buildWhere(f({ colors: ["G"] }), 1);
    assert.ok(built.where.includes("&&"));
    assert.ok(!built.where.includes("@>"));
    assert.ok(!built.where.includes("<@"));
  });

  it("ORs the type clauses and matches the whole type_line", () => {
    const built = buildWhere(f({ types: ["Land", "Creature"] }), 1);
    assert.match(built.where, /\(s\.type_line ILIKE \$2 OR s\.type_line ILIKE \$3\)/);
    assert.deepEqual(built.params.slice(1), ["%Land%", "%Creature%"]);
    // Leading % is what makes `Sorcery // Land` match Land.
    assert.ok(built.params.every((p) => typeof p !== "string" || !p.startsWith("Land")));
  });

  it("uses the finish-aware price expression for both price bounds", () => {
    const built = buildWhere(f({ priceMin: 1, priceMax: 2 }), 1);
    assert.equal(built.where.split("CASE cc.finish").length - 1, 2);
    assert.ok(built.where.includes("usd_foil"));
    assert.ok(built.where.includes("usd_etched"));
  });

  it("always constrains the collection, so a filter cannot widen the scope", () => {
    for (const filters of [f(), f({ q: "x" }), f({ colorless: true }), f({ page: 4 })]) {
      const built = buildWhere(filters, 5);
      assert.ok(built.where.startsWith("cc.collection_id = $1"));
      assert.equal(built.params[0], 5);
    }
  });
});

/* ================================================================== *
 * Sort whitelist
 * ================================================================== */

describe("sort keys resolve only to whitelisted ORDER BY fragments", () => {
  /** Every fragment the module is willing to emit. */
  const fragments = new Set(
    SORT_LABELS.map(([key]) => buildWhere(f({ sort: key }), 1).orderBy),
  );

  it("gives each advertised key a distinct, non-empty fragment", () => {
    assert.equal(fragments.size, SORT_LABELS.length);
    for (const frag of fragments) {
      assert.equal(typeof frag, "string");
      assert.ok(frag.length > 0);
    }
  });

  it("emits fragments that mention only known columns and no user text", () => {
    for (const frag of fragments) {
      // Only s.* / cc.* columns, the unit_price alias, and SQL keywords.
      const identifiers = [...frag.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)].map((m) => m[0]);
      const allowed = new Set([
        "s", "cc", "name", "set_code", "collector_number", "cmc", "rarity",
        "quantity", "added_at", "unit_price", "s.name", "s.set_code",
        "s.collector_number", "s.cmc", "s.rarity", "cc.quantity", "cc.added_at",
        "ASC", "DESC", "NULLS", "LAST", "CASE", "WHEN", "THEN", "ELSE", "END",
        "mythic", "rare", "uncommon", "common",
        // The price sorts inline UNIT_PRICE_SQL rather than referencing the
        // `unit_price` SELECT alias. That is deliberate: the pages cast that
        // alias to ::text so it serialises into the client feed, and ordering
        // by a text alias sorted lexically -- "9.90" above "36.12". These are
        // the identifiers that expression legitimately contains.
        "cc.finish", "finish", "s.prices", "prices", "numeric", "usd", "usd_foil",
        "usd_etched", "foil", "etched",
      ]);
      for (const id of identifiers) {
        assert.ok(allowed.has(id), `unexpected identifier ${id} in ORDER BY fragment`);
      }
      assert.ok(!frag.includes(";"), "a fragment must not contain a statement separator");
      assert.ok(!frag.includes("--"), "a fragment must not contain a comment");
    }
  });

  it("orders rarity by meaning, not alphabetically", () => {
    const frag = buildWhere(f({ sort: "rarity" }), 1).orderBy;
    assert.match(frag, /CASE s\.rarity/);
    // Alphabetical would put common before mythic; the CASE must not.
    assert.ok(frag.indexOf("'mythic'") < frag.indexOf("'common'"));
  });

  it("sorts price NULLS LAST in BOTH directions", () => {
    // Asserts the PROPERTY, not the spelling. The fragment used to reference the
    // `unit_price` SELECT alias; it now inlines the numeric expression, because
    // the pages cast that alias to ::text and ordering by text sorted "9.90"
    // above "36.12". Pinning the alias name would have failed the fix.
    assert.match(buildWhere(f({ sort: "price_asc" }), 1).orderBy, /ASC NULLS LAST/);
    assert.match(buildWhere(f({ sort: "price_desc" }), 1).orderBy, /DESC NULLS LAST/);
  });

  it("orders price by a numeric expression, never a text alias", () => {
    // The regression guard for the bug above: ::numeric must appear, and the
    // bare `unit_price` alias must not be what is ordered on.
    for (const key of ["price_asc", "price_desc"] as const) {
      const frag = buildWhere(f({ sort: key }), 1).orderBy;
      assert.match(frag, /::numeric/, `${key} must sort on the numeric expression`);
      assert.ok(
        !/^\s*unit_price\s+(ASC|DESC)/.test(frag),
        `${key} must not order on the unit_price alias — callers cast it to ::text`,
      );
    }
  });

  it("falls back to the name fragment for an unknown key, end to end", () => {
    const nameFragment = buildWhere(f({ sort: "name" }), 1).orderBy;
    for (const attack of [
      "totally_unknown",
      "name; DROP TABLE collection_cards; --",
      "1",
      "(SELECT 1)",
      "s.name; DELETE FROM users",
      "",
    ]) {
      const filters = parseFilters({ sort: attack });
      assert.equal(filters.sort, "name", `sort=${attack} was not rejected by parseFilters`);
      assert.equal(buildWhere(filters, 1).orderBy, nameFragment, `sort=${attack}`);
    }
  });

  // Regression guard. This WAS a live bug: `sort in SORTS` walks the prototype
  // chain, so ?sort=constructor passed the whitelist and was interpolated into
  // ORDER BY as "function Object() { [native code] }". Postgres raised a syntax
  // error and the collection page and browse API both returned 500 — reachable
  // by anyone who could load the page. Fixed with Object.hasOwn plus a
  // null-prototype SORTS table; this test fails again if either is undone.
  it(
    "Object.prototype keys cannot escape the sort whitelist",
    () => {
      const fragments = new Set(SORT_LABELS.map(([k]) => buildWhere(f({ sort: k }), 1).orderBy));
      for (const key of [
        "constructor", "toString", "valueOf", "hasOwnProperty",
        "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__proto__",
      ]) {
        const filters = parseFilters({ sort: key });
        const orderBy = buildWhere(filters, 1).orderBy;
        assert.ok(
          fragments.has(orderBy),
          `sort=${key} produced a non-whitelisted ORDER BY: ${String(orderBy)}`,
        );
      }
    },
  );
});

/* ================================================================== *
 * withParam / toggleParam
 * ================================================================== */

describe("withParam", () => {
  it("sets a key that was absent", () => {
    assert.equal(withParam({}, "set", "znr"), "?set=znr");
  });

  it("replaces a key that was present rather than appending a second copy", () => {
    assert.equal(withParam({ set: "bro" }, "set", "znr"), "?set=znr");
    assert.equal(withParam({ colors: ["G", "W"] }, "colors", "R"), "?colors=R");
  });

  it("removes a key when the value is null", () => {
    assert.equal(withParam({ set: "znr" }, "set", null), "");
    assert.equal(withParam({ set: "znr", view: "table" }, "set", null), "?view=table");
  });

  it("writes an array as repeated params, not a comma list", () => {
    assert.equal(withParam({}, "types", ["Land", "Creature"]), "?types=Land&types=Creature");
  });

  it("percent-encodes, so a hostile value cannot break out of the query string", () => {
    const url = withParam({}, "q", "a&b=c#d ' \"");
    assert.ok(!url.slice(1).includes("&b="), "an ampersand was not encoded");
    assert.ok(!url.includes("#"), "a fragment marker was not encoded");
    // Round-trips back to exactly what went in.
    assert.equal(new URLSearchParams(url.slice(1)).get("q"), "a&b=c#d ' \"");
  });

  it("preserves the other params", () => {
    const url = withParam({ q: "sol", colors: ["G", "W"], view: "table" }, "set", "znr");
    const sp = new URLSearchParams(url.slice(1));
    assert.equal(sp.get("q"), "sol");
    assert.deepEqual(sp.getAll("colors"), ["G", "W"]);
    assert.equal(sp.get("view"), "table");
    assert.equal(sp.get("set"), "znr");
  });

  it("drops empty existing values instead of emitting `key=`", () => {
    assert.equal(withParam({ q: "", set: "znr" }, "view", "table"), "?set=znr&view=table");
  });

  it("returns an empty string, not a bare `?`, when nothing is left", () => {
    assert.equal(withParam({}, "set", null), "");
    assert.equal(withParam({ set: "znr" }, "set", null), "");
  });

  it("RESETS page when any non-page key changes", () => {
    // Narrowing a filter while on page 9 must not strand the user on an empty
    // page. Every one of these is a narrowing action.
    for (const key of ["q", "colors", "colorless", "rarities", "types", "finishes",
      "set", "cmcMin", "cmcMax", "priceMin", "priceMax", "sort", "view"]) {
      const url = withParam({ page: "9", q: "sol" }, key, "x");
      assert.equal(
        new URLSearchParams(url.slice(1)).get("page"), null,
        `changing ${key} did not reset page`,
      );
    }
  });

  it("resets page even when the key is being REMOVED, not set", () => {
    const url = withParam({ page: "9", set: "znr" }, "set", null);
    assert.equal(new URLSearchParams(url.slice(1)).get("page"), null);
  });

  it("does NOT reset page when page itself changes", () => {
    const url = withParam({ page: "9", q: "sol" }, "page", "10");
    const sp = new URLSearchParams(url.slice(1));
    assert.equal(sp.get("page"), "10");
    assert.equal(sp.get("q"), "sol");
    assert.deepEqual(sp.getAll("page"), ["10"], "page must not be duplicated");
  });

  it("can clear page explicitly", () => {
    assert.equal(withParam({ page: "9" }, "page", null), "");
  });

  it("round-trips through parseFilters", () => {
    const url = withParam({ page: "9" }, "rarities", ["rare", "mythic"]);
    const sp = new URLSearchParams(url.slice(1));
    const raw: Record<string, string | string[]> = {};
    for (const key of new Set(sp.keys())) {
      const all = sp.getAll(key);
      raw[key] = all.length > 1 ? all : all[0];
    }
    const parsed = parseFilters(raw);
    assert.deepEqual(parsed.rarities, ["rare", "mythic"]);
    assert.equal(parsed.page, 1, "page must have been reset by the filter change");
  });
});

describe("toggleParam", () => {
  it("adds a value that is not present", () => {
    assert.equal(toggleParam({}, "types", "Land"), "?types=Land");
    assert.equal(toggleParam({ types: "Creature" }, "types", "Land"), "?types=Creature&types=Land");
  });

  it("removes a value that is present", () => {
    assert.equal(toggleParam({ types: ["Creature", "Land"] }, "types", "Land"), "?types=Creature");
  });

  it("removes the key entirely when the last value is toggled off", () => {
    assert.equal(toggleParam({ types: "Land" }, "types", "Land"), "");
  });

  it("is its own inverse", () => {
    const start = { types: ["Creature", "Land"], view: "table" };
    const off = toggleParam(start, "types", "Land");
    const offParams: Record<string, string | string[]> = {};
    const sp = new URLSearchParams(off.slice(1));
    for (const key of new Set(sp.keys())) {
      const all = sp.getAll(key);
      offParams[key] = all.length > 1 ? all : all[0];
    }
    const back = toggleParam(offParams, "types", "Land");
    const backSp = new URLSearchParams(back.slice(1));
    assert.deepEqual(backSp.getAll("types").sort(), ["Creature", "Land"]);
    assert.equal(backSp.get("view"), "table");
  });

  it("understands a comma-packed existing value", () => {
    assert.equal(toggleParam({ types: "Creature,Land" }, "types", "Land"), "?types=Creature");
    assert.equal(
      toggleParam({ types: "Creature,Land" }, "types", "Instant"),
      "?types=Creature&types=Land&types=Instant",
    );
  });

  it("RESETS page — toggling a filter is a narrowing action", () => {
    const on = toggleParam({ page: "9" }, "types", "Land");
    assert.equal(new URLSearchParams(on.slice(1)).get("page"), null);
    const off = toggleParam({ page: "9", types: "Land" }, "types", "Land");
    assert.equal(new URLSearchParams(off.slice(1)).get("page"), null);
  });

  it("leaves other keys untouched", () => {
    const url = toggleParam({ q: "sol", colors: "G", types: "Creature" }, "types", "Land");
    const sp = new URLSearchParams(url.slice(1));
    assert.equal(sp.get("q"), "sol");
    assert.equal(sp.get("colors"), "G");
    assert.deepEqual(sp.getAll("types"), ["Creature", "Land"]);
  });
});

/* ================================================================== *
 * isFiltered
 * ================================================================== */

describe("isFiltered", () => {
  it("is false when nothing is set", () => {
    assert.equal(isFiltered(f()), false);
  });

  it("is false for sort, view and page alone — they do not narrow the set", () => {
    assert.equal(isFiltered(f({ sort: "rarity" })), false);
    assert.equal(isFiltered(f({ view: "table" })), false);
    assert.equal(isFiltered(f({ page: 9 })), false);
    assert.equal(isFiltered(f({ sort: "price_desc", view: "table", page: 4 })), false);
  });

  it("is true for each filter individually", () => {
    const cases: Array<[string, Partial<Filters>]> = [
      ["q", { q: "sol" }],
      ["colors", { colors: ["G"] }],
      ["colorless", { colorless: true }],
      ["rarities", { rarities: ["rare"] }],
      ["types", { types: ["Land"] }],
      ["finishes", { finishes: ["foil"] }],
      ["set", { set: "znr" }],
      ["cmcMin", { cmcMin: 3 }],
      ["cmcMax", { cmcMax: 3 }],
      ["priceMin", { priceMin: 1 }],
      ["priceMax", { priceMax: 1 }],
    ];
    for (const [label, over] of cases) {
      assert.equal(isFiltered(f(over)), true, `${label} alone should read as filtered`);
    }
    // Every field of Filters is either covered above or deliberately excluded.
    const covered = new Set(cases.map(([label]) => label));
    for (const key of Object.keys(f())) {
      assert.ok(
        covered.has(key) || ["sort", "view", "page"].includes(key),
        `Filters gained a field \`${key}\` that isFiltered is not tested for`,
      );
    }
  });

  it("treats a zero bound as a filter — 0 is not `absent`", () => {
    assert.equal(isFiltered(f({ cmcMin: 0 })), true);
    assert.equal(isFiltered(f({ cmcMax: 0 })), true);
    assert.equal(isFiltered(f({ priceMin: 0 })), true);
    assert.equal(isFiltered(f({ priceMax: 0 })), true);
  });

  it("agrees with buildWhere — filtered iff the clause does more than scope the collection", () => {
    const cases: Partial<Filters>[] = [
      {}, { q: "x" }, { colors: ["G"] }, { colorless: true }, { rarities: ["rare"] },
      { types: ["Land"] }, { finishes: ["foil"] }, { set: "znr" }, { cmcMin: 0 },
      { cmcMax: 9 }, { priceMin: 0 }, { priceMax: 9 }, { sort: "rarity" },
      { view: "table" }, { page: 3 },
    ];
    for (const over of cases) {
      const filters = f(over);
      const extraClauses = buildWhere(filters, 1).where !== "cc.collection_id = $1";
      assert.equal(
        isFiltered(filters), extraClauses,
        `isFiltered disagrees with buildWhere for ${JSON.stringify(over)}`,
      );
    }
  });
});

describe("PAGE_SIZES", () => {
  it("covers both views with a positive integer", () => {
    for (const view of ["grid", "table"] as View[]) {
      assert.equal(Number.isInteger(PAGE_SIZES[view]), true);
      assert.ok(PAGE_SIZES[view] > 0);
    }
    assert.deepEqual(PAGE_SIZES, { grid: 60, table: 250 });
  });
});

/* ================================================================== *
 * Database — the SQL actually runs, and returns the right rows
 * ================================================================== */

describe("filters against postgres", { skip: SKIP_WITHOUT_DATABASE }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let userId: number;
  /** The fixture exactly: 19 rows / 48 cards / 3 foils / 17 ids. */
  let collectionId: number;
  /** A small hand-picked set used only for the NULL-price sort tests. */
  let priceCollectionId: number;
  const email = `filters-test-${process.pid}-${Date.now()}@ninetynine.invalid`;

  const byName = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

  /** Run the browser's real query for a filter set and return the rows. */
  async function browse(
    filters: Filters,
    cid: number,
  ): Promise<Array<{
    scryfall_id: string; quantity: number; finish: string; name: string;
    set_code: string; type_line: string; rarity: string; color_identity: string[];
    unit_price: string | null; image: string | null;
  }>> {
    const { where, params, orderBy } = buildWhere(filters, cid);
    // Byte-for-byte the shape app/collections/[id]/page.tsx and
    // app/api/collections/[id]/browse/route.ts run.
    const res = await pool.query(
      `SELECT cc.scryfall_id::text AS scryfall_id, cc.quantity, cc.finish,
              s.name, s.set_code, s.collector_number, s.rarity, s.type_line, s.cmc,
              s.color_identity,
              ${IMAGE_SQL} AS image,
              ${UNIT_PRICE_SQL}::text AS unit_price
         FROM collection_cards cc
         LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
        WHERE ${where}
        ORDER BY ${orderBy}`,
      params,
    );
    return res.rows;
  }

  before(async () => {
    db = await createTestDatabase("filters");
    pool = new pg.Pool({ connectionString: db.url, max: 4 });

    // The mirror fixture, loaded as-is. `cmc` is absent from the fixture and so
    // stays NULL — see the cmc test below, which asserts what that means rather
    // than inventing mana values.
    for (const c of mirrorCards) {
      await pool.query(
        `INSERT INTO scryfall_cards
           (id, oracle_id, name, set_code, set_name, collector_number, rarity,
            layout, type_line, oracle_text, color_identity, legalities, prices, finishes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13::jsonb,$14::text[])
         ON CONFLICT (id) DO NOTHING`,
        [
          c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number,
          c.rarity, c.layout, c.type_line, c.oracle_text, c.color_identity,
          JSON.stringify(c.legalities), JSON.stringify(c.prices), c.finishes,
        ],
      );
    }

    const user = await pool.query(
      "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
      ["filters test", email],
    );
    userId = user.rows[0].id;

    const collection = await pool.query(
      "INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id",
      [userId, "Filters test"],
    );
    collectionId = collection.rows[0].id;

    for (const c of seedCards) {
      await pool.query(
        `INSERT INTO collection_cards (collection_id, scryfall_id, quantity, finish)
         VALUES ($1, $2, $3, $4)`,
        [collectionId, c.id, c.q, c.f ? "foil" : "nonfoil"],
      );
    }

    // A second collection whose only job is to contain rows with a NULL
    // finish-aware price. The fixture holds no such row by accident, so build
    // one deliberately out of fixture cards:
    //   Arahbo   nonfoil -> prices.usd      is null
    //   Sol Ring foil    -> prices.usd_foil is null
    // plus three priced rows including one at exactly 0.00, to prove 0 is not
    // being confused with NULL.
    const price = await pool.query(
      "INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id",
      [userId, "Price sort test"],
    );
    priceCollectionId = price.rows[0].id;
    const priceRows: Array<[string, string]> = [
      ["7549577b-19e5-4565-9b3d-686a285c312b", "nonfoil"], // Arahbo, usd null
      ["da515159-8de8-40a1-a62c-b96645939ad9", "foil"],    // Sol Ring c19, usd_foil null
      ["da515159-8de8-40a1-a62c-b96645939ad9", "nonfoil"], // 1.49
      ["b880fc18-518c-40cd-9356-5797af4c1617", "nonfoil"], // Forest, 0.10
      ["19c5899a-eef1-4dd3-a6ef-a8502cf02dc5", "nonfoil"], // Black Lotus, 0.00
    ];
    for (const [id, finish] of priceRows) {
      await pool.query(
        `INSERT INTO collection_cards (collection_id, scryfall_id, quantity, finish)
         VALUES ($1, $2, 1, $3)`,
        [priceCollectionId, id, finish],
      );
    }
  });

  after(async () => {
    // No row-by-row cleanup: the whole database goes. See test/_db.ts.
    await pool?.end();
    await db?.drop();
  });

  it("loaded the fixture at its known totals", async () => {
    const res = await pool.query(
      `SELECT count(*)::int AS rows, sum(quantity)::int AS qty,
              count(*) FILTER (WHERE finish = 'foil')::int AS foils,
              count(DISTINCT scryfall_id)::int AS ids
         FROM collection_cards WHERE collection_id = $1`,
      [collectionId],
    );
    assert.deepEqual(res.rows[0], {
      rows: TRUTH.lines,
      qty: TRUTH.physicalCards,
      foils: TRUTH.foils,
      ids: TRUTH.distinctScryfallIds,
    });
  });

  it("an unfiltered query returns the whole collection and nothing from another one", async () => {
    const rows = await browse(f(), collectionId);
    assert.equal(rows.length, TRUTH.lines);
    const other = await browse(f(), priceCollectionId);
    assert.equal(other.length, 5);
    assert.equal(
      rows.filter((r) => r.name === "Black Lotus").length, 1,
      "collection scoping leaked between collections",
    );
  });

  /* ---------------- the regression guard ---------------- */

  it("a Land type filter matches modal-DFC lands whose type_line is `Sorcery // Land`", async () => {
    const rows = await browse(f({ types: ["Land"] }), collectionId);
    const names = new Set(byName(rows));

    // The two MDFCs. Matching only the front face silently hides both, which is
    // the bug this test exists to stop coming back.
    assert.ok(names.has("Makindi Stampede // Makindi Mesas"), "MDFC land missed by the Land filter");
    assert.ok(names.has("Ondu Inversion // Ondu Skyruins"), "MDFC land missed by the Land filter");
    assert.ok(names.has("Forest"), "a plain Basic Land was missed");

    // 4 rows: Forest, Ondu, and Makindi in BOTH finishes.
    assert.equal(rows.length, 4);
    assert.equal(names.size, 3);
    for (const r of rows) assert.match(r.type_line, /Land/);

    // Prove the assertion has teeth: a front-face-only implementation would
    // have returned strictly fewer rows.
    const frontFaceOnly = rows.filter((r) => !r.type_line.split(" // ")[0].includes("Land"));
    assert.equal(frontFaceOnly.length, 3, "the MDFC rows are exactly the ones a front-face match loses");
  });

  it("the same filter still matches the front face of a split type line", async () => {
    const rows = await browse(f({ types: ["Sorcery"] }), collectionId);
    assert.deepEqual(
      byName(rows).sort(),
      [
        "Makindi Stampede // Makindi Mesas", "Makindi Stampede // Makindi Mesas",
        "Ondu Inversion // Ondu Skyruins",
      ],
    );
  });

  it("ORs multiple types rather than requiring all of them", async () => {
    const land = await browse(f({ types: ["Land"] }), collectionId);
    const instant = await browse(f({ types: ["Instant"] }), collectionId);
    const both = await browse(f({ types: ["Land", "Instant"] }), collectionId);
    assert.equal(land.length, 4);    // Forest, Ondu, Makindi x2 finishes
    assert.equal(instant.length, 3); // Involuntary Cooldown x2 finishes, Counterspell
    // Disjoint sets, so an OR is a union and an AND would have been empty.
    assert.equal(both.length, land.length + instant.length);
    assert.equal(both.length, 7);
  });

  it("matches the type substring anywhere, including after an em dash", async () => {
    const rows = await browse(f({ types: ["Creature"] }), collectionId);
    const names = new Set(byName(rows));
    assert.ok(names.has("Isamaru, Hound of Konda"), "`Legendary Creature — Dog` must match Creature");
    assert.ok(names.has("Rat Colony"));
    assert.ok(!names.has("Sol Ring"), "an Artifact must not match Creature");
  });

  /* ---------------- colours ---------------- */

  it("filters colours by OVERLAP, so a multicolour card shows under one of its colours", async () => {
    const rows = await browse(f({ colors: ["G"] }), collectionId);
    const names = new Set(byName(rows));
    assert.ok(names.has("Forest"), "mono-green missed");
    assert.ok(
      names.has("Arahbo, Roar of the World"),
      "a G/W card was hidden from a Green filter — this is subset matching, not overlap",
    );
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(r.color_identity.includes("G"));
  });

  it("ORs multiple colours", async () => {
    const rows = await browse(f({ colors: ["G", "B"] }), collectionId);
    assert.deepEqual(byName(rows).sort(), ["Arahbo, Roar of the World", "Forest", "Rat Colony"]);
  });

  it("excludes colourless cards from a colour filter", async () => {
    const rows = await browse(f({ colors: ["W", "U", "B", "R", "G"] }), collectionId);
    for (const r of rows) assert.ok(r.color_identity.length > 0);
    assert.equal(rows.length, 10); // 19 rows - 9 colourless
  });

  it("the colorless toggle is independent of the colour list", async () => {
    const colourless = await browse(f({ colorless: true }), collectionId);
    assert.equal(colourless.length, 9);
    for (const r of colourless) assert.deepEqual(r.color_identity, []);

    const green = await browse(f({ colors: ["G"] }), collectionId);
    const union = await browse(f({ colors: ["G"], colorless: true }), collectionId);
    assert.equal(union.length, green.length + colourless.length);
    assert.equal(union.length, 11);

    const names = new Set(byName(union));
    assert.ok(names.has("Sol Ring"), "colourless rows missing from the union");
    assert.ok(names.has("Arahbo, Roar of the World"), "colour rows missing from the union");
  });

  /* ---------------- finishes and finish-aware price ---------------- */

  it("the finish filter separates the foil and non-foil rows of ONE printing", async () => {
    const foils = await browse(f({ finishes: ["foil"] }), collectionId);
    const nonfoils = await browse(f({ finishes: ["nonfoil"] }), collectionId);
    assert.equal(foils.length, TRUTH.foils);
    assert.equal(nonfoils.length, TRUTH.lines - TRUTH.foils);
    assert.equal(foils.length + nonfoils.length, TRUTH.lines);

    // The two printings held in both finishes appear on BOTH sides, as the same
    // scryfall_id — that is the whole point of keying on finish.
    const foilIds = new Set(foils.map((r) => r.scryfall_id));
    const nonfoilIds = new Set(nonfoils.map((r) => r.scryfall_id));
    const inBoth = [...foilIds].filter((id) => nonfoilIds.has(id));
    assert.equal(inBoth.length, TRUTH.foilNonfoilPairs);

    assert.deepEqual(
      byName(foils).sort(),
      [
        "Arahbo, Roar of the World",
        "Involuntary Cooldown",
        "Makindi Stampede // Makindi Mesas",
      ],
    );
  });

  it("returns no rows for a finish nothing is held in", async () => {
    assert.deepEqual(await browse(f({ finishes: ["etched"] }), collectionId), []);
  });

  it("prices the foil and non-foil of one printing differently", async () => {
    const rows = await browse(f({ q: "Involuntary Cooldown" }), collectionId);
    assert.deepEqual(
      rows.map((r) => [r.finish, r.unit_price]).sort(),
      [["foil", "0.49"], ["nonfoil", "0.35"]],
    );

    const makindi = await browse(f({ q: "Makindi" }), collectionId);
    assert.deepEqual(
      makindi.map((r) => [r.finish, r.unit_price]).sort(),
      [["foil", "0.79"], ["nonfoil", "0.35"]],
    );
  });

  it("price filters use the finish-aware price, splitting one printing across the bound", async () => {
    // 0.35 non-foil vs 0.49 foil. A price ceiling of 0.40 must keep the
    // non-foil row and drop the foil row of the SAME card.
    const cheap = await browse(f({ q: "Involuntary Cooldown", priceMax: 0.4 }), collectionId);
    assert.equal(cheap.length, 1);
    assert.equal(cheap[0].finish, "nonfoil");
    assert.equal(cheap[0].unit_price, "0.35");

    const dear = await browse(f({ q: "Involuntary Cooldown", priceMin: 0.4 }), collectionId);
    assert.equal(dear.length, 1);
    assert.equal(dear[0].finish, "foil");
    assert.equal(dear[0].unit_price, "0.49");

    // Same for the 0.35 / 0.79 pair.
    const makindiCheap = await browse(f({ q: "Makindi", priceMax: 0.5 }), collectionId);
    assert.deepEqual(makindiCheap.map((r) => [r.finish, r.unit_price]), [["nonfoil", "0.35"]]);
  });

  it("applies both price bounds inclusively", async () => {
    const exact = await browse(f({ priceMin: 0.49, priceMax: 0.49 }), collectionId);
    assert.deepEqual(exact.map((r) => [r.name, r.finish]), [["Involuntary Cooldown", "foil"]]);

    const upTo = await browse(f({ priceMax: 0.35 }), collectionId);
    assert.equal(upTo.length, 8);
    for (const r of upTo) assert.ok(Number(r.unit_price) <= 0.35);
    assert.ok(
      !upTo.some((r) => r.name === "Involuntary Cooldown" && r.finish === "foil"),
      "the 0.49 foil slipped under a 0.35 ceiling",
    );
  });

  it("a NULL price is excluded by a price bound rather than treated as zero", async () => {
    const all = await browse(f(), priceCollectionId);
    assert.equal(all.filter((r) => r.unit_price === null).length, 2);
    const bounded = await browse(f({ priceMin: 0 }), priceCollectionId);
    assert.equal(bounded.length, 3, "NULL-priced rows must not satisfy `>= 0`");
    assert.ok(bounded.every((r) => r.unit_price !== null));
  });

  /* ---------------- other filters ---------------- */

  it("filters by rarity, dropping the injected value from `?rarities=common,' OR 1=1`", async () => {
    const parsed = parseFilters({ rarities: "common,' OR 1=1" });
    const rows = await browse(parsed, collectionId);
    assert.equal(rows.length, 8);
    for (const r of rows) assert.equal(r.rarity, "common");
  });

  it("filters by set, case-insensitively via the lowercase bind", async () => {
    const upper = await browse(f({ set: "ZNR" }), collectionId);
    const lower = await browse(f({ set: "znr" }), collectionId);
    assert.deepEqual(byName(upper).sort(), byName(lower).sort());
    assert.equal(upper.length, 4); // Makindi x2 finishes, Ondu, Forest
    for (const r of upper) assert.equal(r.set_code, "znr");
  });

  it("searches name OR type line with q", async () => {
    const byCardName = await browse(f({ q: "sol ring" }), collectionId);
    assert.equal(byCardName.length, 2, "two printings of Sol Ring");

    const byType = await browse(f({ q: "artifact" }), collectionId);
    const names = new Set(byName(byType));
    assert.ok(names.has("Sol Ring"));
    assert.ok(names.has("Black Lotus"), "matched on type_line, not name");
    assert.ok(names.has("Fellwar Stone"));

    // A substring in the middle of a name, not a prefix.
    assert.equal((await browse(f({ q: "olony" }), collectionId)).length, 1);
  });

  it("q is case-insensitive (ILIKE)", async () => {
    const a = await browse(f({ q: "COUNTERSPELL" }), collectionId);
    const b = await browse(f({ q: "counterspell" }), collectionId);
    assert.equal(a.length, 1);
    assert.deepEqual(byName(a), byName(b));
  });

  it("combines filters with AND", async () => {
    const rows = await browse(f({ types: ["Land"], colors: ["W"] }), collectionId);
    assert.equal(rows.length, 3); // Makindi x2 finishes + Ondu; Forest is green
    assert.ok(!byName(rows).includes("Forest"));

    const narrower = await browse(
      f({ types: ["Land"], colors: ["W"], finishes: ["foil"] }),
      collectionId,
    );
    assert.deepEqual(
      narrower.map((r) => [r.name, r.finish]),
      [["Makindi Stampede // Makindi Mesas", "foil"]],
    );
  });

  it("cmc bounds exclude rows with an unknown mana value", async () => {
    // The fixture carries no cmc, so every row is NULL there. `s.cmc >= 0` is
    // NULL for all of them, which is not TRUE — so nothing matches. That is the
    // correct SQL semantics for an unknown value, and it is what the browser
    // will do for any card whose mirror row predates a cmc.
    const none = await browse(f({ cmcMin: 0 }), collectionId);
    assert.deepEqual(none, []);
    const alsoNone = await browse(f({ cmcMax: 99 }), collectionId);
    assert.deepEqual(alsoNone, []);
  });

  /* ---------------- sorting ---------------- */

  it("sorts rarity by meaning, not alphabetically", async () => {
    const rows = await browse(f({ sort: "rarity" }), collectionId);
    assert.equal(rows.length, TRUTH.lines);
    assert.equal(
      rows[0].rarity, "mythic",
      "alphabetical ordering would have put `common` first",
    );
    assert.deepEqual(
      rows.map((r) => r.rarity),
      [
        "mythic",
        ...Array(6).fill("rare"),
        ...Array(4).fill("uncommon"),
        ...Array(8).fill("common"),
      ],
    );
    // ...and it is genuinely different from what alphabetical would produce.
    const alphabetical = [...rows].map((r) => r.rarity).sort();
    assert.notDeepEqual(rows.map((r) => r.rarity), alphabetical);
  });

  it("sorts price with NULLS LAST in BOTH directions", async () => {
    const asc = await browse(f({ sort: "price_asc" }), priceCollectionId);
    assert.deepEqual(
      asc.map((r) => r.unit_price),
      ["0.00", "0.10", "1.49", null, null],
      "ascending price must bury the unknowns at the end, not lead with them",
    );

    const desc = await browse(f({ sort: "price_desc" }), priceCollectionId);
    assert.deepEqual(
      desc.map((r) => r.unit_price),
      ["1.49", "0.10", "0.00", null, null],
      "descending price must also bury the unknowns at the end",
    );

    // The NULLs are the finish-aware ones: Arahbo has no non-foil price and the
    // C19 Sol Ring has no foil price.
    assert.deepEqual(
      asc.slice(3).map((r) => [r.name, r.finish]).sort(),
      [["Arahbo, Roar of the World", "nonfoil"], ["Sol Ring", "foil"]],
    );
    // 0.00 is a price, not an unknown, and must sort as the cheapest.
    assert.equal(asc[0].name, "Black Lotus");
  });

  it("runs every advertised sort key against real rows", async () => {
    for (const [key] of SORT_LABELS) {
      const rows = await browse(f({ sort: key as SortKey }), collectionId);
      assert.equal(rows.length, TRUTH.lines, `sort=${key} changed the row count`);
    }
  });

  it("sorts by name, then set, so the two Sol Rings are adjacent and ordered", async () => {
    const rows = await browse(f({ sort: "name" }), collectionId);
    const names = byName(rows);
    assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const solRings = rows.filter((r) => r.name === "Sol Ring");
    assert.deepEqual(solRings.map((r) => r.set_code), ["c19", "lcc"]);
  });

  it("sorts by quantity descending", async () => {
    const rows = await browse(f({ sort: "quantity" }), collectionId);
    assert.equal(rows[0].quantity, 12);
    assert.equal(rows[0].name, "Forest");
    const qty = rows.map((r) => r.quantity);
    assert.deepEqual(qty, [...qty].sort((a, b) => b - a));
  });

  it("sorts by set code then collector number", async () => {
    const rows = await browse(f({ sort: "set" }), collectionId);
    const codes = rows.map((r) => r.set_code);
    assert.deepEqual(codes, [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  /* ---------------- injection, for real ---------------- */

  it("survives a hostile query string and returns rows, not damage", async () => {
    const hostile = parseFilters({
      q: "'; DROP TABLE collection_cards; --",
      set: "') OR 1=1 --",
      rarities: "common,' OR 1=1",
      colors: "G,'; DELETE FROM users; --",
      types: "Land,1=1",
      sort: "name; DROP TABLE users",
      page: "-1",
      cmcMin: "1); DROP TABLE decks; --",
    });

    // Nothing matches, because the injection text is compared as a value.
    const rows = await browse(hostile, collectionId);
    assert.deepEqual(rows, []);

    // The whitelisted parts survived; the injected parts did not.
    assert.deepEqual(hostile.rarities, ["common"]);
    assert.deepEqual(hostile.colors, ["G"]);
    assert.deepEqual(hostile.types, ["Land"]);
    assert.equal(hostile.sort, "name");
    assert.equal(hostile.page, 1);
    assert.equal(hostile.cmcMin, null);

    // And the tables are all still there with the rows still in them.
    const survived = await pool.query(
      `SELECT count(*)::int AS n FROM collection_cards WHERE collection_id = $1`,
      [collectionId],
    );
    assert.equal(survived.rows[0].n, TRUTH.lines);
    // Named, not counted. The injection strings above each try to drop a
    // specific table, so checking for those tables by name is what this is
    // actually asserting — and a bare count breaks every time the schema
    // legitimately gains one, which says nothing about injection.
    const targeted = ["collection_cards", "users", "decks"];
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name = ANY($1::text[])`,
      [targeted],
    );
    assert.deepEqual(
      tables.rows.map((r: { table_name: string }) => r.table_name).sort(),
      [...targeted].sort(),
      "a table the query string tried to drop went missing",
    );
  });

  it("a q that is entirely SQL metacharacters is matched literally", async () => {
    // %_ are ILIKE wildcards. They are bound, not escaped, so they DO act as
    // wildcards inside the pattern — worth pinning, because it is the one place
    // a user string still has meaning to the engine.
    const everything = await browse(f({ q: "%" }), collectionId);
    assert.equal(everything.length, TRUTH.lines, "`%` is an ILIKE wildcard, by design");

    // ...but it is still only a pattern. It cannot terminate the string.
    const quote = await browse(f({ q: "' OR '1'='1" }), collectionId);
    assert.deepEqual(quote, []);
  });

  it("the image expression falls back to the first card face", async () => {
    // The fixture has no image_uris at all, so every row is NULL — the point
    // here is that the COALESCE is valid SQL against real jsonb columns and
    // does not error on a NULL card_faces.
    const rows = await browse(f(), collectionId);
    assert.equal(rows.length, TRUTH.lines);
    assert.ok(rows.every((r) => r.image === null));
  });
});
