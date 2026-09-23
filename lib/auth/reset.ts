import { createHash, randomBytes } from "node:crypto";

/**
 * Password-reset tokens — the reads and writes behind `password_reset_tokens`.
 *
 * The rule the whole file exists to keep: **the database never holds a working
 * reset link.** `issueResetToken` is the only function that ever sees a token
 * in the clear, it returns it once, and what it stores is SHA-256 of it. Every
 * lookup hashes its input and matches on that. Lose the database and you have a
 * list of hashes; lose the mailbox and you have the account.
 *
 * Deliberately dependency-free apart from `node:crypto` — no `pg`, no `next`,
 * no `@/` alias — for the same reason `lib/auth/normalize.ts` is: Node's type
 * stripping does no module resolution, so a test can `await import()` this file
 * directly and drive it with a real pool. That is also why the password arrives
 * here **already hashed**: pulling in `./password` would drag bcryptjs and a
 * specifier Node cannot resolve into a module that otherwise needs neither.
 *
 * Nothing here is a timing-sensitive comparison. The token is never compared in
 * JS — Postgres matches on the *hash*, so the only thing a timing difference
 * could leak is a prefix of a value the attacker would still have to preimage.
 */

/* ------------------------------------------------------------------ *
 * Minimal pg-shaped interface (see lib/deck/index.ts)
 * ------------------------------------------------------------------ */

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

/**
 * 32 bytes = 256 bits, base64url-encoded to 43 URL-safe characters.
 *
 * Sized so that guessing is not an attack worth modelling: there is no rate
 * limiter in front of `/reset/<token>`, and this is what makes that acceptable
 * rather than a hole. base64url specifically — the token is a path segment, and
 * `+` and `/` from plain base64 would need escaping on the way into the mail
 * and unescaping on the way back out, which is two more places to get wrong.
 */
export const RESET_TOKEN_BYTES = 32;

/**
 * How long a link lives. An hour is long enough for "check your phone, find
 * the mail, type a passphrase" and short enough that a link sitting in an
 * archived mailbox is not a standing key to the account.
 *
 * Shorter than the magic link's 24 hours on purpose: a magic link grants one
 * session, this grants the password.
 */
export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Floor for the "send me a reset link" path, in milliseconds.
 *
 * A known address costs a user lookup, two writes and an SMTP round trip; an
 * unknown one costs a lookup that finds nothing. Left alone, the difference is
 * a working oracle for "does this person have an account here" — which, for a
 * household server named after its owners' hobby, is a question worth refusing
 * to answer. `takeAtLeast` pads both to this.
 */
export const RESET_REQUEST_FLOOR_MS = 700;

/** A fresh token. The ONLY moment this value exists outside an email. */
export function newResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

/** What actually goes in the table. Hex, so it is greppable in a psql session. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedResetToken {
  /** Clear-text, for the email. Never logged, never stored, never returned twice. */
  token: string;
  expiresAt: Date;
}

/**
 * Issue a reset link for one user, replacing any outstanding ones.
 *
 * The DELETE is not housekeeping, it is the policy: at most one live link per
 * account. Ask for a second link and the first stops working, so an older mail
 * — forwarded, quoted in a support thread, sitting in a shared family inbox —
 * is dead the moment a newer one is requested. The cost is that a user who
 * clicks "send it again" and then opens the *first* mail gets "expired or
 * already used", which is the safe direction to be wrong in.
 *
 * It also bounds the table: one row per user who has ever asked, not one per
 * request.
 */
export async function issueResetToken(
  db: Queryable,
  userId: number,
  ttlMinutes: number = RESET_TOKEN_TTL_MINUTES,
): Promise<IssuedResetToken> {
  const token = newResetToken();

  const { rows } = await db.query(
    `WITH cleared AS (
       DELETE FROM password_reset_tokens WHERE user_id = $1
     )
     INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))
     RETURNING expires_at`,
    [userId, hashResetToken(token), ttlMinutes],
  );

  return { token, expiresAt: rows[0].expires_at as Date };
}

