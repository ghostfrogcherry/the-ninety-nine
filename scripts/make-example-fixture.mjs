/**
 * Generates the synthetic fixture committed to this repo:
 *   db/seed/example-collection.txt  — a collection export in Moxfield text format
 *   db/seed/example-mirror.json     — the matching scryfall_cards rows
 *
 * This exists so tests and a fresh clone work WITHOUT anyone's real collection.
 * Card names and set codes are public Magic data; the ownership list is invented.
 * UUIDs are deterministic synthetic values, not real Scryfall ids — the fixture
 * proves our logic, it is not a source of truth about Magic.
 *
 * Every row below exists to exercise something specific. Read the comments
 * before deleting any of them.
 *
 *   node scripts/make-example-fixture.mjs
 */
import fs from "node:fs";
import crypto from "node:crypto";

/** Deterministic v4-shaped UUID, so regenerating the fixture is stable. */
const uid = (s) => {
  const h = crypto.createHash("sha1").update(`99fixture:${s}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, variant + h.slice(17, 20), h.slice(20, 32)].join("-");
};

const BROTHERS_WAR = "The Brothers’ War";

const rows = [
  // Plain baseline.
  { n: "Sol Ring", sc: "C19", sn: "Commander 2019", cn: "221", r: "uncommon", q: 1, f: false, p: "1.49", type: "Artifact" },

  // Same CARD, different PRINTING. Singleton is an oracle_id rule, so these two
  // must collide in deck validation despite having different scryfall ids.
  { n: "Sol Ring", sc: "LCC", sn: "Lost Caverns of Ixalan Commander", cn: "304", r: "uncommon", q: 1, f: false, p: "2.19", type: "Artifact", oracle: "Sol Ring" },

  // Quantity greater than one.
  { n: "Steel Exemplar", sc: "BRO", sn: BROTHERS_WAR, cn: "246", r: "uncommon", q: 3, f: false, p: "0.35" },

  // Foil and non-foil of ONE printing. Must both survive import, and they carry
  // different prices. Folding these together is the bug the schema guards against.
  { n: "Involuntary Cooldown", sc: "BRO", sn: BROTHERS_WAR, cn: "53", r: "common", q: 2, f: false, p: "0.35", type: "Instant", ci: ["U"] },
  { n: "Involuntary Cooldown", sc: "BRO", sn: BROTHERS_WAR, cn: "53", r: "common", q: 1, f: true, p: "0.49", type: "Instant", ci: ["U"] },

  // Names containing " // " — split cards and modal DFCs. A greedy parser eats these.
  { n: "Makindi Stampede // Makindi Mesas", sc: "ZNR", sn: "Zendikar Rising", cn: "26", r: "rare", q: 2, f: false, p: "0.35", type: "Sorcery // Land", ci: ["W"] },
  { n: "Makindi Stampede // Makindi Mesas", sc: "ZNR", sn: "Zendikar Rising", cn: "26", r: "rare", q: 1, f: true, p: "0.79", type: "Sorcery // Land", ci: ["W"] },
  { n: "Ondu Inversion // Ondu Skyruins", sc: "ZNR", sn: "Zendikar Rising", cn: "30", r: "rare", q: 1, f: false, p: "1.99", type: "Sorcery // Land", ci: ["W"] },

  // Non-numeric collector numbers — the parseInt() trap. parseInt("pp319sb") is 319.
  { n: "Homarid", sc: "FEM", sn: "Fallen Empires", cn: "19b", r: "common", q: 1, f: false, p: "0.25" },
  { n: "Sea Eagle", sc: "8ED", sn: "Eighth Edition", cn: "S4", r: "common", q: 1, f: false, p: "0.30" },
  { n: "Isamaru, Hound of Konda", sc: "PLST", sn: "The List", cn: "CHK-19", r: "rare", q: 1, f: false, p: "3.49", type: "Legendary Creature — Dog" },
  { n: "Fellwar Stone", sc: "PTC", sn: "Prerelease Cards", cn: "pp319sb", r: "uncommon", q: 1, f: false, p: "1.10", type: "Artifact" },
  { n: "Reverse Damage", sc: "PTC", sn: "Prerelease Cards", cn: "et45sb", r: "rare", q: 1, f: false, p: "0.95" },

  // Basic land — exempt from singleton.
  { n: "Forest", sc: "ZNR", sn: "Zendikar Rising", cn: "280", r: "common", q: 12, f: false, p: "0.10", type: "Basic Land — Forest", ci: ["G"] },

  // "any number" card — exempt from singleton.
  { n: "Rat Colony", sc: "DOM", sn: "Dominaria", cn: "101", r: "common", q: 9, f: false, p: "0.45",
    type: "Creature — Rat", text: "A deck can have any number of cards named Rat Colony.", ci: ["B"] },

  // Capped-number card — exempt only up to seven.
  { n: "Seven Dwarves", sc: "ELD", sn: "Throne of Eldraine", cn: "88", r: "common", q: 7, f: false, p: "0.35",
    type: "Creature — Dwarf", text: "A deck can have up to seven cards named Seven Dwarves.", ci: ["W"] },

  // Legendary creature — eligible commander, two colours.
  { n: "Arahbo, Roar of the World", sc: "C17", sn: "Commander 2017", cn: "27", r: "mythic", q: 1, f: true, p: "37.99",
    type: "Legendary Creature — Cat Avatar", ci: ["G", "W"] },

  // Banned in Commander.
  { n: "Black Lotus", sc: "LEA", sn: "Limited Edition Alpha", cn: "232", r: "rare", q: 1, f: false, p: "0.00",
    type: "Artifact", legal: "banned" },

  // Off-identity card, for colour identity tests against a G/W commander.
  { n: "Counterspell", sc: "MH2", sn: "Modern Horizons 2", cn: "267", r: "common", q: 1, f: false, p: "0.99",
    type: "Instant", ci: ["U"] },
];

const mirror = [];
const lines = [];
/**
 * Compact per-line records, mirroring the shape a resolved collection index
 * exports: {n, sc, sn, cn, f, r, q, id, p}. The import tests consume this.
 */
const compact = [];

/**
 * Prices per printing, keyed by the id both finishes share.
 *
 * A printing owned in both finishes must carry BOTH `usd` and `usd_foil`, the
 * way Scryfall really ships it. Deriving the mirror row from whichever line
 * came first leaves the other finish null, which then reads as a worthless
 * card anywhere prices are looked up off `scryfall_cards` rather than off
 * `card_price_history`.
 */
const priceFor = new Map();
for (const r of rows) {
  const id = uid(`${r.sc}|${r.cn}|${r.n}`);
  const entry = priceFor.get(id) ?? { usd: null, usd_foil: null };
  entry[r.f ? "usd_foil" : "usd"] = r.p;
  priceFor.set(id, entry);
}

for (const r of rows) {
  const id = uid(`${r.sc}|${r.cn}|${r.n}`);
  compact.push({ n: r.n, sc: r.sc, sn: r.sn, cn: r.cn, f: r.f, r: r.r, q: r.q, id, p: r.p });
  // Foil and non-foil of one printing share a scryfall id — emit the mirror row once.
  if (!mirror.some((m) => m.id === id)) {
    mirror.push({
      id,
      oracle_id: uid(`oracle:${r.oracle ?? r.n}`),
      name: r.n,
      set_code: r.sc.toLowerCase(),
      set_name: r.sn,
      collector_number: r.cn,
      rarity: r.r,
      layout: r.n.includes(" // ") ? "modal_dfc" : "normal",
      type_line: r.type ?? "Creature — Fixture",
      oracle_text: r.text ?? "",
      color_identity: r.ci ?? [],
      legalities: { commander: r.legal ?? "legal" },
      prices: priceFor.get(id),
      finishes: ["nonfoil", "foil"],
    });
  }
  lines.push(`${r.q} ${r.n} (${r.sc}) ${r.cn}${r.f ? " *F*" : ""}`);
}

fs.writeFileSync("db/seed/example-collection.txt", `${lines.join("\n")}\n`);
fs.writeFileSync("db/seed/example-mirror.json", `${JSON.stringify(mirror, null, 2)}\n`);
fs.writeFileSync("db/seed/example-collection.json", `${JSON.stringify(compact, null, 2)}\n`);

const pairs = Object.values(
  compact.reduce((acc, c) => {
    (acc[c.id] ??= new Set()).add(c.f);
    return acc;
  }, {}),
).filter((s) => s.size > 1).length;

console.log("lines             :", lines.length);
console.log("physical cards    :", rows.reduce((a, r) => a + r.q, 0));
console.log("foil lines        :", compact.filter((c) => c.f).length);
console.log("distinct ids      :", new Set(compact.map((c) => c.id)).size);
console.log("foil/nonfoil pairs:", pairs);
console.log("mirror rows       :", mirror.length);
console.log("distinct oracles  :", new Set(mirror.map((m) => m.oracle_id)).size);
