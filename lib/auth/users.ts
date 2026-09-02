import { query } from "@/lib/db";
import { normalizeEmail } from "@/lib/auth/normalize";
import { hashPassword } from "@/lib/auth/password";

/**
 * Direct `users` reads/writes for the Credentials provider.
 *
 * The Auth.js adapter owns this table too, but it has no concept of a password
 * — `@auth/pg-adapter` never selects or writes `password_hash`. Credential
 * sign-in and sign-up therefore go through here, using the SAME table and the
 * SAME normalisation rules the adapter's own email lookups rely on.
 *
 * `users.id` is SERIAL, so `pg` hands it back as a JS number. Auth.js's `User`
 * type declares `id: string`. Every value that crosses into Auth.js is
 * String()-ed at the boundary; mixing the two shows up much later as a session
 * whose `sub` does not match any row.
 */

export interface AuthUserRow extends Record<string, unknown> {
  id: number;
  name: string | null;
  email: string | null;
  image: string | null;
  password_hash: string | null;
}

/** Postgres unique-violation. Raised by `users_email_key` on LOWER(email). */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Look a user up by email, case-insensitively.
 *
 * `LOWER(email) = $1` (not `email ILIKE $1`) is deliberate: it is the exact
 * expression of the `users_email_key` functional index, so this is an index
 * scan rather than a sequential scan with a filter.
 */
export async function findUserByEmail(email: string): Promise<AuthUserRow | null> {
  const rows = await query<AuthUserRow>(
    `SELECT id, name, email, image, password_hash
       FROM users
      WHERE LOWER(email) = $1
      LIMIT 1`,
    [normalizeEmail(email)],
  );
  return rows[0] ?? null;
}

export type CreateUserResult =
  | { ok: true; user: AuthUserRow }
  | { ok: false; reason: "email_taken" };

/**
 * Create a credentials user.
 *
 * The email is stored already-lowercased. Storing the raw casing would still
 * satisfy the index, but then two code paths would disagree about what the
 * canonical spelling is, and `findUserByEmail` would be the only thing keeping
 * them reconciled.
 *
 * A 23505 here means the address exists under some other casing. That is
 * reported as a normal, expected outcome rather than an exception, because for
 * a sign-up form it is normal and expected.
 */
export async function createCredentialsUser(input: {
  name: string | null;
  email: string;
  password: string;
}): Promise<CreateUserResult> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  try {
    const rows = await query<AuthUserRow>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, image, password_hash`,
      [input.name, email, passwordHash],
    );
    const user = rows[0];
    if (!user) return { ok: false, reason: "email_taken" };
    return { ok: true, user };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "email_taken" };
    throw error;
  }
}

/**
 * Set or replace a password on an existing row.
 *
 * This is how a magic-link-only user (password_hash IS NULL) gains a password
 * without a second row being created.
 */
export async function setUserPassword(userId: number | string, password: string): Promise<void> {
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
    Number(userId),
    await hashPassword(password),
  ]);
}

/** True when any user exists. Lets the sign-up page self-close after setup. */
export async function hasAnyUser(): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM users) AS exists`);
  return rows[0]?.exists === true;
}