/**
 * Does this token currently open an account, without spending it?
 *
 * For the GET of the reset form only. Consuming on GET would mean a mail client
 * that prefetches links, or a corporate scanner that follows them, burns the
 * token before the user ever sees the form — and the user gets "already used"
 * for a link they have not clicked. State changes belong to the POST.
 *
 * Returns the user id rather than a boolean because the caller may want to
 * scope something to it; it must NOT put it on the page. Which account a link
 * opens is something only the mailbox holder should learn.
 */
export async function findResetTokenUser(db: Queryable, token: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT user_id
       FROM password_reset_tokens
      WHERE token_hash = $1
        AND expires_at > now()`,
    [hashResetToken(token)],
  );
  return rows[0] ? (rows[0].user_id as number) : null;
}

/**
 * Spend the token and set the password, or do nothing at all.
 *
 * One statement, on purpose. `db` may be a Pool, and a Pool hands each query to
 * whichever connection is free — so BEGIN/COMMIT here would be three statements
 * on up to three connections, i.e. no transaction. A single statement with CTEs
 * is atomic by definition and needs no connection pinning, which also keeps
 * this module free of `lib/db`'s transaction helper (and of the alias import
 * that would make it untestable).
 *
 * What the four parts enforce:
 *
 *   claimed  DELETE ... WHERE hash matches AND not expired. Deleting *is* the
 *            claim: two requests racing the same link both try to delete one
 *            row, Postgres serialises them, and the loser's DELETE matches
 *            nothing. Single use and expiry are the same test, so a token
 *            cannot be "expired but still spendable" or the reverse.
 *   updated  The password, keyed off the claim. No claim, no update.
 *   purged   Every OTHER live link for that user. Resetting a password must
 *            invalidate outstanding tokens, including ones an attacker
 *            requested while sitting in the mailbox. `token_hash <> $1` keeps
 *            the two DELETEs disjoint — Postgres explicitly does not define
 *            what happens when two parts of one statement modify the same row,
 *            and the claimed row is already gone by then anyway.
 *
 * Returns the user id on success, null when the link was expired, already
 * spent, or never ours. The caller must report all three identically.
 */
export async function completePasswordReset(
  db: Queryable,
  token: string,
  passwordHash: string,
): Promise<number | null> {
  const tokenHash = hashResetToken(token);

  const { rows } = await db.query(
    `WITH claimed AS (
       DELETE FROM password_reset_tokens
        WHERE token_hash = $1
          AND expires_at > now()
       RETURNING user_id
     ),
     purged AS (
       DELETE FROM password_reset_tokens
        WHERE user_id IN (SELECT user_id FROM claimed)
          AND token_hash <> $1
     ),
     updated AS (
       UPDATE users
          SET password_hash = $2
        WHERE id IN (SELECT user_id FROM claimed)
       RETURNING id
     )
     SELECT id FROM updated`,
    [tokenHash, passwordHash],
  );

  return rows[0] ? (rows[0].id as number) : null;
}

/**
 * Run `work` and return no earlier than `floorMs` from now.
 *
 * The defence for "this address is not registered" being indistinguishable from
 * "it is". Both paths are padded to the same floor, so what an attacker
 * measures is the floor, not the work.
 *
 * Honest about its limits: it can only slow the fast path down, never the slow
 * one up. An SMTP host that takes longer than the floor to accept a message
 * still makes the registered path visibly slower, and nothing short of queueing
 * the mail out of band fixes that — which this app has no worker to do. The
 * floor is set well above a local handoff, which is the deployment this is
 * written for.
 */
export async function takeAtLeast<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const remaining = floorMs - (Date.now() - started);
    // Pad in the `finally` so a thrown error is not the fast path either: a
    // send that blows up must not answer sooner than one that worked.
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
