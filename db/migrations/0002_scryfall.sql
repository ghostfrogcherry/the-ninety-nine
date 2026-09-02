-- 0002_scryfall.sql
--
-- Local mirror of the Scryfall "default_cards" bulk export.
--
-- This table is a CACHE, never user data: it is truncated and rebuilt by the
-- weekly refresh. Nothing user-owned may FK to it (see 0003/0004 for how
-- collections and decks reference cards without taking that dependency).
--
-- Bulk data terms: Scryfall asks for <=10 req/s and a cached bulk pull rather
-- than per-card API calls. One download a week is well inside that.

CREATE TABLE scryfall_cards (
  -- Scryfall's own card UUID. Stable per printing, and what ManaBox exports.
  id              UUID PRIMARY KEY,

  -- Stable across printings — every printing of "Sol Ring" shares one
  -- oracle_id. This is the column singleton and banned-list checks key on,
  -- NOT id, because two copies of the same card in different sets are still
  -- a singleton violation.
  oracle_id       UUID NOT NULL,

  name            TEXT NOT NULL,
  set_code        TEXT NOT NULL,
  set_name        TEXT NOT NULL,
  collector_number TEXT NOT NULL,
  rarity          TEXT NOT NULL,
  layout          TEXT NOT NULL,

  mana_cost       TEXT,
  cmc             REAL,
  type_line       TEXT,
  oracle_text     TEXT,

  -- Scryfall returns these as JSON arrays of single-char colour codes.
  -- color_identity is the one Commander cares about; colors is the cast cost.
  colors          TEXT[],
  color_identity  TEXT[] NOT NULL DEFAULT '{}',

  -- {"commander": "legal"|"banned"|"restricted"|"not_legal", "modern": ...}
  legalities      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- {"usd": "1.23", "usd_foil": "4.56", "eur": ..., "tix": ...}
  -- Values are STRINGS in Scryfall's payload, and any of them may be null for
  -- a card with no recorded sale. Cast at read time, do not assume numeric.
  prices          JSONB NOT NULL DEFAULT '{}'::jsonb,

  image_uris      JSONB,
  finishes        TEXT[] NOT NULL DEFAULT '{}',
  released_at     DATE,

  -- Multi-face cards (transform, modal_dfc, split, adventure) put their real
  -- text/mana/images here; the top-level columns are null or summarised.
  card_faces      JSONB,

  -- Which bulk import last wrote this row.
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scryfall_cards_oracle_id_idx ON scryfall_cards (oracle_id);
CREATE INDEX scryfall_cards_set_collector_idx ON scryfall_cards (set_code, collector_number);

-- The importer's fallback lookup path is case-insensitive on name.
CREATE INDEX scryfall_cards_name_lower_idx ON scryfall_cards (LOWER(name));

-- Commander validation filters on legalities->>'commander' and colour identity
-- constantly; GIN over the whole jsonb keeps that off a seq scan.
CREATE INDEX scryfall_cards_legalities_idx ON scryfall_cards USING GIN (legalities);
CREATE INDEX scryfall_cards_color_identity_idx ON scryfall_cards USING GIN (color_identity);

-- Audit trail for the weekly cron. Lets you answer "is the mirror stale?"
-- without inspecting file mtimes on the host.
CREATE TABLE scryfall_bulk_imports (
  id             SERIAL PRIMARY KEY,
  bulk_type      TEXT NOT NULL,       -- e.g. 'default_cards'
  -- Scryfall's own updated_at for the bulk file. If this has not moved since
  -- the last row, the refresh can exit early without re-parsing 500MB.
  source_updated_at TIMESTAMPTZ,
  download_uri   TEXT,
  card_count     INTEGER,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running',  -- running | ok | failed
  error          TEXT
);
