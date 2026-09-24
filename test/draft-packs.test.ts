/**
 * Draft engine, the pure half — `lib/draft/packs.ts` and `lib/draft/table.ts`.
 *
 *   npm test
 *
 * No database: eligibility, pack composition, the bot's pick and the position
 * rule are all functions of plain values and a seeded Rng. The database half
 * is test/draft.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Types from an extensionless import (erased), values through a variable
 * specifier with the real `.ts` extension — the idiom from test/deck.test.ts.
 */
import type * as PacksModule from "../lib/draft/packs";
import type * as TableModule from "../lib/draft/table";
import type { MirrorPrinting, Rng } from "../lib/draft/packs";
import type { TableCard } from "../lib/draft/table";

const packsSpecifier = "../lib/draft/packs.ts";
const tableSpecifier = "../lib/draft/table.ts";

const {
  COLOUR_BONUS,
  EXCLUDED_LAYOUTS,
  MYTHIC_CHANCE,
  botColours,
  botScore,
  compareCollectorNumbers,
  eligibleCards,
  isBasicLand,
  openPack,
  pickForBot,
  rarityClass,
} = (await import(packsSpecifier)) as typeof PacksModule;

const {
  buildTable,
  isComplete,
  mod,
  packInFront,
  packOrigin,
  passDirection,
  runBots,
  seatPosition,
  seatToPickFrom,
  seatTurn,
  takeCard,
  takenFrom,
  turnOf,
} = (await import(tableSpecifier)) as typeof TableModule;

/** mulberry32: a tiny seeded PRNG, so every "random" pack here is replayable. */
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

