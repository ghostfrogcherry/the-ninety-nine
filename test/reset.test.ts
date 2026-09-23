/**
 * Password reset and outbound mail — `lib/auth/reset.ts`, `lib/auth/mail.ts`,
 * `lib/auth/messages.ts`.
 *
 *   npm test
 *
 * The pure tests always run — including the SMTP ones, which talk to a fake
 * server this file starts on loopback, so no mail host is needed. The database
 * tests run only when TEST_DATABASE_URL is set, in a throwaway database of this
 * file's own — test/_db.ts has the setup, and why it is never DATABASE_URL.
 * That is also what cleans up `verification_token`, which hangs off no user and
 * so reaches no cascade: a magic-link row used to outlive the user it was for
 * unless this file remembered to delete it by hand.
 *
 * The split import style is the one test/auth.test.ts explains: types from the
 * extensionless path (erased before Node sees it), values from a dynamic import
 * whose specifier is a variable (so TypeScript does not try to resolve a `.ts`
 * extension it forbids). It is also why `lib/auth/reset.ts` imports nothing but
 * `node:crypto` — a `@/`-aliased import anywhere in that file would make it
 * unloadable here.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import bcrypt from "bcryptjs";
import pg from "pg";
import PostgresAdapter from "@auth/pg-adapter";

import { SKIP_WITHOUT_DATABASE, createTestDatabase, type TestDatabase } from "./_db.ts";

import type * as MailModule from "../lib/auth/mail";
import type * as MessagesModule from "../lib/auth/messages";
import type * as ResetModule from "../lib/auth/reset";

const resetSpecifier = "../lib/auth/reset.ts";
const mailSpecifier = "../lib/auth/mail.ts";
const messagesSpecifier = "../lib/auth/messages.ts";

const {
  RESET_TOKEN_TTL_MINUTES,
  completePasswordReset,
  findResetTokenUser,
  hashResetToken,
  issueResetToken,
  newResetToken,
  takeAtLeast,
} = (await import(resetSpecifier)) as typeof ResetModule;

const { appBaseUrl, isMailConfigured, mailDestination, sendMail } = (await import(
  mailSpecifier
)) as typeof MailModule;

const { passwordResetEmail, signInEmail } = (await import(
  messagesSpecifier
)) as typeof MessagesModule;

/* ================================================================== *
 * Pure — tokens
 * ================================================================== */

describe("reset tokens", () => {
  it("emits URL-safe tokens with no encoding needed on the way into a path", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = newResetToken();
      // The charset lib/auth/schemas.ts rejects everything outside of. If this
      // ever widens, the schema stops accepting our own links.
      assert.match(token, /^[A-Za-z0-9_-]+$/);
      assert.equal(encodeURIComponent(token), token, "a token must survive a URL untouched");
    }
  });

  it("is 256 bits of randomness, not a counter", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newResetToken());
    assert.equal(seen.size, 500, "two identical tokens in 500 draws is not randomness");
    // 32 bytes base64url = 43 characters, no padding.
    assert.equal(newResetToken().length, 43);
  });

  it("hashes to something that cannot be turned back into a link", () => {
    const token = newResetToken();
    const hash = hashResetToken(token);

    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, token);
    assert.ok(!hash.includes(token), "the hash must not contain the token");
    // Stable, and a plain SHA-256 — the migration's comment says so, and a
    // future "improvement" to a salted hash would break every live link.
    assert.equal(hash, hashResetToken(token));
    assert.equal(hash, createHash("sha256").update(token, "utf8").digest("hex"));
    assert.notEqual(hash, hashResetToken(`${token}x`));
  });
});

/* ================================================================== *
 * Pure — the timing floor
 * ================================================================== */

