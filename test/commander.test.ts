/**
 * Tests for lib/commander — Commander (EDH) legality validation.
 *
 * Run with:
 *   node --experimental-strip-types --test test/commander.test.ts
 *
 * Fixtures use real card text and real colour identities, because every rule
 * here is a text/data-shape rule and made-up wording would prove nothing. The
 * UUIDs are fake but structurally honest: two printings of one card share an
 * oracle_id and differ in id, which is the case the singleton rule exists for.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Types come in on a `.js` specifier. `import type` is erased wholesale by
// node's type stripper, so this line never reaches node's module resolver,
// while tsc maps `.js` -> `.ts` under `moduleResolution: bundler`.
import type { CommanderCard, DeckEntry, Violation } from "../lib/commander/index.js";

// Values must use the real `.ts` specifier: node's ESM resolver does not
// rewrite extensions, so `.js` here would be ERR_MODULE_NOT_FOUND. tsc in turn
// reports TS5097 for it, because the repo's tsconfig does not set
// `allowImportingTsExtensions` (which is the proper fix, and is permitted here
// since `noEmit` is on — but tsconfig.json is owned elsewhere). Suppressed on
// this line only so that both `npm test` and `npm run typecheck` stay green.
// @ts-ignore TS5097
import {
  validateCommanderDeck,
  checkSingleton,
  checkColorIdentity,
  checkLegality,
  checkDeckSize,
  checkCommanders,
  commanderColorIdentity,
  commanderEligibility,
  copyLimitFor,
  isBasicLand,
  isLegendaryCreature,
  // @ts-ignore TS5097 -- see the note above; node requires this exact extension.
} from "../lib/commander/index.ts";

/* -------------------------------------------------------------------------- */
/* Fixture helpers                                                             */
/* -------------------------------------------------------------------------- */

