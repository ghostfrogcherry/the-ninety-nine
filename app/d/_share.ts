/**
 * Share-link vocabulary for `/d/[slug]`.
 *
 * Both halves of the feature depend on this: `app/d/[slug]/page.tsx` validates
 * an inbound slug with it, and `app/api/decks/[id]/share/route.ts` mints one.
 * It lives next to the public route rather than in `lib/` because the slug
 * format *is* the public URL format — the two should not be able to drift.
 *
 * DELIBERATELY DEPENDENCY-FREE apart from `node:crypto`. No `@/…` imports, no
 * `pg`. `node --experimental-strip-types` does no module resolution and cannot
 * follow the `@/*` tsconfig path alias, so anything imported here would make
 * this file untestable from `test/share.test.ts`. The database work is passed
 * in as an executor (`SqlExec`) instead, which is also what lets the retry path
 * be tested against a fake that raises 23505 on demand.
 *
 * Next only treats `page`/`route`/`layout`/`template`/etc. as routes, so this
 * file sitting inside `app/d/` does not create a `/d/_share` URL.
 */

import { randomBytes } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Slug format                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Crockford-style base32: the digits plus 22 lowercase letters, with `i`, `l`,
 * `o` and `u` removed. Two independent reasons for this alphabet:
 *
 *  - 32 is a power of two, so five random bits map onto one character with NO
 *    modulo bias and no rejection sampling. `bytes[i] % 62` would quietly make
 *    the first few characters of a base62 alphabet more likely.
 *  - Every character is URL-safe unencoded and unambiguous when a link is read
 *    aloud or retyped. Dropping `u` also makes an accidental slur essentially
 *    impossible without a wordlist.
 */
export const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * 20 characters x log2(32) = **100 bits** of entropy, over the 96-bit floor.
 * The whole point of the slug is that it is unguessable and un-walkable: the
 * serial `decks.id` is never part of it, so `/d/1`, `/d/2` … reveals nothing.
 */
export const SLUG_LENGTH = 20;

/** Bits of entropy in one generated slug. Asserted in the tests. */
export const SLUG_ENTROPY_BITS = Math.log2(SLUG_ALPHABET.length) * SLUG_LENGTH;

// Safe to interpolate: the alphabet is alphanumerics only, so it contains no
// character that is special inside a regex character class.
const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

/**
 * Mint a slug from CSPRNG bytes.
 *
 * `randomBytes`, never `Math.random` — V8's PRNG is seeded from a
 * 128-bit state that is recoverable from a handful of outputs, which would
 * make every other share link on the box predictable from one leaked URL.
 *
 * Only the low five bits of each byte are used. Wasting three bits per byte is
 * the price of a bias-free mapping, and 20 bytes is not a resource worth
 * economising on.
 */
export function generateSlug(length: number = SLUG_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += SLUG_ALPHABET[bytes[i]! & 31];
  return out;
}

/**
 * Cheap shape check before the database is touched.
 *
 * This is an optimisation and a garbage filter, NOT the security boundary — the
 * boundary is `public_slug = $1 AND is_public = TRUE` in the query. It exists so
 * that a crawler walking `/d/1`, `/d/2`, `/d/<4kb of junk>` is answered from
 * memory instead of costing a connection each time.
 */
export function isPlausibleSlug(raw: unknown): raw is string {
  return typeof raw === "string" && SLUG_PATTERN.test(raw);
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `lib/db`'s `query` that this module needs. Injected rather than
 * imported — see the file header.
 */
export type SqlExec = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** Postgres unique_violation. Here it can only be `decks_public_slug_key`. */
export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * How many fresh slugs to try before giving up.
 *
 * A collision needs a birthday hit in a 2^100 space against a table that holds
 * tens of rows; the real probability is around 2^-95 per attempt. The retry is
 * not here because it is likely, it is here because the alternative is a 23505
 * escaping as a 500 on the one occasion it ever happens — and because the same
 * code path is what a truncated or misconfigured slug length would land in.
 */
export const SLUG_CLAIM_ATTEMPTS = 5;

export interface ShareState extends Record<string, unknown> {
  public_slug: string;
  is_public: boolean;
}

/**
 * Turn sharing on for a deck the caller owns.
 *
 * Returns `null` when the deck does not exist **or belongs to someone else** —
 * the two are indistinguishable by design, so the caller can answer 404 to both
 * and the endpoint cannot be used to enumerate deck ids.
 *
 * The read and the write are ONE statement. `COALESCE(public_slug, $3)` keeps an
 * existing slug stable across re-shares without a select-then-update window in
 * which two concurrent POSTs could hand out two different URLs for one deck. In
 * that shape the freshly generated candidate is simply discarded when a slug is
 * already present, so a unique violation can only ever come from a slug this
 * call actually tried to claim.
 *
 * `rotate` overwrites unconditionally, which is the "this link leaked, kill it"
 * button: the old URL stops resolving the moment the new slug lands.
 */
export async function enableSharing(
  exec: SqlExec,
  deckId: number,
  userId: number,
  options: { rotate?: boolean } = {},
): Promise<ShareState | null> {
  const rotate = options.rotate === true;
  const sql = `
    UPDATE decks
       SET public_slug = ${rotate ? "$3" : "COALESCE(public_slug, $3)"},
           is_public   = TRUE,
           updated_at  = now()
     WHERE id = $1 AND user_id = $2
     RETURNING public_slug, is_public`;

  for (let attempt = 0; attempt < SLUG_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      const rows = (await exec(sql, [deckId, userId, generateSlug()])) as ShareState[];
      return rows[0] ?? null;
    } catch (error) {
      // The only unique index an UPDATE that never touches `id` can violate is
      // decks_public_slug_key. Anything else is a real fault and must surface.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error(`could not claim a unique public_slug in ${SLUG_CLAIM_ATTEMPTS} attempts`);
}

/**
 * Turn sharing off.
 *
 * `public_slug` is intentionally left in place: `is_public` alone decides
 * whether the URL resolves (see the page query), and keeping the slug means
 * re-sharing later restores the same link rather than silently invalidating one
 * a friend already bookmarked. Use `rotate` when the goal is to invalidate.
 *
 * `null` for "not yours or not there", same as `enableSharing`.
 */
export async function disableSharing(
  exec: SqlExec,
  deckId: number,
  userId: number,
): Promise<ShareState | null> {
  const rows = (await exec(
    `UPDATE decks
        SET is_public = FALSE,
            updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING public_slug, is_public`,
    [deckId, userId],
  )) as ShareState[];
  return rows[0] ?? null;
}

/** The public path a slug is served at. One definition, used by route and API. */
export function sharePath(slug: string): string {
  return `/d/${slug}`;
}