describe("takeAtLeast", () => {
  it("returns the work's value, no earlier than the floor", async () => {
    const started = Date.now();
    const value = await takeAtLeast(120, async () => "done");
    assert.equal(value, "done");
    // Timers fire no earlier than asked but may fire a touch late; the claim is
    // a floor, so only the lower bound is asserted (with 5ms of slack for the
    // coarse clock).
    assert.ok(Date.now() - started >= 115, "returned before the floor");
  });

  it("does not shorten work that already takes longer", async () => {
    const started = Date.now();
    await takeAtLeast(20, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.ok(Date.now() - started >= 115);
  });

  /**
   * THE case it exists for. A throw must not be the fast path either: if a
   * failed lookup or a refused SMTP connection returned immediately, "no such
   * account" would be measurable even with the happy path padded.
   */
  it("pads a failure to the same floor", async () => {
    const started = Date.now();
    await assert.rejects(
      takeAtLeast(120, async () => {
        throw new Error("smtp refused");
      }),
      /smtp refused/,
    );
    assert.ok(Date.now() - started >= 115, "a throw returned faster than success");
  });
});

/* ================================================================== *
 * Pure — message bodies
 * ================================================================== */

describe("email bodies", () => {
  const url = "https://cards.example.test:3010/reset/abc-123_XYZ";

  it("puts the link verbatim in the plain-text part", () => {
    const mail = passwordResetEmail("bob@example.test", url, RESET_TOKEN_TTL_MINUTES);
    assert.ok(mail.text.includes(url), "a text-only mail client must still get the link");
    assert.ok(mail.html.includes(`href="${url}"`));
  });

  it("names the host it is for, so it can be told from a phishing copy", () => {
    const mail = passwordResetEmail("bob@example.test", url, RESET_TOKEN_TTL_MINUTES);
    assert.ok(mail.subject.includes("cards.example.test:3010"));
    assert.ok(mail.text.includes("cards.example.test:3010"));
  });

  it("says how long the link lasts and that it is single use", () => {
    const mail = passwordResetEmail("bob@example.test", url, 60);
    assert.ok(mail.text.includes("60 minutes"));
    assert.match(mail.text, /used once/);
    // The "I did not ask for this" reassurance: ignoring it must be enough.
    assert.match(mail.text, /password has not changed/);
  });

  it("keeps the sign-in mail distinguishable from the reset mail", () => {
    const signIn = signInEmail("bob@example.test", "https://cards.example.test/api/auth/callback/x");
    assert.match(signIn.subject, /Sign in/);
    assert.equal(signIn.to, "bob@example.test");
    assert.ok(!signIn.subject.includes("Reset"));
  });
});

/* ================================================================== *
 * Mail configuration and delivery
 *
 * These mutate process.env. Node's test runner gives each FILE its own
 * process, so this cannot reach another test file — but they are restored
 * anyway, because two describes in this file would otherwise see each other's
 * leftovers.
 * ================================================================== */

const MAIL_ENV = ["EMAIL_FROM", "MAIL_CAPTURE_DIR", "SMTP_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "AUTH_URL", "NEXTAUTH_URL"] as const;

const savedEnv = new Map<string, string | undefined>();
function clearMailEnv() {
  for (const key of MAIL_ENV) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}
function restoreMailEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

describe("mail destination", () => {
  before(clearMailEnv);
  after(restoreMailEnv);

  it("is absent until there is somewhere to send", () => {
    clearMailEnv();
    assert.equal(mailDestination(), null);
    assert.equal(isMailConfigured(), false);

    // Half-configured is still absent: EMAIL_FROM alone offers a magic-link
    // form whose mail silently never arrives, which is worse than no form.
    process.env.EMAIL_FROM = "cards@example.test";
    assert.equal(mailDestination(), null);
    assert.equal(isMailConfigured(), false);
  });

  it("takes a capture directory as a destination in its own right", () => {
    clearMailEnv();
    process.env.EMAIL_FROM = "cards@example.test";
    process.env.MAIL_CAPTURE_DIR = "/tmp/nn-mail";
    assert.deepEqual(mailDestination(), {
      kind: "capture",
      from: "cards@example.test",
      dir: "/tmp/nn-mail",
    });
    assert.equal(isMailConfigured(), true);
  });

  it("prefers SMTP when both are set, so a stale capture dir cannot eat real mail", () => {
    clearMailEnv();
    process.env.EMAIL_FROM = "cards@example.test";
    process.env.MAIL_CAPTURE_DIR = "/tmp/nn-mail";
    process.env.SMTP_HOST = "smtp.example.test";
    const dest = mailDestination();
    assert.equal(dest?.kind, "smtp");
  });

  it("reads the two SMTP spellings, and infers implicit TLS from port 465", () => {
    clearMailEnv();
    process.env.EMAIL_FROM = "cards@example.test";
    process.env.SMTP_URL = "smtp://user:pass@host.example.test:587";
    assert.deepEqual(mailDestination(), {
      kind: "smtp",
      from: "cards@example.test",
      server: "smtp://user:pass@host.example.test:587",
    });

    clearMailEnv();
    process.env.EMAIL_FROM = "cards@example.test";
    process.env.SMTP_HOST = "host.example.test";
    process.env.SMTP_PORT = "465";
    const dest = mailDestination();
    assert.equal(dest?.kind === "smtp" && typeof dest.server === "object" && dest.server.secure, true);
  });
});

describe("appBaseUrl", () => {
  before(clearMailEnv);
  after(restoreMailEnv);

  /**
   * Links are built from AUTH_URL and never from the request's Host header.
   * A null here means no mail goes out, which is the right failure: a reset
   * link pointing at an attacker-supplied origin hands over the token.
   */
  it("is null unless the operator said what this server is called", () => {
    clearMailEnv();
    assert.equal(appBaseUrl(), null);
    process.env.AUTH_URL = "not a url";
    assert.equal(appBaseUrl(), null);
  });

  it("normalises so callers can always concatenate a path", () => {
    clearMailEnv();
    process.env.AUTH_URL = "http://nas.example.test:3010/";
    assert.equal(appBaseUrl(), "http://nas.example.test:3010");
    process.env.AUTH_URL = "http://nas.example.test:3010/cards/";
    assert.equal(appBaseUrl(), "http://nas.example.test:3010/cards");
  });
});

describe("capture destination", () => {
  let dir: string;

  before(async () => {
    clearMailEnv();
    dir = await mkdtemp(path.join(tmpdir(), "nn-mail-"));
    process.env.EMAIL_FROM = "cards@example.test";
    process.env.MAIL_CAPTURE_DIR = dir;
  });

  after(async () => {
    restoreMailEnv();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the message to disk, link and all, without dialling anything", async () => {
    const url = "http://nas.example.test:3010/reset/tok-en_123";
    await sendMail(passwordResetEmail("bob@example.test", url, 60));

    const files = (await readdir(dir)).filter((f) => f.endsWith(".eml"));
    assert.equal(files.length, 1);

    const eml = await readFile(path.join(dir, files[0]!), "utf8");
    assert.ok(eml.includes(url), "the whole point is being able to click the link");
    assert.match(eml, /^To: bob@example\.test$/m);
    assert.match(eml, /^From: cards@example\.test$/m);
    assert.match(eml, /^Content-Type: multipart\/alternative/m);
    // Headers end at the first blank line, RFC 5322 style, or a mail client
    // shows the body as headers.
    assert.ok(eml.includes("\r\n\r\n"));
  });

  it("does not overwrite a second message sent in the same millisecond", async () => {
    await Promise.all([
      sendMail(passwordResetEmail("a@example.test", "http://x.test/reset/a", 60)),
      sendMail(passwordResetEmail("b@example.test", "http://x.test/reset/b", 60)),
    ]);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".eml"));
    assert.equal(files.length, 3, "one file per message, including the one above");
  });
});