let uuidCounter = 0;
function uuid(tag: string): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}-${tag}`;
}

function makeCard(over: Partial<CommanderCard> & { name: string }): CommanderCard {
  return {
    id: over.id ?? uuid("id"),
    oracle_id: over.oracle_id ?? uuid("oracle"),
    name: over.name,
    set_code: over.set_code ?? "tst",
    collector_number: over.collector_number ?? "1",
    layout: over.layout ?? "normal",
    type_line: over.type_line ?? "Artifact",
    oracle_text: over.oracle_text ?? null,
    color_identity: over.color_identity ?? [],
    legalities: over.legalities === undefined ? { commander: "legal" } : over.legalities,
    card_faces: over.card_faces ?? null,
  };
}

function entry(card: CommanderCard, quantity = 1, board: DeckEntry["board"] = "main"): DeckEntry {
  return { card, quantity, board };
}

function commander(card: CommanderCard): DeckEntry {
  return entry(card, 1, "commander");
}

/* --- Real cards ----------------------------------------------------------- */

const sram = makeCard({
  name: "Sram, Senior Edificer",
  set_code: "ahn",
  collector_number: "20",
  type_line: "Legendary Creature — Dwarf Advisor",
  oracle_text:
    "Whenever you cast an Aura, Equipment, or Vehicle spell, draw a card.",
  color_identity: ["W"],
});

const plainsOracle = uuid("plains-oracle");
const plains = (set: string, num: string): CommanderCard =>
  makeCard({
    name: "Plains",
    oracle_id: plainsOracle,
    set_code: set,
    collector_number: num,
    type_line: "Basic Land — Plains",
    oracle_text: "({T}: Add {W}.)",
    color_identity: ["W"],
  });

/** Colourless basic. Subset of every identity, so it pads any deck legally. */
const wastesOracle = uuid("wastes-oracle");
const wastes = makeCard({
  name: "Wastes",
  oracle_id: wastesOracle,
  set_code: "ogw",
  collector_number: "183",
  type_line: "Basic Land",
  oracle_text: "{T}: Add {C}.",
  color_identity: [],
});

const solRingOracle = uuid("sol-ring-oracle");
const solRingC21 = makeCard({
  name: "Sol Ring",
  oracle_id: solRingOracle,
  set_code: "c21",
  collector_number: "263",
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  color_identity: [],
});
/** A DIFFERENT printing: different id, same oracle_id. */
const solRingLTC = makeCard({
  name: "Sol Ring",
  oracle_id: solRingOracle,
  set_code: "ltc",
  collector_number: "284",
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  color_identity: [],
});

const lightningBolt = makeCard({
  name: "Lightning Bolt",
  set_code: "lea",
  collector_number: "161",
  type_line: "Instant",
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  color_identity: ["R"],
});

const llanowarElves = makeCard({
  name: "Llanowar Elves",
  set_code: "m19",
  collector_number: "314",
  type_line: "Creature — Elf Druid",
  oracle_text: "{T}: Add {G}.",
  color_identity: ["G"],
});

/* -------------------------------------------------------------------------- */
/* Deck assembly                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pad a partial deck to exactly 100 with colourless basics, so that a test
 * about (say) colour identity does not also trip the deck-size check and
 * muddy the assertion.
 */
function deckOf(parts: DeckEntry[]): DeckEntry[] {
  const size = parts.reduce(
    (n, e) => n + ((e.board ?? "main") === "sideboard" || (e.board ?? "main") === "maybe" ? 0 : e.quantity),
    0,
  );
  if (size >= 100) return parts;
  return [...parts, entry(wastes, 100 - size)];
}

function rules(violations: Violation[]): string[] {
  return violations.map((v) => v.rule).sort();
}

/* -------------------------------------------------------------------------- */
/* 1. A legal deck                                                             */
/* -------------------------------------------------------------------------- */

test("a legal deck passes every check", () => {
  const deck = deckOf([commander(sram), entry(solRingC21), entry(plains("m21", "263"), 40)]);

  const result = validateCommanderDeck(deck);

  assert.equal(result.deckSize, 100);
  assert.deepEqual(result.violations, []);
  assert.equal(result.legal, true);
  assert.deepEqual(result.commanderColorIdentity, ["W"]);
  assert.equal(result.commanders.length, 1);
  assert.equal(result.commanders[0].name, "Sram, Senior Edificer");
  assert.deepEqual(
    result.checks.map((c) => [c.check, c.ok]),
    [
      ["deck_size", true],
      ["commander", true],
      ["singleton", true],
      ["color_identity", true],
      ["legality", true],
    ],
  );
});

/* -------------------------------------------------------------------------- */
/* 2. Singleton across two DIFFERENT printings (the oracle_id case)            */
/* -------------------------------------------------------------------------- */

test("two different printings of one card break singleton (keyed on oracle_id)", () => {
  // Sanity: the fixtures really are distinct printings of the same card.
  assert.notEqual(solRingC21.id, solRingLTC.id);
  assert.equal(solRingC21.oracle_id, solRingLTC.oracle_id);

  const deck = deckOf([commander(sram), entry(solRingC21), entry(solRingLTC)]);
  const result = validateCommanderDeck(deck);

  assert.equal(result.legal, false);
  assert.deepEqual(rules(result.violations), ["singleton"]);

  const v = result.violations[0];
  assert.equal(v.severity, "error");
  assert.equal(v.cards.length, 2);
  assert.deepEqual(
    v.cards.map((c) => c.id).sort(),
    [solRingC21.id, solRingLTC.id].sort(),
  );
  // Both printings are named, and the message explains why they collide.
  assert.match(v.message, /appears 2 times/);
  assert.match(v.message, /C21 #263/);
  assert.match(v.message, /LTC #284/);
  assert.match(v.message, /oracle_id/);
});

test("singleton counts quantity on a single row too", () => {
  const check = checkSingleton([commander(sram), entry(solRingC21, 2)]);
  assert.equal(check.ok, false);
  assert.equal(check.violations.length, 1);
  assert.equal(check.violations[0].cards.length, 1);
});

/* -------------------------------------------------------------------------- */
/* 3. Basic lands are exempt                                                   */
/* -------------------------------------------------------------------------- */

test("basic lands do not trip singleton, even across printings", () => {
  assert.equal(isBasicLand(plains("m21", "263")), true);
  assert.equal(copyLimitFor(plains("m21", "263")).reason, "basic_land");

  const deck = deckOf([
    commander(sram),
    entry(plains("m21", "263"), 40),
    entry(plains("znr", "270"), 58), // same oracle_id, different printing
  ]);

  const result = validateCommanderDeck(deck);
  assert.equal(result.deckSize, 100);
  assert.deepEqual(result.violations, []);
  assert.equal(result.legal, true);
});

test("snow basics and Wastes are recognised as basic lands", () => {
  const snow = makeCard({
    name: "Snow-Covered Forest",
    type_line: "Basic Snow Land — Forest",
    color_identity: ["G"],
  });
  assert.equal(isBasicLand(snow), true);
  assert.equal(isBasicLand(wastes), true);

  // A nonbasic land is NOT exempt.
  const command = makeCard({
    name: "Command Tower",
    type_line: "Land",
    color_identity: [],
  });
  assert.equal(isBasicLand(command), false);
  assert.equal(copyLimitFor(command).limit, 1);
});

/* -------------------------------------------------------------------------- */
/* 4. "A deck can have any number of cards named ..."                          */
/* -------------------------------------------------------------------------- */

test("'any number of cards named' cards are exempt from singleton", () => {
  const ratColony = makeCard({
    name: "Rat Colony",
    set_code: "dom",
    collector_number: "101",
    type_line: "Creature — Rat",
    oracle_text:
      "Rat Colony gets +1/+0 for each other creature you control named Rat Colony.\nA deck can have any number of cards named Rat Colony.",
    color_identity: ["B"],
  });

  assert.equal(copyLimitFor(ratColony).limit, Number.POSITIVE_INFINITY);
  assert.equal(copyLimitFor(ratColony).reason, "any_number");

  const marrow = makeCard({
    name: "Marrow-Gnawer",
    type_line: "Legendary Creature — Rat Rogue",
    oracle_text: "Rats you control have fear.",
    color_identity: ["B"],
  });

  const deck = deckOf([commander(marrow), entry(ratColony, 30)]);
  const result = validateCommanderDeck(deck);

  assert.deepEqual(result.violations, []);
  assert.equal(result.legal, true);
});

test("Dragon's Approach and Persistent Petitioners are exempt", () => {
  const approach = makeCard({
    name: "Dragon's Approach",
    type_line: "Sorcery",
    oracle_text:
      "Dragon's Approach deals 3 damage to target player or battle.\nA deck can have any number of cards named Dragon's Approach.",
    color_identity: ["R"],
  });
  const petitioners = makeCard({
    name: "Persistent Petitioners",
    type_line: "Creature — Human Advisor",
    oracle_text:
      "{1}, {T}: Target player mills a card.\nA deck can have any number of cards named Persistent Petitioners.",
    color_identity: ["U"],
  });

  assert.equal(copyLimitFor(approach).limit, Number.POSITIVE_INFINITY);
  assert.equal(copyLimitFor(petitioners).limit, Number.POSITIVE_INFINITY);
});

/* -------------------------------------------------------------------------- */
/* 5. Seven Dwarves caps at seven; Nazgul at nine                              */
/* -------------------------------------------------------------------------- */

const sevenDwarves = makeCard({
  name: "Seven Dwarves",
  set_code: "eld",
  collector_number: "132",
  type_line: "Creature — Dwarf",
  oracle_text:
    "Seven Dwarves gets +1/+1 for each other creature you control named Seven Dwarves.\nA deck can have up to seven cards named Seven Dwarves.",
  color_identity: ["R"],
});

const krenko = makeCard({
  name: "Krenko, Mob Boss",
  type_line: "Legendary Creature — Goblin Warrior",
  oracle_text: "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.",
  color_identity: ["R"],
});

test("Seven Dwarves is capped at seven, not unlimited", () => {
  const limit = copyLimitFor(sevenDwarves);
  assert.equal(limit.limit, 7);
  assert.equal(limit.reason, "capped");
});

test("seven copies of Seven Dwarves is legal; eight is not", () => {
  const ok = validateCommanderDeck(deckOf([commander(krenko), entry(sevenDwarves, 7)]));
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.legal, true);

  const bad = validateCommanderDeck(deckOf([commander(krenko), entry(sevenDwarves, 8)]));
  assert.equal(bad.legal, false);
  assert.deepEqual(rules(bad.violations), ["singleton"]);
  assert.match(bad.violations[0].message, /appears 8 times/);
  assert.match(bad.violations[0].message, /allows up to 7/);
});

test("the 'up to N' cap is parsed from oracle text alone, with no name-table entry", () => {
  // Seven Dwarves and Nazgul are BOTH in the folded-name fallback table, so a
  // test using either cannot tell the text parser from the fallback. This
  // fixture is deliberately named something the table has never heard of, so
  // it can only pass via the text. That is the path a future capped card
  // would take.
  const novel = makeCard({
    name: "Eight Hobbits",
    type_line: "Creature — Halfling",
    oracle_text: "A deck can have up to eight cards named Eight Hobbits.",
    color_identity: ["G"],
  });
  assert.deepEqual(copyLimitFor(novel), { limit: 8, reason: "capped" });

  // ...and the digit form, in case Scryfall ever spells it that way.
  const digits = makeCard({
    name: "Twelve Goblins",
    type_line: "Creature — Goblin",
    oracle_text: "A deck can have up to 12 cards named Twelve Goblins.",
    color_identity: ["R"],
  });
  assert.deepEqual(copyLimitFor(digits), { limit: 12, reason: "capped" });

  // A capped card must never fall through to unlimited.
  assert.notEqual(copyLimitFor(novel).limit, Number.POSITIVE_INFINITY);
});

test("the folded-name fallback caps Seven Dwarves even with no oracle text", () => {
  // The other half of the pair: text gone, so only the name table can answer.
  const noText = makeCard({
    name: "Seven Dwarves",
    type_line: "Creature — Dwarf",
    oracle_text: null,
    color_identity: ["R"],
  });
  assert.deepEqual(copyLimitFor(noText), { limit: 7, reason: "capped" });
});

test("Nazgul is capped at nine, including via the accented name", () => {
  const nazgul = makeCard({
    name: "Nazgûl",
    type_line: "Creature — Wraith Knight",
    oracle_text:
      "Whenever Nazgûl deals combat damage to a player, that player loses 1 life.\nA deck can have up to nine cards named Nazgûl.",
    color_identity: ["B"],
  });
  assert.equal(copyLimitFor(nazgul).limit, 9);

  // Name fallback: if the oracle text were missing from the mirror, the
  // folded-name table still caps it, and "Nazgûl" folds to "nazgul".
  const noText = makeCard({
    name: "Nazgûl",
    type_line: "Creature — Wraith Knight",
    oracle_text: null,
    color_identity: ["B"],
  });
  assert.equal(copyLimitFor(noText).limit, 9);
  assert.equal(copyLimitFor(noText).reason, "capped");
});

/* -------------------------------------------------------------------------- */
/* 6. Colour identity                                                          */
/* -------------------------------------------------------------------------- */

test("a card outside the commander's colour identity is rejected", () => {
  const deck = deckOf([commander(sram), entry(lightningBolt)]);
  const result = validateCommanderDeck(deck);

  assert.equal(result.legal, false);
  assert.deepEqual(rules(result.violations), ["color_identity"]);

  const v = result.violations[0];
  assert.equal(v.severity, "error");
  assert.deepEqual(v.cards.map((c) => c.name), ["Lightning Bolt"]);
  assert.match(v.message, /\{R\}/);
  assert.match(v.message, /\{W\}/);
});

test("identity is a subset test, not equality — mono-colour cards fit a two-colour commander", () => {
  const kykar = makeCard({
    name: "Kykar, Wind's Fury",
    type_line: "Legendary Creature — Bird Wizard",
    oracle_text: "Flying",
    color_identity: ["W", "U", "R"],
  });
  const check = checkColorIdentity([commander(kykar), entry(lightningBolt), entry(solRingC21)]);
  assert.equal(check.ok, true);
});

/* -------------------------------------------------------------------------- */
/* 7. Partners: the UNION legalises a card neither would alone                 */
/* -------------------------------------------------------------------------- */

const ishai = makeCard({
  name: "Ishai, Ojutai Dragonspeaker",
  set_code: "cmr",
  collector_number: "284",
  type_line: "Legendary Creature — Bird Monk",
  oracle_text:
    "Flying\nWhenever an opponent casts a spell, put a +1/+1 counter on Ishai, Ojutai Dragonspeaker.\nPartner (You can have two commanders if both have partner.)",
  color_identity: ["W", "U"],
});

const kraum = makeCard({
  name: "Kraum, Ludevic's Opus",
  set_code: "cmr",
  collector_number: "286",
  type_line: "Legendary Creature — Zombie Horror",
  oracle_text:
    "Flying, haste\nWhenever an opponent casts their second spell each turn, draw a card.\nPartner (You can have two commanders if both have partner.)",
  color_identity: ["U", "R"],
});

test("two commanders use the UNION of their colour identities", () => {
  assert.deepEqual(commanderColorIdentity([ishai, kraum]), ["W", "U", "R"]);
});

test("a partner pair legalises a card that either commander alone would reject", () => {
  // Ishai alone: {W}{U}. A red card is illegal.
  const soloResult = validateCommanderDeck(deckOf([commander(ishai), entry(lightningBolt)]));
  assert.equal(soloResult.legal, false);
  assert.deepEqual(rules(soloResult.violations), ["color_identity"]);

  // Ishai + Kraum: {W}{U}{R}. The same card is now legal.
  const pairResult = validateCommanderDeck(
    deckOf([commander(ishai), commander(kraum), entry(lightningBolt)]),
  );
  assert.deepEqual(pairResult.violations, []);
  assert.equal(pairResult.legal, true);
  assert.deepEqual(pairResult.commanderColorIdentity, ["W", "U", "R"]);
  assert.equal(pairResult.deckSize, 100);

  // ...but the union does not stretch to green.
  const greenResult = validateCommanderDeck(
    deckOf([commander(ishai), commander(kraum), entry(llanowarElves)]),
  );
  assert.equal(greenResult.legal, false);
  assert.deepEqual(rules(greenResult.violations), ["color_identity"]);
});

test("more than two commanders is an error", () => {
  const check = checkCommanders([commander(ishai), commander(kraum), commander(sram)]);
  assert.equal(check.ok, false);
  assert.ok(check.violations.some((v) => v.rule === "commander_too_many"));
});

/* -------------------------------------------------------------------------- */
/* 8. Colourless commander                                                     */
/* -------------------------------------------------------------------------- */

const kozilek = makeCard({
  name: "Kozilek, the Great Distortion",
  set_code: "bfz",
  collector_number: "5",
  type_line: "Legendary Creature — Eldrazi",
  oracle_text: "When you cast this spell, draw cards until you have seven cards in hand.\nMenace",
  color_identity: [],
});

test("a colourless commander permits only colourless cards", () => {
  assert.deepEqual(commanderColorIdentity([kozilek]), []);

  // Colourless artifacts and Wastes are fine.
  const ok = validateCommanderDeck(deckOf([commander(kozilek), entry(solRingC21)]));
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.legal, true);

  // Any coloured card is not.
  const bad = validateCommanderDeck(deckOf([commander(kozilek), entry(llanowarElves)]));
  assert.equal(bad.legal, false);
  assert.deepEqual(rules(bad.violations), ["color_identity"]);
  assert.match(bad.violations[0].message, /colourless/);

  // Including a card whose identity comes from rules text, not its cost:
  // Scryfall reports it, we trust it.
  const crypt = makeCard({
    name: "Bequeathal",
    type_line: "Enchantment — Aura",
    oracle_text: "When enchanted creature dies, draw two cards.",
    color_identity: ["G"],
  });
  const bad2 = validateCommanderDeck(deckOf([commander(kozilek), entry(crypt)]));
  assert.equal(bad2.legal, false);
});

/* -------------------------------------------------------------------------- */
/* 9. Banned, and not_legal reported distinctly                                */
/* -------------------------------------------------------------------------- */

test("a banned card is rejected as 'banned'", () => {
  const lotus = makeCard({
    name: "Black Lotus",
    set_code: "lea",
    collector_number: "232",
    type_line: "Artifact",
    oracle_text: "{T}, Sacrifice Black Lotus: Add three mana of any one color.",
    color_identity: [],
    legalities: { commander: "banned", vintage: "restricted" },
  });

  const result = validateCommanderDeck(deckOf([commander(sram), entry(lotus)]));

  assert.equal(result.legal, false);
  assert.deepEqual(rules(result.violations), ["banned"]);
  assert.equal(result.violations[0].severity, "error");
  assert.deepEqual(result.violations[0].cards.map((c) => c.name), ["Black Lotus"]);
  assert.match(result.violations[0].message, /banned in Commander/);
});

test("'not_legal' is an error but is reported separately from 'banned'", () => {
  const unCard = makeCard({
    name: "Ashnod's Coupon",
    set_code: "ust",
    collector_number: "102",
    type_line: "Artifact",
    color_identity: [],
    legalities: { commander: "not_legal" },
  });
  const lotus = makeCard({
    name: "Black Lotus",
    type_line: "Artifact",
    color_identity: [],
    legalities: { commander: "banned" },
  });

  const check = checkLegality([commander(sram), entry(unCard), entry(lotus)]);

  assert.equal(check.ok, false);
  assert.deepEqual(rules(check.violations), ["banned", "not_legal"]);

  const notLegal = check.violations.find((v) => v.rule === "not_legal")!;
  assert.equal(notLegal.severity, "error");
  assert.match(notLegal.message, /never legal in the format/);
  assert.doesNotMatch(notLegal.message, /is banned in Commander/);
});

test("a missing commander legality is a warning, not a silent pass", () => {
  const unresolved = makeCard({
    name: "Mystery Printing",
    type_line: "Artifact",
    color_identity: [],
    legalities: {},
  });

  const check = checkLegality([commander(sram), entry(unresolved)]);
  assert.equal(check.ok, true); // warnings do not fail the check
  assert.deepEqual(rules(check.violations), ["unknown_legality"]);
  assert.equal(check.violations[0].severity, "warning");

  const result = validateCommanderDeck(deckOf([commander(sram), entry(unresolved)]));
  assert.equal(result.legal, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.errors.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 10. Commander eligibility                                                   */
/* -------------------------------------------------------------------------- */

test("a non-legendary creature cannot be the commander", () => {
  const result = validateCommanderDeck(deckOf([commander(llanowarElves)]));

  assert.equal(result.legal, false);
  assert.ok(result.violations.some((v) => v.rule === "commander_eligibility"));

  const v = result.violations.find((v) => v.rule === "commander_eligibility")!;
  assert.equal(v.severity, "error");
  assert.deepEqual(v.cards.map((c) => c.name), ["Llanowar Elves"]);
  assert.match(v.message, /cannot be a commander/);
  assert.match(v.message, /Creature — Elf Druid/);
});

test("a legendary non-creature cannot be the commander without the text", () => {
  const sword = makeCard({
    name: "Sword of Feast and Famine",
    type_line: "Legendary Artifact — Equipment",
    color_identity: [],
  });
  assert.equal(isLegendaryCreature(sword), false);
  assert.equal(commanderEligibility(sword).eligible, false);
});

test("a planeswalker with 'can be your commander' is eligible", () => {
  const rowan = makeCard({
    name: "Rowan, Scion of War",
    set_code: "clb",
    collector_number: "329",
    type_line: "Legendary Planeswalker — Rowan",
    oracle_text:
      "[+1]: Until end of turn, you may pay life rather than pay mana for spells you cast.\nRowan, Scion of War can be your commander.",
    color_identity: ["B", "R"],
  });

  assert.equal(isLegendaryCreature(rowan), false);
  assert.deepEqual(commanderEligibility(rowan), {
    eligible: true,
    via: "can_be_your_commander",
  });

  const result = validateCommanderDeck(deckOf([commander(rowan), entry(lightningBolt)]));
  assert.deepEqual(result.violations, []);
  assert.equal(result.legal, true);
});

test("a Background is eligible as a second commander", () => {
  const background = makeCard({
    name: "Criminal Past",
    type_line: "Legendary Enchantment — Background",
    oracle_text:
      "Commander creatures you own get +1/+0 for each creature card in your graveyard.",
    color_identity: ["B"],
  });
  const chooser = makeCard({
    name: "Wilson, Refined Grizzly",
    type_line: "Legendary Creature — Bear Warrior",
    oracle_text: "Ward {2}\nChoose a Background (You can have a Background as a second commander.)",
    color_identity: ["G"],
  });

  assert.deepEqual(commanderEligibility(background), { eligible: true, via: "background" });

  const result = validateCommanderDeck(deckOf([commander(chooser), commander(background)]));
  assert.deepEqual(result.violations, []);
  assert.equal(result.legal, true);
  assert.deepEqual(result.commanderColorIdentity, ["B", "G"]);
});

test("a transforming legendary creature is eligible via card_faces", () => {
  const dfc = makeCard({
    name: "Brisela, Voice of Nightmares",
    type_line: null,
    oracle_text: null,
    layout: "transform",
    color_identity: ["W", "B"],
    card_faces: [
      {
        name: "Gisela, the Broken Blade",
        type_line: "Legendary Creature — Angel Horror",
        oracle_text: "Flying, first strike, lifelink",
      },
      {
        name: "Brisela, Voice of Nightmares",
        type_line: "Legendary Creature — Eldrazi Angel",
        oracle_text: "Flying, first strike, vigilance, lifelink",
      },
    ],
  });
  assert.equal(isLegendaryCreature(dfc), true);
  assert.equal(commanderEligibility(dfc).eligible, true);
});

test("an adventure creature is not read as legendary from the wrong half", () => {
  // "Creature — Bear // Instant": neither half is legendary, and the check
  // must not stitch "Legendary" from one segment onto "Creature" in another.
  const trap = makeCard({
    name: "Fake Adventure",
    type_line: "Creature — Bear // Legendary Instant",
    color_identity: ["G"],
  });
  assert.equal(isLegendaryCreature(trap), false);
});

test("a deck with no commander at all is reported", () => {
  const result = validateCommanderDeck(deckOf([entry(solRingC21)]));
  assert.equal(result.legal, false);
  assert.ok(result.violations.some((v) => v.rule === "commander_missing"));
  // Colour identity is skipped rather than guessed when there is no commander.
  const identityCheck = result.checks.find((c) => c.check === "color_identity")!;
  assert.deepEqual(identityCheck.violations, []);
});

/* -------------------------------------------------------------------------- */
/* 11. Deck size                                                               */
/* -------------------------------------------------------------------------- */

test("deck size must be exactly 100, commander included", () => {
  const ninetyNine = [commander(sram), entry(wastes, 98)];
  const short = validateCommanderDeck(ninetyNine);
  assert.equal(short.deckSize, 99);
  assert.equal(short.legal, false);
  assert.ok(short.violations.some((v) => v.rule === "deck_size"));
  assert.match(short.violations.find((v) => v.rule === "deck_size")!.message, /Add 1\./);

  const exact = validateCommanderDeck([commander(sram), entry(wastes, 99)]);
  assert.equal(exact.deckSize, 100);
  assert.deepEqual(exact.violations, []);

  const over = validateCommanderDeck([commander(sram), entry(wastes, 101)]);
  assert.equal(over.deckSize, 102);
  assert.match(over.violations.find((v) => v.rule === "deck_size")!.message, /Remove 2\./);
});

test("sideboard and maybeboard cards are excluded from every check", () => {
  const lotus = makeCard({
    name: "Black Lotus",
    type_line: "Artifact",
    color_identity: [],
    legalities: { commander: "banned" },
  });

  const deck = [
    commander(sram),
    entry(wastes, 99),
    entry(lotus, 1, "maybe"),
    entry(lightningBolt, 4, "sideboard"),
    entry(solRingC21, 1, "sideboard"),
    entry(solRingLTC, 1, "sideboard"),
  ];

  const result = validateCommanderDeck(deck);
  assert.equal(result.deckSize, 100);
  assert.deepEqual(result.violations, []);
  assert.equal(result.legal, true);
});

/* -------------------------------------------------------------------------- */
/* 12. Everything at once                                                      */
/* -------------------------------------------------------------------------- */

test("all violations are returned together, not just the first", () => {
  const lotus = makeCard({
    name: "Black Lotus",
    type_line: "Artifact",
    color_identity: [],
    legalities: { commander: "banned" },
  });

  // Non-legendary commander + duplicate printings + off-colour card + banned
  // card + wrong size, all in one deck.
  const deck = [
    commander(llanowarElves),
    entry(solRingC21),
    entry(solRingLTC),
    entry(lightningBolt),
    entry(lotus),
  ];

  const result = validateCommanderDeck(deck);

  assert.equal(result.legal, false);
  assert.deepEqual(rules(result.violations), [
    "banned",
    "color_identity",
    "commander_eligibility",
    "deck_size",
    "singleton",
  ]);
  assert.equal(result.errors.length, 5);
  assert.equal(result.warnings.length, 0);
  // Every check is present in the report, passing or not.
  assert.deepEqual(
    result.checks.map((c) => c.check),
    ["deck_size", "commander", "singleton", "color_identity", "legality"],
  );
});

test("checkDeckSize and checkSingleton are usable standalone", () => {
  assert.equal(checkDeckSize([entry(wastes, 100)]).ok, true);
  assert.equal(checkSingleton([entry(solRingC21), entry(solRingLTC)]).ok, false);
});
