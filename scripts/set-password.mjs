#!/usr/bin/env node
/**
 * Set (or clear) a user's password.
 *
 *   docker compose exec app node scripts/set-password.mjs you@example.com
 *
 * There is no password-reset flow in the app yet, and a magic-link-only user
 * has `password_hash` NULL by design, so this is how an account first gets a
 * password.
 *
 * The password is read from a hidden prompt, NOT from argv. An argv password
 * lands in shell history and is visible in `ps` to every user on the box for
 * as long as the process runs. If stdin is not a TTY the script reads one line
 * from it instead, so `... | docker compose exec -T app node scripts/…` works
 * for automation — that path does expose it to history, so prefer the prompt.
 *
 * Env override: NEW_PASSWORD, for callers that already handle secrets safely.
 */

import process from "node:process";

import pg from "pg";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;
/** Matches lib/auth/schemas.ts — keep the two in step. */
const MIN_LENGTH = 8;

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node scripts/set-password.mjs <email> [--clear]");
  console.error("       password is read from a hidden prompt, or $NEW_PASSWORD");
  process.exit(msg ? 1 : 0);
}

/**
 * Read the first line of piped stdin.
 *
 * Deliberately NOT readline: attaching `once("line")` and `once("close")` to a
 * readline interface over an already-ended pipe loses the race — `close` fires
 * first and you silently get an empty string, which then reads as "password too
 * short". Draining the stream and splitting has no such ordering hazard, and
 * handles a missing trailing newline.
 */
async function readPipedLine() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return (data.split(/\r?\n/)[0] ?? "").trim();
}

/** Prompt without echoing. Falls back to a plain read when stdin is a pipe. */
function readSecret(prompt) {
  if (!process.stdin.isTTY) return readPipedLine();

  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const onData = (char) => {
      switch (char) {
        case "\n":
        case "\r":
        case "": // EOT
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          break;
        case "": // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          break;
        case "": // backspace
        case "\b":
          value = value.slice(0, -1);
          break;
        default:
          // Ignore other control characters rather than storing them.
          if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();

const clear = args.includes("--clear");
const email = args.find((a) => !a.startsWith("-"));
if (!email) usage("an email address is required");

if (!process.env.DATABASE_URL) usage("DATABASE_URL is not set");

// The unique index is on LOWER(email), and @auth/pg-adapter looks users up with
// a plain `email = $1`. Normalising here keeps this script from creating the
// mixed-case row that would later break magic-link sign-in. See README.
const normalized = email.trim().toLowerCase();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows } = await client.query(
    "SELECT id, email FROM users WHERE LOWER(email) = $1",
    [normalized],
  );
  if (rows.length === 0) {
    console.error(`no user with email ${normalized}`);
    process.exitCode = 1;
  } else if (clear) {
    await client.query("UPDATE users SET password_hash = NULL WHERE id = $1", [rows[0].id]);
    console.log(`cleared password for ${rows[0].email} (id ${rows[0].id})`);
    console.log("that account can now only sign in by magic link.");
  } else {
    const password = process.env.NEW_PASSWORD ?? (await readSecret("new password: "));
    if (password.length < MIN_LENGTH) {
      console.error(`\npassword must be at least ${MIN_LENGTH} characters; nothing changed`);
      process.exitCode = 1;
    } else {
      if (process.stdin.isTTY && !process.env.NEW_PASSWORD) {
        const again = await readSecret("confirm     : ");
        if (again !== password) {
          console.error("\npasswords did not match; nothing changed");
          process.exitCode = 1;
        }
      }
      if (process.exitCode !== 1) {
        const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
        await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, rows[0].id]);
        console.log(`\npassword set for ${rows[0].email} (id ${rows[0].id})`);
      }
    }
  }
} finally {
  await client.end();
}
