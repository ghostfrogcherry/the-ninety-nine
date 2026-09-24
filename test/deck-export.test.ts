/**
 * The deck export: the text untap.in imports, and the download's filename.
 *
 *   npm test
 *
 * Pure. Types from the extensionless path, values from a dynamic import of a
 * variable `.ts` specifier — the idiom test/auth.test.ts explains.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type * as ExportModule from "../lib/deck/export";
import type { ExportCard } from "../lib/deck/export";

const exportSpecifier = "../lib/deck/export.ts";
const { deckFileDisposition, formatDeckText } = (await import(exportSpecifier)) as typeof ExportModule;

const card = (name: string, quantity: number, board: ExportCard["board"] = "main"): ExportCard =>
  ({ name, quantity, board });

describe("formatDeckText", () => {
  it("writes a Deck section, then a Sideboard section after a blank line", () => {
    const text = formatDeckText([
      card("Lightning Bolt", 4),
      card("Mountain", 17),
      card("Negate", 2, "sideboard"),
    ]);
    assert.equal(text, "Deck\n4 Lightning Bolt\n17 Mountain\n\nSideboard\n2 Negate\n");
  });

  it("puts the commander in its own section first, not in the Deck", () => {
    const text = formatDeckText([
      card("Sol Ring", 1),
      card("Arahbo, Roar of the World", 1, "commander"),
    ]);
    assert.equal(text, "Commander\n1 Arahbo, Roar of the World\n\nDeck\n1 Sol Ring\n");
  });

  it("leaves the maybe-board out entirely", () => {
    const text = formatDeckText([card("Forest", 16), card("Maybe Card", 3, "maybe")]);
    assert.ok(!text.includes("Maybe Card"));
    assert.equal(text, "Deck\n16 Forest\n");
  });

  it("omits an empty sideboard but always writes the Deck header", () => {
    assert.equal(formatDeckText([]), "Deck\n");
    assert.equal(formatDeckText([card("Negate", 1, "sideboard")]), "Deck\n\nSideboard\n1 Negate\n");
  });

  it("sums the same card across printings and finishes, per section", () => {
    const text = formatDeckText([
      card("Sol Ring", 1),
      card("Sol Ring", 2), // a second printing, or the foil copy
      card("Sol Ring", 1, "sideboard"),
    ]);
    assert.equal(text, "Deck\n3 Sol Ring\n\nSideboard\n1 Sol Ring\n");
  });

  it("keeps the full name of split and double-faced cards", () => {
    const text = formatDeckText([
      card("Fire // Ice", 1),
      card("Delver of Secrets // Insectile Aberration", 1),
    ]);
    assert.match(text, /^1 Fire \/\/ Ice$/m);
    assert.match(text, /^1 Delver of Secrets \/\/ Insectile Aberration$/m);
  });

  it("sorts alphabetically and keeps each card on one line", () => {
    const text = formatDeckText([card("Zombify", 1), card("Aether\nVial", 1), card("  Mox  Opal ", 1)]);
    assert.equal(text, "Deck\n1 Aether Vial\n1 Mox Opal\n1 Zombify\n");
  });

  it("drops rows with no name or no copies rather than writing junk lines", () => {
    assert.equal(formatDeckText([card("", 1), card("Island", 0), card("Swamp", 2)]), "Deck\n2 Swamp\n");
  });
});

describe("deckFileDisposition", () => {
  it("names the file after the deck, as an attachment", () => {
    assert.equal(
      deckFileDisposition("Mono Red"),
      "attachment; filename=\"Mono Red.txt\"; filename*=UTF-8''Mono%20Red.txt",
    );
  });

  it("cannot be broken out of: quotes, backslashes and newlines never reach the header", () => {
    const h = deckFileDisposition('evil"; filename=x.exe\r\nSet-Cookie: a=b\\');
    assert.ok(!/[\r\n]/.test(h));
    const ascii = h.match(/filename="([^"]*)"/)?.[1] ?? "";
    assert.ok(!ascii.includes('"') && !ascii.includes("\\"));
    // Exactly the two parameters, nothing smuggled in between.
    assert.equal(h.split(";").length, 3);
  });

  it("carries a non-ASCII name in filename* and a safe fallback in filename", () => {
    const h = deckFileDisposition("Jötun Grunt’s deck");
    assert.match(h, /filename="J_tun Grunt_s deck\.txt"/);
    assert.match(h, /filename\*=UTF-8''J%C3%B6tun%20Grunt%E2%80%99s%20deck\.txt$/);
  });

  it("never produces a hidden or empty filename", () => {
    assert.match(deckFileDisposition("..."), /filename="deck\.txt"/);
    assert.match(deckFileDisposition("   "), /filename="deck\.txt"/);
    assert.match(deckFileDisposition("✨✨"), /filename="deck\.txt"/);
    assert.match(deckFileDisposition(".hidden"), /filename="hidden\.txt"/);
  });

  it("escapes the characters RFC 5987 does not allow unencoded", () => {
    assert.match(deckFileDisposition("Bob's (Draft)*"), /filename\*=UTF-8''Bob%27s%20%28Draft%29%2A\.txt$/);
  });
});
