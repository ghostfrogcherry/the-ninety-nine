/**
 * Filtering, sorting and paging for the collection browser.
 *
 * State lives entirely in the URL query string, so a filtered view is
 * bookmarkable and shareable and the page stays a server component with no
 * client-side data fetching. Every value reaching SQL is parameterised; the
 * only interpolated things are sort columns, which come from a fixed table.
 */

export const COLORS = ["W", "U", "B", "R", "G"] as const;
export const RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"] as const;

/**
 * Primary card types. Matched against the WHOLE type_line, not just the front
 * face: a modal DFC like `Sorcery // Land` is a land you can play, and matching
 * only the front face silently hides every MDFC land from a Land filter.
 */
export const TYPES = [
  "Creature", "Instant", "Sorcery", "Artifact",
  "Enchantment", "Land", "Planeswalker", "Battle",
] as const;

export const FINISHES = ["nonfoil", "foil", "etched"] as const;

export type SortKey =
  | "name" | "price_desc" | "price_asc" | "cmc" | "cmc_desc"
  | "rarity" | "set" | "quantity" | "added";

/**
 * Whitelisted ORDER BY fragments. Nothing user-supplied is ever interpolated —
 * an unknown key falls back to `name`.
 *
 * `price` sorts NULLS LAST in both directions: a card with no recorded sale is
 * unknown, not free, and burying it is right either way.
 */
const SORTS: Record<SortKey, string> = {
  name: "s.name ASC, s.set_code ASC",
  price_desc: "unit_price DESC NULLS LAST, s.name ASC",
  price_asc: "unit_price ASC NULLS LAST, s.name ASC",
  cmc: "s.cmc ASC NULLS LAST, s.name ASC",
  cmc_desc: "s.cmc DESC NULLS LAST, s.name ASC",
  // Rarity is a string in the mirror, so order it by meaning rather than
  // alphabetically (which would give common < mythic < rare < uncommon).
  rarity: `CASE s.rarity WHEN 'mythic' THEN 0 WHEN 'rare' THEN 1
             WHEN 'uncommon' THEN 2 WHEN 'common' THEN 3 ELSE 4 END ASC, s.name ASC`,
  set: "s.set_code ASC, s.collector_number ASC",
  quantity: "cc.quantity DESC, s.name ASC",
  added: "cc.added_at DESC, s.name ASC",
};

export const SORT_LABELS: Array<[SortKey, string]> = [
  ["name", "Name"],
  ["price_desc", "Price ↓"],
  ["price_asc", "Price ↑"],
  ["cmc", "Mana value ↑"],
  ["cmc_desc", "Mana value ↓"],
  ["rarity", "Rarity"],
  ["set", "Set"],
  ["quantity", "Quantity"],
  ["added", "Recently added"],
];

export type View = "grid" | "table";

export interface Filters {
  q: string;
  colors: string[];
  /** Include cards with an empty colour identity. Separate from `colors`. */
  colorless: boolean;
  rarities: string[];
  types: string[];
  finishes: string[];
  set: string;
  cmcMin: number | null;
  cmcMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  sort: SortKey;
  view: View;
  page: number;
}

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

/** Repeated params arrive as arrays; a single one as a string. Normalise, and
 *  drop anything not in `allowed` so a hand-edited URL cannot inject values. */
const many = (v: string | string[] | undefined, allowed: readonly string[]): string[] => {
  const raw = Array.isArray(v) ? v : v ? [v] : [];
  const set = new Set(raw.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean));
  return allowed.filter((a) => set.has(a));
};