let serial = 0;
function printing(over: Partial<MirrorPrinting> = {}): MirrorPrinting {
  serial += 1;
  const n = String(serial).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${n}`,
    oracle_id: `10000000-0000-4000-8000-${n}`,
    name: `Card ${serial}`,
    collector_number: String(serial),
    rarity: "common",
    layout: "normal",
    type_line: "Creature — Bear",
    colors: ["G"],
    color_identity: ["G"],
    booster: null,
    ...over,
  };
}

/** A set shaped like a real one: 20 mythics, 60 rares, 80 uncommons, 100 commons. */
function realisticSet(): MirrorPrinting[] {
  const out: MirrorPrinting[] = [];
  const colours = ["W", "U", "B", "R", "G"];
  const add = (rarity: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const c = colours[i % 5]!;
      out.push(printing({ rarity, colors: [c], color_identity: [c], booster: true }));
    }
  };
  add("mythic", 20);
  add("rare", 60);
  add("uncommon", 80);
  add("common", 100);
  return out;
}

const classOf = (pack: readonly { rarity: string }[]) => {
  const counts = { mythic: 0, rare: 0, uncommon: 0, common: 0 };
  for (const c of pack) counts[rarityClass(c.rarity)] += 1;
  return counts;
};

/* ================================================================== *
 * Eligibility
 * ================================================================== */

describe("compareCollectorNumbers", () => {
  it("orders by numeric prefix, then the string — never parseInt, never plain string order", () => {
    const sorted = ["100", "27", "19b", "19", "S4", "pp319sb", "CHK-19", "2"].sort(compareCollectorNumbers);
    // String order would put "100" before "27"; parseInt would read "pp319sb"
    // as 319 and "CHK-19" as NaN. Numbers without a leading digit go last.
    assert.deepEqual(sorted, ["2", "19", "19b", "27", "100", "CHK-19", "S4", "pp319sb"]);
  });

  it("compares equal strings as equal", () => {
    assert.equal(compareCollectorNumbers("19b", "19b"), 0);
  });
});

describe("eligibleCards", () => {
  it("keeps only booster rows when the set knows its booster flag", () => {
    const main = printing({ booster: true });
    const showcase = printing({ oracle_id: main.oracle_id, collector_number: "300", booster: false });
    const promo = printing({ booster: false });
    const pool = eligibleCards([main, showcase, promo]);
    assert.deepEqual(pool.map((c) => c.id), [main.id]);
  });

  it("falls back to every row when no row knows (pre-0008 data, the demo fixture)", () => {
    const rows = [printing(), printing(), printing()];
    assert.equal(eligibleCards(rows).length, 3);
  });

  it("with some rows known and some NULL, trusts only the known booster rows", () => {
    const rows = [printing({ booster: true }), printing({ booster: null }), printing({ booster: false })];
    assert.deepEqual(eligibleCards(rows).map((c) => c.id), [rows[0]!.id]);
  });

  it("never deals basic lands, snow basics included, but keeps other lands", () => {
    const forest = printing({ type_line: "Basic Land — Forest", colors: [], color_identity: ["G"] });
    const snow = printing({ type_line: "Basic Snow Land — Island", colors: [], color_identity: ["U"] });
    const wastes = printing({ type_line: "Basic Land", colors: [], color_identity: [] });
    const dual = printing({ type_line: "Land — Forest Island", colors: [], color_identity: ["G", "U"] });
    const snowDual = printing({ type_line: "Snow Land — Forest Island", colors: [] });
    const pool = eligibleCards([forest, snow, wastes, dual, snowDual]);
    assert.deepEqual(pool.map((c) => c.id), [dual.id, snowDual.id]);
    assert.equal(isBasicLand(null), false, "reversible cards have no type_line and are not basics");
  });

  it("drops tokens, emblems and art cards even in the every-row fallback", () => {
    const real = printing();
    const junk = EXCLUDED_LAYOUTS.map((layout) => printing({ layout }));
    assert.deepEqual(eligibleCards([real, ...junk]).map((c) => c.id), [real.id]);
    assert.deepEqual([...EXCLUDED_LAYOUTS].sort(), ["art_series", "double_faced_token", "emblem", "token"]);
  });

  it("keeps one printing per oracle_id: the lowest collector number, compared as TEXT", () => {
    const base = printing({ collector_number: "9" });
    const higher = printing({ oracle_id: base.oracle_id, collector_number: "10" });
    const variant = printing({ oracle_id: base.oracle_id, collector_number: "9a" });
    const other = printing({ collector_number: "19b" });
    const otherPlain = printing({ oracle_id: other.oracle_id, collector_number: "19" });
    const lettered = printing({ collector_number: "S4" });
    const letteredNumbered = printing({ oracle_id: lettered.oracle_id, collector_number: "250" });
    // Plain string order would keep "10" over "9", and "250" would lose to "S4"
    // only by accident of ASCII.
    const pool = eligibleCards([higher, variant, base, other, otherPlain, lettered, letteredNumbered]);
    assert.deepEqual(
      pool.map((c) => c.collector_number),
      ["9", "19", "250"],
    );
  });

  it("gives the same pool whatever order the rows arrive in", () => {
    const rows = realisticSet();
    const shuffled = [...rows].reverse();
    assert.deepEqual(
      eligibleCards(shuffled).map((c) => c.id),
      eligibleCards(rows).map((c) => c.id),
    );
  });
});

/* ================================================================== *
 * Pack composition
 * ================================================================== */

describe("rarityClass", () => {
  it("files special and bonus with rare, and anything unknown with common", () => {
    assert.equal(rarityClass("special"), "rare");
    assert.equal(rarityClass("bonus"), "rare");
    assert.equal(rarityClass("mythic"), "mythic");
    assert.equal(rarityClass("something-new"), "common");
  });
});

describe("openPack", () => {
  const pool = eligibleCards(realisticSet());

  it("is one rare-or-mythic, three uncommons and commons for the rest", () => {
    const rng = seeded(1);
    for (let i = 0; i < 200; i += 1) {
      const pack = openPack(pool, 14, rng);
      const n = classOf(pack);
      assert.equal(pack.length, 14);
      assert.equal(n.mythic + n.rare, 1);
      assert.equal(n.uncommon, 3);
      assert.equal(n.common, 10);
    }
  });

  it("makes the rare slot a mythic about one pack in eight", () => {
    const rng = seeded(2);
    let mythics = 0;
    const packs = 4000;
    for (let i = 0; i < packs; i += 1) mythics += classOf(openPack(pool, 14, rng)).mythic;
    const rate = mythics / packs;
    assert.ok(Math.abs(rate - MYTHIC_CHANCE) < 0.03, `mythic rate ${rate}`);
  });

  it("never repeats a card within a pack, even when the pool is exactly one pack", () => {
    const rng = seeded(3);
    for (let i = 0; i < 300; i += 1) {
      const pack = openPack(pool, 20, rng);
      assert.equal(new Set(pack.map((c) => c.oracle_id)).size, 20);
    }
    const tiny = pool.slice(0, 14);
    const pack = openPack(tiny, 14, rng);
    assert.deepEqual(new Set(pack.map((c) => c.id)), new Set(tiny.map((c) => c.id)));
  });

  it("always asks for a rare in a set with no mythics", () => {
    const noMythics = pool.filter((c) => c.rarity !== "mythic");
    const rng = seeded(4);
    for (let i = 0; i < 400; i += 1) assert.equal(classOf(openPack(noMythics, 14, rng)).rare, 1);
  });

  it("fills a pack from the neighbouring rarity when one runs short", () => {
    const rng = seeded(5);
    // No rares or mythics at all: the rare slot falls back to an uncommon.
    const commonsAndUncommons = pool.filter((c) => ["uncommon", "common"].includes(c.rarity));
    const n = classOf(openPack(commonsAndUncommons, 14, rng));
    assert.deepEqual(n, { mythic: 0, rare: 0, uncommon: 4, common: 10 });

    // Only two uncommons: the third uncommon slot takes a common.
    const fewUncommons = [
      ...pool.filter((c) => c.rarity === "uncommon").slice(0, 2),
      ...pool.filter((c) => c.rarity !== "uncommon"),
    ];
    const m = classOf(openPack(fewUncommons, 14, rng));
    assert.equal(m.uncommon, 2);
    assert.equal(m.common, 11);

    // Only five commons in a 14-card pack: the rest come from higher up.
    const fewCommons = [...pool.filter((c) => c.rarity !== "common"), ...pool.filter((c) => c.rarity === "common").slice(0, 5)];
    const pack = openPack(fewCommons, 14, rng);
    assert.equal(pack.length, 14);
    assert.equal(classOf(pack).common, 5);
  });

  it("counts special and bonus rarities in the rare slot", () => {
    const odd = [
      printing({ rarity: "special" }),
      ...Array.from({ length: 3 }, () => printing({ rarity: "uncommon" })),
      ...Array.from({ length: 10 }, () => printing({ rarity: "common" })),
    ];
    const pack = openPack(odd, 14, seeded(6));
    assert.equal(pack[0]!.rarity, "special", "the rare slot is dealt first and takes the special");
  });

  it("refuses a pool smaller than the pack instead of dealing a short one", () => {
    assert.throws(() => openPack(pool.slice(0, 13), 14, seeded(7)), /cannot open a 14-card pack/);
  });

  it("is deterministic under a seeded Rng", () => {
    const a = Array.from({ length: 10 }, ((rng) => () => openPack(pool, 14, rng).map((c) => c.id))(seeded(42)));
    const b = Array.from({ length: 10 }, ((rng) => () => openPack(pool, 14, rng).map((c) => c.id))(seeded(42)));
    const c = Array.from({ length: 10 }, ((rng) => () => openPack(pool, 14, rng).map((c) => c.id))(seeded(43)));
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
});

/* ================================================================== *
 * The bot
 * ================================================================== */

describe("pickForBot", () => {
  const card = (rarity: string, colors: string[] | null, color_identity: string[] = colors ?? []) => ({
    rarity,
    colors,
    color_identity,
  });
  const noTies: Rng = () => 0;

  it("takes the rarest card while it has no colours", () => {
    const pack = [card("common", ["U"]), card("rare", ["R"]), card("uncommon", ["U"]), card("mythic", ["W"])];
    assert.equal(pickForBot(pack, [], noTies), pack[3]);
    // Two picks, both blue: still not committed, so the rare beats the blue uncommon.
    assert.equal(pickForBot(pack.slice(0, 3), [card("common", ["U"]), card("common", ["U"])], noTies), pack[1]);
  });

  it("after three coloured picks, prefers on-colour: uncommon over an off-colour rare", () => {
    const picks = [card("common", ["U"]), card("common", ["B"]), card("uncommon", ["U", "B"])];
    assert.deepEqual(botColours(picks), ["U", "B"]);
    const offRare = card("rare", ["R"]);
    const onUncommon = card("uncommon", ["B"]);
    const onCommon = card("common", ["U"]);
    assert.equal(pickForBot([offRare, onUncommon], picks, noTies), onUncommon);
    // …but an on-colour common does not beat the off-colour rare.
    assert.equal(pickForBot([offRare, onCommon], picks, noTies), offRare);
    // A gold card is on-colour only if every colour is.
    assert.equal(botScore(card("uncommon", ["U", "R"]), ["U", "B"]), 2);
    assert.equal(botScore(card("uncommon", ["U", "B"]), ["U", "B"]), 2 + COLOUR_BONUS);
  });

  it("counts colourless cards as on-colour", () => {
    const picks = [card("common", ["G"]), card("common", ["G"]), card("common", ["W"])];
    const artifact = card("uncommon", []);
    assert.equal(pickForBot([card("rare", ["B"]), artifact], picks, noTies), artifact);
  });

  it("reads a multi-face card's colours from its identity, not as colourless", () => {
    const picks = [card("common", ["G"]), card("common", ["G"]), card("common", ["W"])];
    const mdfc = card("uncommon", null, ["R"]);
    assert.equal(botScore(mdfc, botColours(picks)), 2, "red is off-colour for a G/W bot");
  });

  it("breaks colour ties in WUBRG order", () => {
    const picks = [card("common", ["G"]), card("common", ["R"]), card("common", ["W"])];
    assert.deepEqual(botColours(picks), ["W", "R"]);
  });

  it("breaks card ties with the Rng, and only ties", () => {
    const a = card("common", ["U"]);
    const b = card("common", ["U"]);
    const high = [0.9, 0.1];
    const low = [0.1, 0.9];
    const replay = (xs: number[]): Rng => () => xs.shift() ?? 0;
    assert.equal(pickForBot([a, b], [], replay([...high])), a);
    assert.equal(pickForBot([a, b], [], replay([...low])), b);
    // The nudge can never lift a common over an uncommon.
    const u = card("uncommon", ["U"]);
    assert.equal(pickForBot([a, u], [], replay([0.999, 0])), u);
  });

  it("refuses an empty pack", () => {
    assert.throws(() => pickForBot([], [], noTies), /empty pack/);
  });
});

/* ================================================================== *
 * The position rule
 * ================================================================== */

const SHAPE = { seatCount: 4, packSize: 14, packCount: 3 };

describe("position rule", () => {
  it("reads round and pick from the seat's own pick count", () => {
    assert.deepEqual(seatPosition(0, SHAPE), { round: 0, pick: 0 });
    assert.deepEqual(seatPosition(13, SHAPE), { round: 0, pick: 13 });
    assert.deepEqual(seatPosition(14, SHAPE), { round: 1, pick: 0 });
    assert.deepEqual(seatPosition(41, SHAPE), { round: 2, pick: 13 });
    assert.deepEqual(seatPosition(42, SHAPE), { round: 3, pick: 0 });
  });

  it("passes left in rounds 0 and 2, right in round 1", () => {
    assert.equal(passDirection(0), 1);
    assert.equal(passDirection(1), -1);
    assert.equal(passDirection(2), 1);
  });

  it("finds the pack a seat holds: (seat - pick·dir) mod seats", () => {
    // Round 0 passes to seat+1, so seat 2's second pack came from seat 1…
    assert.equal(packOrigin(2, 0, 1, 4), 1);
    // …and seat 0's came from seat 3, round the table.
    assert.equal(packOrigin(0, 0, 1, 4), 3);
    // Round 1 passes the other way.
    assert.equal(packOrigin(2, 1, 1, 4), 3);
    assert.equal(packOrigin(3, 1, 1, 4), 0);
    // Pick 0 is always your own pack.
    for (let s = 0; s < 4; s += 1) assert.equal(packOrigin(s, 1, 0, 4), s);
    // JavaScript's % keeps the sign; mod must not.
    assert.equal(mod(-5, 4), 3);
  });

  it("agrees with seatToPickFrom in both directions, for every seat and pick", () => {
    for (const n of [2, 3, 8]) {
      for (let r = 0; r < 3; r += 1) {
        for (let s = 0; s < n; s += 1) {
          for (let p = 0; p < 20; p += 1) {
            assert.equal(seatToPickFrom(packOrigin(s, r, p, n), r, p, n), s);
          }
        }
      }
    }
  });

  it("lets a seat pick exactly when its pack has had `pick` cards taken", () => {
    const counts = new Map<string, number>();
    const taken = (r: number, o: number) => counts.get(`${r}:${o}`) ?? 0;
    // Seat 2 on its second pick of round 0 wants seat 1's pack.
    counts.set("0:1", 1);
    assert.deepEqual(seatTurn(2, 1, taken, SHAPE), { kind: "pick", round: 0, pick: 1, origin: 1 });
    // Nothing taken from it yet: seat 1 itself has not picked, so wait on seat 1.
    counts.set("0:1", 0);
    assert.deepEqual(seatTurn(2, 1, taken, SHAPE), { kind: "wait", round: 0, pick: 1, origin: 1, waitingOn: 1 });
    // Seat 3 on pick 2 wants seat 1's pack too, which has one card gone: the
    // seat holding it now is seat 2.
    counts.set("0:1", 1);
    assert.deepEqual(seatTurn(3, 2, taken, SHAPE), { kind: "wait", round: 0, pick: 2, origin: 1, waitingOn: 2 });
    // Round 1 runs the other way: seat 2 on pick 1 wants seat 3's pack.
    assert.deepEqual(seatTurn(2, 15, taken, SHAPE), { kind: "wait", round: 1, pick: 1, origin: 3, waitingOn: 3 });
    // Finished.
    assert.equal(seatTurn(2, 42, taken, SHAPE).kind, "done");
    // More taken than the seat's pick is impossible and must not pass quietly.
    counts.set("0:2", 3);
    assert.throws(() => seatTurn(2, 0, taken, SHAPE), /cards taken but seat 2 is on pick 0/);
  });
});

/* ================================================================== *
 * The in-memory pod
 * ================================================================== */

function freshTable(shape = SHAPE, seed = 9) {
  const pool = eligibleCards(realisticSet());
  const rng = seeded(seed);
  const cards: TableCard[] = [];
  for (let round = 0; round < shape.packCount; round += 1) {
    for (let origin = 0; origin < shape.seatCount; origin += 1) {
      openPack(pool, shape.packSize, rng).forEach((c, slot) =>
        cards.push({
          round, origin, slot, scryfall_id: c.id, rarity: c.rarity, colors: c.colors,
          color_identity: c.color_identity, picked_by: null, pick_number: null,
        }),
      );
    }
  }
  return { table: buildTable(shape, cards), rng };
}

describe("runBots", () => {
  it("drafts a whole all-bot pod: every card once, every seat a full pile, every pass the right way", () => {
    const shape = { seatCount: 8, packSize: 15, packCount: 3 };
    const { table, rng } = freshTable(shape);
    const picked = runBots(table, [0, 1, 2, 3, 4, 5, 6, 7], rng);
    assert.equal(picked, 8 * 15 * 3);
    assert.ok(isComplete(table));
    for (const pile of table.picks) assert.equal(pile.length, 45);
    for (const card of table.cards) {
      assert.notEqual(card.picked_by, null);
      // The pass direction, checked from the outcome: the card taken k-th
      // from a pack went to the seat k steps along in the round's direction.
      assert.equal(card.picked_by, seatToPickFrom(card.origin, card.round, card.pick_number!, 8));
    }
  });

  it("stops at a person who has not picked, and every bot is then waiting on someone", () => {
    const { table, rng } = freshTable();
    runBots(table, [1, 2, 3], rng);
    // Seat 0 (a person) has taken nothing, so its pack has not moved and the
    // bots' round-0 picks back up behind it.
    assert.equal(table.picks[0]!.length, 0);
    assert.deepEqual(table.picks.map((p) => p.length), [0, 1, 2, 3]);
    assert.deepEqual(turnOf(table, 1), { kind: "wait", round: 0, pick: 1, origin: 0, waitingOn: 0 });
    assert.deepEqual(turnOf(table, 3), { kind: "wait", round: 0, pick: 3, origin: 0, waitingOn: 0 });
    assert.equal(turnOf(table, 0).kind, "pick");

    // The person picks; the bots catch up exactly one step each.
    takeCard(table, 0, packInFront(table, 0)![0]!);
    runBots(table, [1, 2, 3], rng);
    assert.deepEqual(table.picks.map((p) => p.length), [1, 2, 3, 4]);
    assert.equal(takenFrom(table, 0, 0), 4, "seat 0's own pack has been round the whole table");
  });

  it("will not let a seat take a card that is not in front of it", () => {
    const { table } = freshTable();
    const notMine = table.packs.get("0:1")![0]!;
    assert.throws(() => takeCard(table, 0, notMine), /cannot take that card now/);
  });
});
