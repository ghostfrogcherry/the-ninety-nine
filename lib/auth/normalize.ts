/**
 * Email normalisation.
 *
 * `users.email` is protected by a FUNCTIONAL unique index:
 *
 *   CREATE UNIQUE INDEX users_email_key ON users (LOWER(email));
 *
 * so `Bob@Example.com` and `bob@example.com` are the SAME row as far as the
 * database is concerned. If we insert the mixed-case form we get a 23505 that
 * reads as "user already exists" even though the caller typed a spelling that
 * has never been seen before. Normalise on the way in, and match with LOWER()
 * on the way out so the index is actually usable.
 *
 * Deliberately dependency-free (no `pg`, no `next`) so it can be unit-tested
 * with plain `node --test`.
 */

/** Lowercase + trim. The only normalisation the LOWER(email) index implies. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Identifier normaliser for the magic-link provider.
 *
 * Auth.js's built-in default also strips everything after the first comma in
 * the domain, to defend against `a@b.com,c@evil.com` being handed to an SMTP
 * server that treats it as two recipients. Keep that behaviour and add our
 * lowercase rule on top.
 */
export function normalizeIdentifier(identifier: string): string {
  const [local, domain] = normalizeEmail(identifier).split("@");
  if (!domain) return local ?? "";
  return `${local}@${domain.split(",")[0]}`;
}