const num = (v: string | string[] | undefined): number | null => {
  const s = one(v);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function parseFilters(params: Params): Filters {
  const sort = one(params.sort) as SortKey;
  const view = one(params.view) === "table" ? "table" : "grid";
  const page = Math.max(1, Math.trunc(num(params.page) ?? 1));

  return {
    q: one(params.q).slice(0, 100),
    colors: many(params.colors, COLORS),
    colorless: one(params.colorless) === "1",
    rarities: many(params.rarities, RARITIES),
    types: many(params.types, TYPES),
    finishes: many(params.finishes, FINISHES),
    set: one(params.set).slice(0, 10),
    cmcMin: num(params.cmcMin),
    cmcMax: num(params.cmcMax),
    priceMin: num(params.priceMin),
    priceMax: num(params.priceMax),
    sort: sort in SORTS ? sort : "name",
    view,
    page,
  };
}

/** True when anything is narrowing the result set — drives the "clear" link. */
export function isFiltered(f: Filters): boolean {
  return Boolean(
    f.q || f.colors.length || f.colorless || f.rarities.length || f.types.length ||
    f.finishes.length || f.set || f.cmcMin !== null || f.cmcMax !== null ||
    f.priceMin !== null || f.priceMax !== null,
  );
}

/**
 * The per-row unit price, finish-aware.
 *
 * Foil and non-foil of one printing are different money, so a single
 * `prices->>'usd'` would misprice every foil in the collection.
 */
export const UNIT_PRICE_SQL = `
  CASE cc.finish
    WHEN 'foil'   THEN (s.prices->>'usd_foil')::numeric
    WHEN 'etched' THEN (s.prices->>'usd_etched')::numeric
    ELSE (s.prices->>'usd')::numeric
  END`;

/**
 * Image URL, with the multi-face fallback.
 *
 * 50 of the cards in a real 1457-card collection have NULL top-level
 * `image_uris` because they are transform/modal cards — the art lives on
 * `card_faces[0]`. Without the COALESCE those all render as broken images.
 */
export const IMAGE_SQL = `
  COALESCE(s.image_uris->>'normal', s.card_faces->0->'image_uris'->>'normal')`;

export interface BuiltQuery {
  where: string;
  params: unknown[];
  orderBy: string;
}

/** Build the WHERE clause and bind list. `startIndex` is the next free $n. */
export function buildWhere(f: Filters, collectionId: number): BuiltQuery {
  const clauses = ["cc.collection_id = $1"];
  const params: unknown[] = [collectionId];
  const bind = (v: unknown) => `$${params.push(v)}`;

  if (f.q) {
    // Matches name or type line, so "goblin" finds both the cards named Goblin
    // and every Goblin creature.
    const like = `%${f.q}%`;
    clauses.push(`(s.name ILIKE ${bind(like)} OR s.type_line ILIKE ${bind(like)})`);
  }

  // Colour identity: "has any of these colours", plus an independent colourless
  // toggle. Overlap rather than subset — this is a browser, not a deck legality
  // check, and someone filtering for Green wants to see their Golgari cards.
  if (f.colors.length || f.colorless) {
    const parts: string[] = [];
    if (f.colors.length) parts.push(`s.color_identity && ${bind(f.colors)}::text[]`);
    if (f.colorless) parts.push(`s.color_identity = '{}'::text[]`);
    clauses.push(`(${parts.join(" OR ")})`);
  }

  if (f.rarities.length) clauses.push(`s.rarity = ANY(${bind(f.rarities)}::text[])`);
  if (f.finishes.length) clauses.push(`cc.finish = ANY(${bind(f.finishes)}::text[])`);
  if (f.set) clauses.push(`s.set_code = ${bind(f.set.toLowerCase())}`);

  if (f.types.length) {
    // ILIKE over the whole type_line, so `Sorcery // Land` matches Land.
    const ors = f.types.map((t) => `s.type_line ILIKE ${bind(`%${t}%`)}`);
    clauses.push(`(${ors.join(" OR ")})`);
  }

  if (f.cmcMin !== null) clauses.push(`s.cmc >= ${bind(f.cmcMin)}`);
  if (f.cmcMax !== null) clauses.push(`s.cmc <= ${bind(f.cmcMax)}`);
  if (f.priceMin !== null) clauses.push(`${UNIT_PRICE_SQL} >= ${bind(f.priceMin)}`);
  if (f.priceMax !== null) clauses.push(`${UNIT_PRICE_SQL} <= ${bind(f.priceMax)}`);

  return { where: clauses.join("\n    AND "), params, orderBy: SORTS[f.sort] ?? SORTS.name };
}

export const PAGE_SIZES: Record<View, number> = { grid: 60, table: 250 };

/** Rebuild the query string with one key changed. Page resets on any change
 *  other than paging itself, so narrowing a filter cannot strand you on an
 *  out-of-range page showing nothing. */
export function withParam(
  current: Params,
  key: string,
  value: string | string[] | null,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) if (item) sp.append(k, item);
  }
  sp.delete(key);
  if (value !== null) for (const item of Array.isArray(value) ? value : [value]) sp.append(key, item);
  if (key !== "page") sp.delete("page");
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Toggle one value within a repeated param. */
export function toggleParam(current: Params, key: string, value: string): string {
  const raw = current[key];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((x) => x.split(","));
  const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  return withParam(current, key, next.length ? next : null);
}
