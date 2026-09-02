-- 0004_decks.sql
--
-- Decks, deck contents, and public share links.

CREATE TABLE decks (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'commander',
  description TEXT,

  is_public   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Random slug, not the serial id: public deck URLs should not let anyone
  -- enumerate every deck on the box by counting upward. NULL until shared.
  public_slug TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX decks_public_slug_key ON decks (public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX decks_user_id_idx ON decks (user_id);

CREATE TABLE deck_cards (
  id          SERIAL PRIMARY KEY,
  deck_id     INTEGER NOT NULL REFERENCES decks (id) ON DELETE CASCADE,

  -- Same reasoning as collection_cards: no FK into the rebuildable mirror.
  scryfall_id UUID NOT NULL,

  quantity    INTEGER NOT NULL CHECK (quantity > 0),

  -- 'main' | 'commander' | 'sideboard' | 'maybe'
  -- Commander lives in this table rather than as a decks.commander_id column
  -- so partner/background pairs (two commanders) need no schema change.
  board       TEXT NOT NULL DEFAULT 'main',

  finish      TEXT NOT NULL DEFAULT 'nonfoil',
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX deck_cards_unique_idx ON deck_cards (deck_id, scryfall_id, board, finish);
CREATE INDEX deck_cards_deck_idx ON deck_cards (deck_id);

-- Commander legality is enforced in the app (lib/commander/), NOT by CHECK
-- constraints, for two reasons:
--   1. Singleton is an oracle_id-level rule, and oracle_id lives in the
--      rebuildable mirror — a constraint here would couple user data to cache.
--   2. Banned lists change. A row that was legal when inserted must not
--      become un-updatable later because a constraint now rejects it.
-- The three rules to implement:
--   - Singleton: at most 1 of each oracle_id, except basic lands and cards
--     whose oracle_text contains "A deck can have any number of cards named".
--   - Colour identity: every card's color_identity is a subset of the
--     commander's (union of both, for partners).
--   - Banned: legalities->>'commander' must not be 'banned'.
