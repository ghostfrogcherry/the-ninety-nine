/**
 * Mapping from a Scryfall card object to a `scryfall_cards` row.
 *
 * See db/migrations/0002_scryfall.sql for the column contract. The awkward
 * cases, all confirmed against live Scryfall data rather than assumed:
 *
 *  - Multi-face cards (`modal_dfc`, `transform`, `split`, `adventure`) carry
 *    their real mana cost / oracle text / images inside `card_faces`. At the top
 *    level `mana_cost` is the EMPTY STRING (not absent, not null) and
 *    `image_uris` is missing entirely. Empty strings are normalised to NULL so
 *    the app can test one thing instead of two.
 *
 *  - `reversible_card` (Secret Lair double-sided reprints) has NO top-level
 *    `oracle_id`, `cmc` or `type_line` at all — they live only on the faces.
 *    `oracle_id` is NOT NULL in the schema and is what singleton and banned-list
 *    checks key on, so it falls back to the first face's `oracle_id`.
 *    Verified: `Adrix and Nev, Twincasters` (sld 1544) has no top-level
 *    oracle_id, and each of its faces does.
 *
 *  - `colors` is absent on multi-face cards; the column is nullable, so absent
 *    stays NULL rather than becoming `{}`, which would wrongly read as
 *    "colourless". `color_identity` is NOT NULL and is always present.
 */

/**
 * Column order for the batched INSERT. `imported_at` is deliberately absent:
 * the upsert sets it to the transaction's `now()` so every card in a run shares
 * one timestamp, which is what the price-history snapshot dates itself from.
 */
export const CARD_COLUMNS = [
  "id",
  "oracle_id",
  "name",
  "set_code",
  "set_name",
  "collector_number",
  "rarity",
  "layout",
  "mana_cost",
  "cmc",
  "type_line",
  "oracle_text",
  "colors",
  "color_identity",
  "legalities",
  "prices",
  "image_uris",
  "finishes",
  "released_at",
  "card_faces",
];

/** Empty string -> null; anything else passes through. */
function nullIfBlank(value) {
  if (typeof value !== "string") return value ?? null;
  return value.length === 0 ? null : value;
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function jsonOrEmpty(value) {
  return JSON.stringify(value ?? {});
}

/**
 * Resolve the oracle_id for a card, falling back to its faces.
 * @returns {string|null} null when the card has no usable oracle_id anywhere.
 */
export function resolveOracleId(card) {
  if (typeof card.oracle_id === "string" && card.oracle_id) return card.oracle_id;
  if (Array.isArray(card.card_faces)) {
    for (const face of card.card_faces) {
      if (face && typeof face.oracle_id === "string" && face.oracle_id) return face.oracle_id;
    }
  }
  return null;
}

/** Columns the schema declares NOT NULL and Scryfall always supplies. */
const REQUIRED = [
  ["id", "id"],
  ["name", "name"],
  ["set", "set_code"],
  ["set_name", "set_name"],
  ["collector_number", "collector_number"],
  ["rarity", "rarity"],
  ["layout", "layout"],
];

/**
 * Convert one Scryfall card object into a positional value array matching
 * CARD_COLUMNS.
 *
 * @param {Record<string, any>} card
 * @returns {unknown[]}
 * @throws {Error} when a NOT NULL column cannot be filled. The caller skips and
 *   counts these rather than aborting a 100k-card import over one bad object.
 */
export function toCardRow(card) {
  if (!card || typeof card !== "object") {
    throw new Error("not a card object");
  }

  for (const [field, column] of REQUIRED) {
    const value = card[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`missing required field '${field}' (column ${column})`);
    }
  }

  const oracleId = resolveOracleId(card);
  if (!oracleId) {
    throw new Error("no oracle_id on the card or any of its faces");
  }

  return [
    card.id,
    oracleId,
    card.name,
    card.set,
    card.set_name,
    card.collector_number,
    card.rarity,
    card.layout,
    nullIfBlank(card.mana_cost),
    typeof card.cmc === "number" ? card.cmc : null,
    nullIfBlank(card.type_line),
    nullIfBlank(card.oracle_text),
    // Nullable TEXT[]: absent means "unknown" (multi-face), not "colourless".
    Array.isArray(card.colors) ? card.colors : null,
    Array.isArray(card.color_identity) ? card.color_identity : [],
    jsonOrEmpty(card.legalities),
    jsonOrEmpty(card.prices),
    jsonOrNull(card.image_uris),
    Array.isArray(card.finishes) ? card.finishes : [],
    nullIfBlank(card.released_at),
    jsonOrNull(card.card_faces),
  ];
}
