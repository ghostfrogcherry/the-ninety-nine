#!/usr/bin/env node
/**
 * Put enough in the database to actually click around, without waiting on a
 * 78 MB Scryfall download or owning any cards.
 *
 *   docker compose exec app node scripts/seed-demo.mjs you@example.com
 *   node scripts/seed-demo.mjs you@example.com --name "Pat"
 *
 * Environment:
 *   DATABASE_URL   required
 *
 * Flags:
 *   --name=NAME          display name for the user (default: the local part)
 *   --collection=NAME    collection name (default "Demo")
 *   --force              seed even though the mirror already holds cards
 *
 * What it does, all from files already committed to this repo:
 *
 *   1. loads db/seed/example-mirror.json into `scryfall_cards`
 *   2. creates the user if that email has none
 *   3. creates a collection and imports db/seed/example-collection.txt into it
 *
 * Why this exists: the fixture mirror was previously reachable only from the
 * test suite, so the first thing a new install could do was download the real
 * bulk file — 78 MB, 117,620 cards — before any page had anything to show. The
 * importer resolves against `scryfall_cards`, so with an empty mirror every
 * line of an import lands in `collection_import_issues` and the collection
 * comes out empty, which looks exactly like a broken importer.
 *
 * It sets NO PASSWORD. A password would either be a default worth attacking or
 * an argument that lands in shell history; `scripts/set-password.mjs` already
 * does this properly from a hidden prompt, and the script points at it when it
 * finishes.
 *
 * This is demo data with public card names, invented ownership and
 * deterministic fake UUIDs — see scripts/make-example-fixture.mjs. It is not a
 * substitute for a real mirror: 17 printings, no prices beyond the fixture's,
 * and no price history at all, because history only accumulates from real
 * refreshes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

// Node >= 22.18 strips types from .ts on import with no flag. Older Node needs
// --experimental-strip-types; fail with that instruction rather than a stack.
// Same guard, same wording as scripts/import-collection.mjs.
let parseMoxfieldText, mergeDuplicates, importCollection;
try {
  ({ parseMoxfieldText, mergeDuplicates } = await import("../lib/import/moxfield-text.ts"));
  ({ importCollection } = await import("../lib/import/resolve.ts"));
} catch (err) {
  if (err?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    console.error(
      "This script imports TypeScript directly. Use Node >= 22.18, or re-run with:\n" +
        "  node --experimental-strip-types scripts/seed-demo.mjs ...",
    );
    process.exit(2);
  }
  throw err;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = path.join(REPO, "db/seed/example-mirror.json");
const COLLECTION = path.join(REPO, "db/seed/example-collection.txt");

function usage(message) {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write("  node scripts/seed-demo.mjs <email> [--name=NAME] [--collection=NAME] [--force]\n");
  process.exit(1);
}

const args = process.argv.slice(2);
let email = null;
const options = { collection: "Demo" };
for (const arg of args) {
  if (arg === "--force") options.force = true;
  else if (arg.startsWith("--name=")) options.name = arg.slice(7);
  else if (arg.startsWith("--collection=")) options.collection = arg.slice(13);
  else if (arg.startsWith("--")) usage(`unknown argument: ${arg}`);
  else if (email === null) email = arg;
  else usage("pass exactly one email address");
}

if (!email) usage("an email address is required");
if (!process.env.DATABASE_URL) usage("DATABASE_URL is not set");

// Lowercase before anything touches users.email. The unique index is on
// LOWER(email) while @auth/pg-adapter looks users up without LOWER(), so a
// mixed-case row is invisible to the adapter AND cannot be re-registered —
// a permanently locked-out account. lib/auth/ does this everywhere; so does this.
email = email.trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+$/.test(email)) usage(`that does not look like an email address: ${email}`);

const log = (m) => process.stdout.write(`${m}\n`);

// A Pool, not a Client: importCollection takes a PoolLike and calls
// .connect() on it to run the import in a single transaction.
const client = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

try {
  const { rows: [{ n: existing }] } = await client.query("SELECT count(*)::int AS n FROM scryfall_cards");
  if (existing > 0 && !options.force) {
    log(`The mirror already holds ${existing} cards.`);
    log("Seeding demo rows on top of a real mirror mixes fake printings into it.");
    log("Pass --force if that is what you want.");
    process.exit(1);
  }

  const mirror = JSON.parse(readFileSync(MIRROR, "utf8"));
  for (const c of mirror) {
    await client.query(
      `INSERT INTO scryfall_cards
         (id, oracle_id, name, set_code, set_name, collector_number, rarity,
          layout, type_line, oracle_text, color_identity, legalities, prices, finishes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13::jsonb,$14::text[])
       ON CONFLICT (id) DO NOTHING`,
      [
        c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number,
        c.rarity, c.layout, c.type_line ?? null, c.oracle_text ?? null,
        c.color_identity ?? [], JSON.stringify(c.legalities ?? {}),
        JSON.stringify(c.prices ?? {}), c.finishes ?? ["nonfoil"],
      ],
    );
  }
  log(`mirror: ${mirror.length} printings seeded`);

  const { rows: found } = await client.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
  let userId = found[0]?.id;
  if (userId) {
    log(`user:   ${email} already exists (id ${userId})`);
  } else {
    const { rows } = await client.query(
      "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
      [options.name ?? email.split("@")[0], email],
    );
    userId = rows[0].id;
    log(`user:   ${email} created (id ${userId})`);
  }

  const { rows: cols } = await client.query(
    `INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, options.collection],
  );
  const collectionId = cols[0].id;

  // The SAME importCollection the CLI and the browser upload call, not a
  // hand-rolled insert loop. Demo data must not be able to resolve by a path
  // real data does not have — otherwise the first thing a new install proves is
  // that a code path nobody ships works.
  const parsed = parseMoxfieldText(readFileSync(COLLECTION, "utf8"));
  const result = await importCollection(
    client,
    { cards: mergeDuplicates(parsed.cards), errors: parsed.errors },
    { collectionId, filename: "example-collection.txt" },
  );
  log(`collection: "${options.collection}" (id ${collectionId}) — `
    + `${result.rowsWritten} printings, ${result.cardsMatched} cards`
    + `, ${result.linesMatched}/${result.linesTotal} lines resolved`
    + (result.issues ? `, ${result.issues} issue(s)` : ""));

  const { rows: [value] } = await client.query(
    "SELECT total_usd FROM collection_values WHERE collection_id = $1", [collectionId],
  );
  if (value) log(`value:  $${Number(value.total_usd).toFixed(2)} at fixture prices`);

  log("");
  log("Set a password before signing in:");
  log(`  docker compose exec app node scripts/set-password.mjs ${email}`);
} finally {
  await client.end();
}
