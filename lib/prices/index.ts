/**
 * Price history: the reads behind `/collections/[id]/prices`, plus the pure
 * shaping and SVG geometry the page renders from.
 *
 * Everything here is either a SQL builder or a pure function of numbers, so the
 * chart is testable without a Postgres — series maths, percent change and the
 * path strings themselves are all exercised by test/prices.test.ts.
 *
 *  - ./series.ts  — windows, money, and the value series itself
 *  - ./chart.ts   — plot coordinates and the movers' bar lengths
 *  - ./movers.ts  — what moved between two snapshots, shaped for the table
 *  - ./queries.ts — the SQL, the `Queryable` it runs against, and the loaders
 *
 * Every price in this app is Scryfall market (TCGplayer market, from `usd` /
 * `usd_foil`), the same source `collection_values` and the collection browser
 * use. Nothing here mixes in a retailer ladder, and nothing here is a sale
 * price.
 *
 * NOTHING in lib/prices imports anything at runtime from outside lib/prices,
 * and the files inside it reach each other with an explicit `.ts` extension.
 * test/prices.test.ts loads this barrel through Node's
 * --experimental-strip-types, which performs no module resolution: a single
 * extensionless `import { UNIT_PRICE_SQL } from "../collection/filters"` in any
 * of these files — or an extensionless `from "./series"` in the re-exports
 * below — would kill every pure test in that file with ERR_MODULE_NOT_FOUND,
 * having typechecked perfectly first. Type-only imports are erased and are fine.
 */

// `export *` rather than a hand-written index of names: the page imports from
// `@/lib/prices`, and a list that has to be edited alongside every new export
// is a list that eventually omits one, for a build error a long way from the
// function that was actually added.
export * from "./series.ts";
export * from "./chart.ts";
export * from "./movers.ts";
export * from "./queries.ts";
