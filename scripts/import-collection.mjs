#!/usr/bin/env node
/**
 * Import a collection export into ninetynine.
 *
 *   node scripts/import-collection.mjs db/seed/example-collection.txt \
 *        --user you@example.com --collection-name "Main" --create
 *
 * The collection is being scanned incrementally, so this is built to be re-run:
 * the default conflict mode is `set`, which makes re-importing the same file a
 * no-op rather than doubling every quantity. Pass `--on-conflict add` only when
 * the file really is a batch of newly-acquired cards.
 *
 * Nothing is dropped. Lines that do not resolve are written to
 * `collection_import_issues` and summarised on stderr.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pg from "pg";

// Node >= 22.18 strips types from .ts on import with no flag. Older Node needs
// --experimental-strip-types; fail with that instruction rather than a stack.
let parseMoxfieldText, mergeDuplicates, importCollection;
try {
  ({ parseMoxfieldText, mergeDuplicates } = await import("../lib/import/moxfield-text.ts"));
  ({ importCollection } = await import("../lib/import/resolve.ts"));
} catch (err) {
  if (err?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    console.error(
      "This script imports TypeScript directly. Use Node >= 22.18, or re-run with:\n" +
        "  node --experimental-strip-types scripts/import-collection.mjs ...",
    );
    process.exit(2);
  }
  throw err;
}

const USAGE = `
Usage: node scripts/import-collection.mjs <file> [options]

Target (one of):
  --collection <id>          existing collection id
  --user <id|email> --collection-name <name> [--create]

Options:
  --database-url <url>       defaults to $DATABASE_URL
  --format <name>            source_format recorded on the import (default moxfield_text)
  --language <code>          default en
  --on-conflict set|add      set (default, idempotent) or add (accumulate)
  --no-narrow-name-by-set    disable the name+set fallback; name-only instead
  --dry-run                  resolve and report, write nothing
  --json                     emit the machine-readable summary on stdout
  --limit-issues <n>         how many unresolved lines to print (default 20)
  -h, --help
`.trimStart();

function parseArgs(argv) {
  const opts = {
    file: null,
    collectionId: null,
    user: null,
    collectionName: null,
    create: false,
    databaseUrl: process.env.DATABASE_URL ?? null,
    format: "moxfield_text",
    language: "en",
    onConflict: "set",
    narrowNameBySet: true,
    dryRun: false,
    json: false,
    limitIssues: 20,
  };

  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} requires a value`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--collection":
        opts.collectionId = Number.parseInt(need(i, arg), 10);
        i++;
        break;
      case "--user":
        opts.user = need(i, arg);
        i++;
        break;
      case "--collection-name":
        opts.collectionName = need(i, arg);
        i++;
        break;
      case "--create":
        opts.create = true;
        break;
      case "--database-url":
        opts.databaseUrl = need(i, arg);
        i++;
        break;
      case "--format":
        opts.format = need(i, arg);
        i++;
        break;
      case "--language":
        opts.language = need(i, arg);
        i++;
        break;
      case "--on-conflict":
        opts.onConflict = need(i, arg);
        i++;
        break;
      case "--no-narrow-name-by-set":
        opts.narrowNameBySet = false;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--limit-issues":
        opts.limitIssues = Number.parseInt(need(i, arg), 10);
        i++;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        if (opts.file) throw new Error(`Unexpected extra argument: ${arg}`);
        opts.file = arg;
    }
  }

  if (!opts.file) throw new Error("No input file given.");
  if (!opts.databaseUrl) throw new Error("No database URL. Set DATABASE_URL or pass --database-url.");
  if (!["set", "add"].includes(opts.onConflict)) {
    throw new Error(`--on-conflict must be 'set' or 'add', got '${opts.onConflict}'`);
  }
  if (opts.collectionId === null && !opts.collectionName) {
    throw new Error("Give either --collection <id> or --collection-name <name>.");
  }
  if (opts.collectionId !== null && Number.isNaN(opts.collectionId)) {
    throw new Error("--collection must be an integer id.");
  }
  return opts;
}

/** Resolve --user to a users.id, accepting either the id or the email. */
async function resolveUserId(pool, user) {
  if (/^\d+$/.test(user)) {
    const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [Number(user)]);
    if (!rows.length) throw new Error(`No user with id ${user}`);
    return rows[0].id;
  }
  const { rows } = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [user]);
  if (!rows.length) throw new Error(`No user with email ${user}`);
  return rows[0].id;
}

/**
 * A dry run must not create the collection either — otherwise "report what
 * would happen" leaves a row behind. When the target does not exist yet we hand
 * back an id that cannot match anything; every query in the dry-run path is a
 * read, so it simply sees an empty collection.
 */
const DRY_RUN_PHANTOM_COLLECTION = -1;

