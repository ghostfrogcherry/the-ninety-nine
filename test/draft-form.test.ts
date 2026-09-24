/**
 * The pure half of the draft pages (app/drafts/_form.ts): what the forms may
 * post, which `?err=` codes turn into sentences, and the mana arithmetic the
 * picks panel sorts on. The engine itself is lib/draft's, and tested there.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type * as FormModule from "../app/drafts/_form";

const formSpecifier = "../app/drafts/_form.ts";
const {
  DRAFT_ERRORS, DRAFT_ERROR_TEXT,
  groupPicks, inviteUrl, manaSymbols, manaValue, parseDraftError, parseSetSearch,
  passDirection, passesTo, pickCurve, pickGroup,
} = (await import(formSpecifier)) as typeof FormModule;

// The form's numbers, set code and invite slug are parsed by lib/draft's own
// helpers, which test/draft.test.ts covers; only the page's own input is here.
describe("parseSetSearch", () => {
  it("caps the set search rather than rejecting it", () => {
    assert.equal(parseSetSearch("  dominaria "), "dominaria");
    assert.equal(parseSetSearch("q".repeat(200)).length, 60);
    assert.equal(parseSetSearch(null), "");
    assert.equal(parseSetSearch(["a"]), "");
  });
});

describe("draft errors", () => {
  it("has a sentence for every code, and parses only known codes", () => {
    for (const code of DRAFT_ERRORS) {
      assert.equal(typeof DRAFT_ERROR_TEXT[code], "string");
      assert.equal(parseDraftError(code), code);
    }
    for (const bad of ["boom", "", null, 1, "NOT_FOUND", "__proto__", "toString"]) {
      assert.equal(parseDraftError(bad), null, `accepted ${String(bad)}`);
    }
  });
});

describe("passing", () => {
  it("goes left, right, left — seat+1 in the 1st and 3rd pack", () => {
    assert.equal(passDirection(0), "left");
    assert.equal(passDirection(1), "right");
    assert.equal(passDirection(2), "left");
  });

  it("wraps round the table both ways", () => {
    assert.equal(passesTo(7, 0, 8), 0);
    assert.equal(passesTo(0, 1, 8), 7);
    assert.equal(passesTo(3, 1, 8), 2);
    assert.equal(passesTo(1, 0, 2), 0);
  });
});

describe("mana", () => {
  it("splits a cost into symbols, keeping a split card's separator", () => {
    assert.deepEqual(manaSymbols("{2}{U}{U}"), ["2", "U", "U"]);
    assert.deepEqual(manaSymbols("{1}{R} // {2}{u}"), ["1", "R", "//", "2", "U"]);
    assert.deepEqual(manaSymbols(""), []);
    assert.deepEqual(manaSymbols(null), []);
  });

  it("computes mana value the way rule 202.3 does", () => {
    assert.equal(manaValue("{2}{U}{U}"), 4);
    assert.equal(manaValue("{X}{R}"), 1);
    assert.equal(manaValue("{2/W}{2/W}"), 4);
    assert.equal(manaValue("{W/U}{B}"), 2);
    assert.equal(manaValue("{G/P}"), 1);
    assert.equal(manaValue("{HW}"), 0.5);
    assert.equal(manaValue("{1}{R} // {2}{U}"), 5); // a split card adds both halves
    assert.equal(manaValue(null), 0);
    assert.equal(manaValue("{10}"), 10);
  });
});

const c = (
  name: string,
  mana_cost: string | null,
  type_line: string,
  colors: string[] | null,
) => ({ id: name.length, scryfall_id: "", rarity: "common", image: null, name, mana_cost, type_line, colors });

describe("picks grouping", () => {
  it("files by colour, multicolour and colourless", () => {
    assert.equal(pickGroup(c("Shock", "{R}", "Instant", ["R"])), "R");
    assert.equal(pickGroup(c("Boros Charm", "{R}{W}", "Instant", ["R", "W"])), "multi");
    assert.equal(pickGroup(c("Ornithopter", "{0}", "Artifact Creature — Thopter", [])), "colorless");
  });

  it("puts lands in Lands by the front face only", () => {
    assert.equal(pickGroup(c("Island", null, "Basic Land — Island", [])), "land");
    // A modal double-faced spell with a land on the back is still a spell.
    assert.equal(pickGroup(c("Emeria's Call // Emeria, Shattered Skyclave", null, "Sorcery // Land", null)), "colorless");
    assert.equal(
      pickGroup(c("Agadeem's Awakening // Agadeem, the Undercrypt", "{X}{B}{B}{B} // ", "Sorcery // Land", null)),
      "B",
    );
  });

  it("falls back to the cost when colours are unknown", () => {
    assert.equal(pickGroup(c("Delver", "{U}", "Creature", null)), "U");
    assert.equal(pickGroup(c("Hybrid", "{W/U}", "Creature", null)), "multi");
  });

  it("orders groups WUBRG then the rest, and cards by mana value then name", () => {
    const groups = groupPicks([
      c("Island", null, "Basic Land — Island", []),
      c("Big Red", "{4}{R}", "Creature", ["R"]),
      c("Shock", "{R}", "Instant", ["R"]),
      c("Abrade", "{1}{R}", "Instant", ["R"]),
      c("Opt", "{U}", "Instant", ["U"]),
      c("Bolt", "{R}", "Instant", ["R"]),
    ]);
    assert.deepEqual(groups.map((g) => g.group), ["U", "R", "land"]);
    assert.deepEqual(groups[1].cards.map((x) => x.name), ["Bolt", "Shock", "Abrade", "Big Red"]);
  });

  it("builds a curve over nonland picks, with 7+ in the last bucket", () => {
    const curve = pickCurve([
      c("Island", null, "Basic Land — Island", []),
      c("Opt", "{U}", "Instant", ["U"]),
      c("Colossus", "{11}", "Artifact Creature", []),
      c("Two", "{1}{U}", "Creature", ["U"]),
    ]);
    assert.deepEqual(curve, [0, 1, 1, 0, 0, 0, 0, 1]);
  });
});

describe("inviteUrl", () => {
  it("is absolute under AUTH_URL's base and a bare path without one", () => {
    assert.equal(inviteUrl("abcdefgh", "https://mtg.example"), "https://mtg.example/drafts/join/abcdefgh");
    assert.equal(inviteUrl("abcdefgh", null), "/drafts/join/abcdefgh");
  });
});
