import bcrypt from "bcryptjs";

/**
 * Password hashing for the Credentials provider.
 *
 * `users.password_hash` is NULLABLE BY DESIGN — a user who only ever signs in
 * by magic link never sets a password. Every function here therefore accepts
 * `string | null | undefined` and *returns false*; none of them throw. A thrown
 * error inside `authorize()` surfaces to the user as a 500-ish "Configuration"
 * error rather than "wrong password", which is both wrong and alarming.
 */

/** bcrypt cost. 12 is ~250ms on modest hardware — fine for a household app. */
export const BCRYPT_ROUNDS = 12;

/**
 * bcrypt only considers the first 72 BYTES of input. Anything past that is
 * silently discarded, which would make two different long passphrases
 * interchangeable. We reject rather than truncate; see `lib/auth/schemas.ts`.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * A real, valid bcrypt hash of a string nobody will ever submit.
 *
 * Used to burn roughly the same CPU time on the "this account has no password"
 * path as on the "wrong password" path. Without it, a NULL password_hash
 * returns in microseconds while a real mismatch takes ~250ms, which tells an
 * attacker exactly which accounts are magic-link-only.
 */
const NO_PASSWORD_PLACEHOLDER_HASH =
  "$2b$12$nhdRJCmSVTjnc/BUjAC9xOgpLLZ7/n0NggcahRTh9GCSog0PodyFm";

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `false` — never throws — when:
 *   - `hash` is NULL/undefined (magic-link-only user),
 *   - `hash` is present but empty or not a parseable bcrypt digest,
 *   - the password simply does not match.
 */
export async function verifyPassword(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (typeof hash !== "string" || hash.length === 0) {
    // Equalise timing, then fail. The comparison result is discarded on
    // purpose: the placeholder is not a credential anyone can present.
    await bcrypt.compare(password, NO_PASSWORD_PLACEHOLDER_HASH).catch(() => false);
    return false;
  }

  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // Malformed digest in the column (hand-edited row, truncated import).
    // Treat as "no valid credential" rather than blowing up the sign-in route.
    return false;
  }
}