async function resolveCollectionId(pool, opts) {
  if (opts.collectionId !== null) {
    const { rows } = await pool.query("SELECT id FROM collections WHERE id = $1", [
      opts.collectionId,
    ]);
    if (!rows.length) throw new Error(`No collection with id ${opts.collectionId}`);
    return rows[0].id;
  }

  if (!opts.user) throw new Error("--collection-name needs --user to scope the lookup.");
  const userId = await resolveUserId(pool, opts.user);

  const { rows } = await pool.query(
    "SELECT id FROM collections WHERE user_id = $1 AND name = $2",
    [userId, opts.collectionName],
  );
  if (rows.length) return rows[0].id;

  if (!opts.create) {
    throw new Error(
      `No collection named "${opts.collectionName}" for user ${userId}. Pass --create to make it.`,
    );
  }
  if (opts.dryRun) {
    console.error(`(dry run) would create collection "${opts.collectionName}" for user ${userId}`);
    return DRY_RUN_PHANTOM_COLLECTION;
  }
  const created = await pool.query(
    "INSERT INTO collections (user_id, name) VALUES ($1, $2) RETURNING id",
    [userId, opts.collectionName],
  );
  return created.rows[0].id;
}

function report(result, opts, parsed, merged) {
  const out = [];
  const tag = result.dryRun ? "DRY RUN — nothing written" : `import #${result.importId}`;
  out.push(`${tag}  collection ${result.collectionId}  (${opts.onConflict} mode)`);
  out.push("");
  out.push(`  parsed lines        ${parsed.cards.length}`);
  if (merged.length !== parsed.cards.length) {
    out.push(`  after in-file merge ${merged.length}`);
  }
  out.push(`  physical cards      ${parsed.totalCards}`);
  out.push(`  resolved            ${result.linesMatched} / ${result.linesTotal}`);
  out.push(`    by set+collector  ${result.resolveCounts.bySetCollector}`);
  if (result.resolveCounts.byNameInSet) {
    out.push(`    by name+set       ${result.resolveCounts.byNameInSet}`);
  }
  if (result.resolveCounts.byName) {
    out.push(`    by name           ${result.resolveCounts.byName}`);
  }
  out.push(`  rows ${result.dryRun ? "would write " : "written     "}   ${result.rowsWritten}`);
  out.push(`    new             ${result.rowsInserted}`);
  out.push(`    updated         ${result.rowsUpdated}`);
  out.push(`  quantity delta      ${result.quantityDelta >= 0 ? "+" : ""}${result.quantityDelta}`);
  out.push(`  issues              ${result.issues}`);
  if (result.issues) {
    out.push(`    parse errors    ${result.issueBreakdown.parse_error}`);
    out.push(`    no match        ${result.issueBreakdown.no_match}`);
    out.push(`    ambiguous       ${result.issueBreakdown.ambiguous}`);
  }
  console.error(out.join("\n"));

  const problems = [
    ...result.parseErrors.map((e) => ({ line: e.lineNumber, raw: e.raw, why: e.reason })),
    ...result.unresolved.map((u) => ({
      line: u.line.lineNumber,
      raw: u.line.raw,
      why: `${u.status} at ${u.stage}${u.candidates.length ? ` (${u.candidates.length} candidates)` : ""}`,
    })),
  ].sort((a, b) => a.line - b.line);

  if (problems.length) {
    console.error(`\nUnresolved (showing ${Math.min(problems.length, opts.limitIssues)} of ${problems.length}):`);
    for (const p of problems.slice(0, opts.limitIssues)) {
      console.error(`  L${String(p.line).padStart(5)}  ${p.why.padEnd(28)} ${p.raw.trim()}`);
    }
    if (!result.dryRun) {
      console.error(`\nAll ${problems.length} recorded in collection_import_issues (import_id = ${result.importId}).`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(process.cwd(), opts.file);
  const text = await readFile(filePath, "utf8");

  const parsed = parseMoxfieldText(text);
  // Folds duplicate lines within one file. Keyed on set+collector+FINISH, so a
  // foil and a plain of the same printing are never folded together.
  const merged = mergeDuplicates(parsed.cards);

  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  try {
    const collectionId = await resolveCollectionId(pool, opts);

    const result = await importCollection(
      pool,
      { cards: merged, errors: parsed.errors },
      {
        collectionId,
        filename: path.relative(path.resolve(here, ".."), filePath),
        sourceFormat: opts.format,
        language: opts.language,
        onConflict: opts.onConflict,
        dryRun: opts.dryRun,
        resolve: { narrowNameBySet: opts.narrowNameBySet },
      },
    );

    report(result, opts, parsed, merged);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ...result,
            // The full objects are large and already summarised above.
            unresolved: result.unresolved.map((u) => ({
              lineNumber: u.line.lineNumber,
              raw: u.line.raw,
              status: u.status,
              stage: u.stage,
              candidates: u.candidates.map((c) => c.id),
            })),
          },
          null,
          2,
        ),
      );
    }

    // Non-zero on unresolved lines so a cron/CI run notices, but only after the
    // data that DID resolve has been committed.
    process.exitCode = result.issues > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`import-collection: ${err.message}`);
  process.exitCode = 2;
});