/* ================================================================== *
 * SMTP, against a real socket
 *
 * The thing this project had never once exercised. A ~40-line SMTP sink is
 * enough to prove the nodemailer path actually speaks the protocol, hands over
 * the right envelope and puts the link in the body — which a capture-directory
 * test cannot prove, because it never reaches nodemailer at all.
 * ================================================================== */

interface CapturedMessage {
  mailFrom: string;
  rcptTo: string[];
  data: string;
}

/** Minimal SMTP sink: EHLO, MAIL, RCPT, DATA, QUIT. Advertises no extensions. */
async function startSmtpSink(): Promise<{
  port: number;
  messages: CapturedMessage[];
  close: () => Promise<void>;
}> {
  const messages: CapturedMessage[] = [];

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: CapturedMessage = { mailFrom: "", rcptTo: [], data: "" };

    socket.setEncoding("utf8");
    socket.write("220 nn-test ESMTP\r\n");

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      for (;;) {
        if (inData) {
          // The message ends at a lone dot on its own line.
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          current.data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { mailFrom: "", rcptTo: [], data: "" };
          socket.write("250 OK queued\r\n");
          continue;
        }

        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();

        if (verb === "EHLO" || verb === "HELO") {
          // No STARTTLS and no AUTH advertised, so nodemailer stays in the
          // plaintext path a local relay would also offer.
          socket.write("250-nn-test\r\n250 SIZE 10485760\r\n");
        } else if (verb === "MAIL") {
          current.mailFrom = line;
          socket.write("250 OK\r\n");
        } else if (verb === "RCPT") {
          current.rcptTo.push(line);
          socket.write("250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
          return;
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });

    socket.on("error", () => {
      /* client hang-ups are not this sink's problem */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    port: address.port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("SMTP delivery", () => {
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;

  before(async () => {
    clearMailEnv();
    sink = await startSmtpSink();
    process.env.EMAIL_FROM = "cards@example.test";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(sink.port);
    process.env.SMTP_SECURE = "false";
  });

  after(async () => {
    restoreMailEnv();
    await sink.close();
  });

  it("actually speaks SMTP: envelope, headers and a clickable link", async () => {
    const url = "http://nas.example.test:3010/reset/smtp-path_token";
    await sendMail(passwordResetEmail("bob@example.test", url, 60));

    assert.equal(sink.messages.length, 1);
    const message = sink.messages[0]!;
    assert.match(message.mailFrom, /cards@example\.test/);
    assert.equal(message.rcptTo.length, 1);
    assert.match(message.rcptTo[0]!, /bob@example\.test/);
    assert.match(message.data, /^Subject: .*Reset your ninetynine password/m);
    // Quoted-printable may split a long URL across lines with a soft break, so
    // match the distinctive tail rather than the whole thing.
    assert.ok(
      message.data.includes(url) || message.data.replace(/=\r\n/g, "").includes(url),
      "the reset link did not survive the transfer encoding",
    );
  });

  it("carries the magic-link mail down the same path", async () => {
    const url = "http://nas.example.test:3010/api/auth/callback/nodemailer?token=abc&email=bob";
    await sendMail(signInEmail("bob@example.test", url));

    const message = sink.messages.at(-1)!;
    assert.match(message.data, /^Subject: .*Sign in to ninetynine/m);
    assert.ok(message.data.replace(/=\r\n/g, "").includes("/api/auth/callback/nodemailer"));
  });
});

/* ================================================================== *
 * Against Postgres
 * ================================================================== */

describe("password reset against postgres", { skip: SKIP_WITHOUT_DATABASE }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  const stamp = `${process.pid}-${Date.now()}`;

  const PASSWORD = "the-old-password";
  const NEW_PASSWORD = "a-brand-new-passphrase";

  async function newUser(label: string, withPassword: boolean): Promise<{ id: number; email: string }> {
    // Lowercase on the way in, always: users_email_key is UNIQUE on
    // LOWER(email) and @auth/pg-adapter looks up with a plain `email = $1`.
    const email = `reset-${label}-${stamp}@ninetynine.invalid`.toLowerCase();
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [`reset test ${label}`, email, withPassword ? bcrypt.hashSync(PASSWORD, 10) : null],
    );
    return { id: rows[0].id as number, email };
  }

  async function passwordHashOf(userId: number): Promise<string | null> {
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    return rows[0].password_hash as string | null;
  }

  async function tokenRowCount(userId: number): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1`,
      [userId],
    );
    return rows[0].n as number;
  }

  before(async () => {
    db = await createTestDatabase("reset");
    pool = new pg.Pool({ connectionString: db.url, max: 4 });
  });

  after(async () => {
    // No row-by-row cleanup: the whole database goes. See test/_db.ts.
    await pool?.end();
    await db?.drop();
  });

  /* ---------------------------------------------------------------- *
   * The schema property the whole design rests on
   * ---------------------------------------------------------------- */

  describe("what the table stores", () => {
    it("stores a hash and nothing else that could rebuild the link", async () => {
      const user = await newUser("storage", true);
      const { token } = await issueResetToken(pool, user.id);

      const { rows } = await pool.query(
        `SELECT * FROM password_reset_tokens WHERE user_id = $1`,
        [user.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_hash, hashResetToken(token));

      // A database read must not yield a working reset link: no column, in any
      // representation, contains the token itself.
      const dumped = JSON.stringify(rows[0]);
      assert.ok(!dumped.includes(token), `a column leaked the token: ${dumped}`);
    });

    it("refuses two rows with one hash — the lookup has no user_id to disambiguate", async () => {
      const user = await newUser("unique", true);
      const { token } = await issueResetToken(pool, user.id);
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, now() + interval '1 hour')`,
            [user.id, hashResetToken(token)],
          ),
        (e: { code?: string }) => e.code === "23505",
      );
    });

    it("cascades: deleting a user takes their outstanding links with them", async () => {
      const doomed = await newUser("cascade", true);
      await issueResetToken(pool, doomed.id);
      await pool.query("DELETE FROM users WHERE id = $1", [doomed.id]);
      assert.equal(await tokenRowCount(doomed.id), 0);
    });
  });

  /* ---------------------------------------------------------------- *
   * Issue
   * ---------------------------------------------------------------- */

  describe("issuing a link", () => {
    it("replaces the user's outstanding link rather than adding to it", async () => {
      const user = await newUser("replace", true);
      const first = await issueResetToken(pool, user.id);
      const second = await issueResetToken(pool, user.id);

      assert.equal(await tokenRowCount(user.id), 1, "at most one live link per account");
      assert.equal(await findResetTokenUser(pool, first.token), null, "the older link must die");
      assert.equal(await findResetTokenUser(pool, second.token), user.id);
    });

    it("dates the expiry from the moment it is issued", async () => {
      const user = await newUser("expiry", true);
      const { expiresAt } = await issueResetToken(pool, user.id, 60);
      const minutes = (expiresAt.getTime() - Date.now()) / 60_000;
      assert.ok(minutes > 55 && minutes <= 61, `expected ~60 minutes, got ${minutes}`);
    });

    it("issues to a magic-link-only user, whose password_hash is NULL by design", async () => {
      const user = await newUser("magic-issue", false);
      assert.equal(await passwordHashOf(user.id), null);
      const { token } = await issueResetToken(pool, user.id);
      assert.equal(await findResetTokenUser(pool, token), user.id);
    });
  });

  /* ---------------------------------------------------------------- *
   * Consume
   * ---------------------------------------------------------------- */

  describe("spending a link", () => {
    it("sets the password and returns whose it was", async () => {
      const user = await newUser("spend", true);
      const { token } = await issueResetToken(pool, user.id);

      const hash = bcrypt.hashSync(NEW_PASSWORD, 10);
      assert.equal(await completePasswordReset(pool, token, hash), user.id);

      const stored = await passwordHashOf(user.id);
      assert.equal(stored, hash);
      assert.equal(bcrypt.compareSync(NEW_PASSWORD, stored!), true);
      assert.equal(bcrypt.compareSync(PASSWORD, stored!), false, "the old password must stop working");
    });

    it("is single use: the second attempt changes nothing", async () => {
      const user = await newUser("single-use", true);
      const { token } = await issueResetToken(pool, user.id);

      const first = bcrypt.hashSync(NEW_PASSWORD, 10);
      assert.equal(await completePasswordReset(pool, token, first), user.id);
      assert.equal(await tokenRowCount(user.id), 0, "spending must delete the row");

      const second = bcrypt.hashSync("attacker-chosen", 10);
      assert.equal(await completePasswordReset(pool, token, second), null);
      assert.equal(await passwordHashOf(user.id), first, "a spent link must not rewrite the password");
      // And the read path agrees with the write path about it being gone.
      assert.equal(await findResetTokenUser(pool, token), null);
    });

    it("refuses an expired link, by the same test that refuses a spent one", async () => {
      const user = await newUser("expired", true);
      // Negative TTL: issued already dead, so nothing has to sleep.
      const { token } = await issueResetToken(pool, user.id, -1);

      assert.equal(await findResetTokenUser(pool, token), null);
      assert.equal(await completePasswordReset(pool, token, bcrypt.hashSync("nope", 10)), null);
      assert.equal(bcrypt.compareSync(PASSWORD, (await passwordHashOf(user.id))!), true);
    });

    it("refuses a token that was never issued here", async () => {
      const user = await newUser("forged", true);
      await issueResetToken(pool, user.id);
      assert.equal(await completePasswordReset(pool, newResetToken(), bcrypt.hashSync("no", 10)), null);
      assert.equal(bcrypt.compareSync(PASSWORD, (await passwordHashOf(user.id))!), true);
    });

    /**
     * The property that matters when someone else is already in the mailbox:
     * completing a reset must invalidate every outstanding link for that user,
     * not just the one being spent. The second row is inserted directly because
     * `issueResetToken` refuses to leave two behind — this is the state a
     * racing request, or a future second issuer, could still produce.
     */
    it("invalidates every other outstanding link for that user", async () => {
      const user = await newUser("purge", true);
      const lurking = newResetToken();
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, hashResetToken(lurking)],
      );
      const { token } = await issueResetToken(pool, user.id);
      // issueResetToken cleared the lurking one; put it back to model the race.
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, hashResetToken(lurking)],
      );
      assert.equal(await tokenRowCount(user.id), 2);

      assert.equal(await completePasswordReset(pool, token, bcrypt.hashSync(NEW_PASSWORD, 10)), user.id);
      assert.equal(await tokenRowCount(user.id), 0, "the lurking link must die with the used one");
      assert.equal(await findResetTokenUser(pool, lurking), null);
    });

    it("cannot reach another account", async () => {
      const mine = await newUser("mine", true);
      const theirs = await newUser("theirs", true);
      const before = await passwordHashOf(theirs.id);

      const { token } = await issueResetToken(pool, mine.id);
      assert.equal(await completePasswordReset(pool, token, bcrypt.hashSync(NEW_PASSWORD, 10)), mine.id);
      assert.equal(await passwordHashOf(theirs.id), before, "someone else's password moved");
      assert.equal(await tokenRowCount(theirs.id), 0);
    });

    it("only one of two racing attempts on one link wins", async () => {
      const user = await newUser("race", true);
      const { token } = await issueResetToken(pool, user.id);

      const a = bcrypt.hashSync("winner-a", 10);
      const b = bcrypt.hashSync("winner-b", 10);
      const results = await Promise.all([
        completePasswordReset(pool, token, a),
        completePasswordReset(pool, token, b),
      ]);

      assert.equal(results.filter((r) => r !== null).length, 1, "the DELETE is the claim");
      const stored = await passwordHashOf(user.id);
      assert.ok(stored === a || stored === b);
    });
  });

  /* ---------------------------------------------------------------- *
   * Magic link: the flow this app had never exercised, and the case
   * where the two flows meet.
   * ---------------------------------------------------------------- */

  describe("magic link, through @auth/pg-adapter itself", () => {
    it("round-trips a verification token, once", async () => {
      const user = await newUser("magic-flow", false);
      const adapter = PostgresAdapter(pool);

      const token = newResetToken(); // any opaque string; shape is the adapter's business
      await adapter.createVerificationToken!({
        identifier: user.email,
        token,
        expires: new Date(Date.now() + 60_000),
      });

      const used = await adapter.useVerificationToken!({ identifier: user.email, token });
      assert.equal(used?.token, token);
      // Single use, same as ours: the adapter DELETEs ... RETURNING.
      assert.equal(await adapter.useVerificationToken!({ identifier: user.email, token }), null);
    });

    /**
     * The README's warning, asserted rather than described: the adapter looks
     * users up with `select * from users where email = $1` and no LOWER(), so
     * a row stored mixed-case is invisible to it. It then falls through to
     * createUser and dies on users_email_key — locking that account out for
     * good. Everything in lib/auth/ lowercases on the way in, which is what
     * keeps this from happening; this test is what will notice if that stops.
     */
    it("finds a lowercase row and misses a mixed-case one", async () => {
      const lower = await newUser("magic-lookup", false);
      const adapter = PostgresAdapter(pool);

      assert.equal((await adapter.getUserByEmail!(lower.email))?.email, lower.email);
      // What the adapter would be handed for a mixed-case sign-in attempt if
      // normalizeIdentifier were ever removed from the provider.
      assert.equal(await adapter.getUserByEmail!(lower.email.toUpperCase()), null);

      // And the row that must never be written: stored mixed-case, therefore
      // permanently unfindable by the adapter, and unfixable by re-registering
      // because LOWER(email) is already taken.
      const mixed = `Reset-Mixed-${stamp}@Ninetynine.Invalid`;
      await pool.query(`INSERT INTO users (name, email) VALUES ($1, $2)`, ["mixed case", mixed]);
      assert.equal(await adapter.getUserByEmail!(mixed.toLowerCase()), null, "this is the trap");
      await assert.rejects(
        () => pool.query(`INSERT INTO users (name, email) VALUES ($1, $2)`, ["dup", mixed.toLowerCase()]),
        (e: { code?: string }) => e.code === "23505",
        "and this is why it is permanent",
      );
    });

    /**
     * A magic-link-only user gaining a password must not cost them their magic
     * link. Nothing about the reset touches `email`, `emailVerified` or any
     * verification token — it writes exactly one column.
     */
    it("leaves magic-link sign-in working after a reset sets a password", async () => {
      const user = await newUser("magic-then-password", false);
      const adapter = PostgresAdapter(pool);

      const before = await pool.query(
        `SELECT email, "emailVerified", image, name FROM users WHERE id = $1`,
        [user.id],
      );

      const { token } = await issueResetToken(pool, user.id);
      const hash = bcrypt.hashSync(NEW_PASSWORD, 10);
      assert.equal(await completePasswordReset(pool, token, hash), user.id);

      const after_ = await pool.query(
        `SELECT email, "emailVerified", image, name FROM users WHERE id = $1`,
        [user.id],
      );
      assert.deepEqual(after_.rows[0], before.rows[0], "a reset must touch password_hash only");
      assert.equal(await passwordHashOf(user.id), hash);

      // And the magic-link half still works end to end for that address.
      const magicToken = newResetToken();
      await adapter.createVerificationToken!({
        identifier: user.email,
        token: magicToken,
        expires: new Date(Date.now() + 60_000),
      });
      // Number(), because the adapter returns the SERIAL column as a JS number
      // while Auth.js types `User.id` as a string — the exact mismatch
      // lib/auth/users.ts String()s at the boundary.
      assert.equal(Number((await adapter.getUserByEmail!(user.email))?.id), user.id);
      assert.equal(
        (await adapter.useVerificationToken!({ identifier: user.email, token: magicToken }))?.token,
        magicToken,
      );
    });
  });
});
