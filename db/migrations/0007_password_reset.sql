-- 0007_password_reset.sql
--
-- Password reset by email.
--
-- Until now a household member who forgot their password needed someone with
-- shell access to run scripts/set-password.mjs against the container. This
-- table is what replaces that errand: a short-lived, one-shot claim on exactly
-- one user's password, provable only by holding the mailbox.
--
-- The column is token_hash, NOT token, and that is the entire point of the
-- table's shape. A reset token is a bearer credential — whoever holds it owns
-- the account for the next hour — so a database dump, a backup on a NAS, a
-- `SELECT *` over someone's shoulder or a query landing in a log must not hand
-- out a working link. The token exists in exactly two places: the email, and
-- the URL the user clicks. What is stored here can verify one and cannot
-- produce one.
--
-- SHA-256, not bcrypt, which is the opposite of the choice made for
-- users.password_hash in 0001. Two reasons, and both of them are about the
-- token not being a password:
--   1. It is 32 bytes of crypto.randomBytes, not something a human picked, so
--      there is no dictionary to walk and a deliberately slow hash buys
--      nothing — an attacker holding this table still has 2^256 to search.
--   2. The lookup is BY the token, with no user_id to narrow it first. That
--      needs an indexed equality test. A bcrypt digest carries a per-row salt,
--      so finding a match would mean scanning every row and running bcrypt
--      against each one — ~250ms per row, on the unauthenticated path.
--
-- There is no `used` flag: consuming a token DELETEs the row (lib/auth/reset.ts
-- does it with DELETE ... RETURNING), so "single use" is just whether the row
-- still exists, and one statement decides used-ness and expiry together. A
-- boolean would be a second piece of state to read, write and get wrong, and a
-- row that stays behind after a reset is a hash of a token that should no
-- longer exist at all.

CREATE TABLE password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Hex SHA-256 of the token that went out in the email. 64 characters; TEXT
  -- rather than CHAR(64) for the same reason collector numbers are TEXT — a
  -- fixed width here would only be a promise the application has to keep.
  token_hash TEXT NOT NULL,

  -- Absolute, not a TTL to add on read: the deadline is decided when the link
  -- is mailed, so a clock change or a slow queue cannot silently extend it.
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE rather than a plain index. The lookup is `WHERE token_hash = $1` with
-- nothing else to disambiguate it, so two rows sharing a hash would make "which
-- account does this link open?" a question with two answers. Reaching this
-- constraint requires either a SHA-256 collision or randomBytes repeating
-- itself, so in practice it is an assertion that neither happened.
CREATE UNIQUE INDEX password_reset_tokens_hash_key ON password_reset_tokens (token_hash);

-- Both writes that are not the lookup are `WHERE user_id = $1`: issuing a link
-- clears that user's outstanding ones (at most one live link per account, so a
-- stolen older email dies the moment a newer one is asked for), and completing
-- a reset clears them again — including the one just used. ON DELETE CASCADE
-- above covers the user going away; this index covers those two.
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);
