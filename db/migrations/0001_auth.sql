-- 0001_auth.sql
--
-- Auth.js v5 (@auth/pg-adapter) core tables, plus a credentials column.
--
-- The four tables below are the adapter's OWN schema — table names, column
-- names, and types are dictated by @auth/pg-adapter, not by us. The quoted
-- camelCase identifiers ("userId", "sessionToken", "emailVerified",
-- "providerAccountId") are required: unquoted, Postgres folds them to
-- lowercase and the adapter's queries stop matching. Do not "tidy" them into
-- snake_case.
--
-- Everything ninetynine adds beyond the adapter is marked NINETY-NINE below.

CREATE TABLE verification_token (
  identifier TEXT NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  token      TEXT NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255),
  email           VARCHAR(255),
  "emailVerified" TIMESTAMPTZ,
  image           TEXT,

  -- NINETY-NINE: the Credentials provider has no adapter-managed storage, so the
  -- hash lives here. NULL is legitimate and expected — a user who only ever
  -- signs in by magic link never sets a password.
  password_hash   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NINETY-NINE: the adapter does not create this, but magic-link sign-in looks
-- users up by email on every attempt, and nothing else enforces uniqueness.
CREATE UNIQUE INDEX users_email_key ON users (LOWER(email));

CREATE TABLE accounts (
  id                  SERIAL PRIMARY KEY,
  "userId"            INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type                VARCHAR(255) NOT NULL,
  provider            VARCHAR(255) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  id_token            TEXT,
  scope               TEXT,
  session_state       TEXT,
  token_type          TEXT
);

CREATE UNIQUE INDEX accounts_provider_account_key
  ON accounts (provider, "providerAccountId");

CREATE TABLE sessions (
  id             SERIAL PRIMARY KEY,
  "userId"       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires        TIMESTAMPTZ NOT NULL,
  "sessionToken" VARCHAR(255) NOT NULL
);

CREATE UNIQUE INDEX sessions_session_token_key ON sessions ("sessionToken");

-- The ON DELETE CASCADE above is also NINETY-NINE: the stock adapter schema
-- leaves "userId" unconstrained. Without it, deleting a user orphans their
-- sessions and they stay valid until expiry.
