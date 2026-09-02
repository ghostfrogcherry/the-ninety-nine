-- 0003_collections.sql
--
-- Per-user collections.
--
-- Shape here is derived from the real export (1457 lines / 1705 physical cards,
-- reconciled line-by-line against a resolved card index), not from a guess at
-- the format. See lib/import/ for the parser.

CREATE TABLE collections (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_public  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX collections_user_id_idx ON collections (user_id);

CREATE TABLE collection_cards (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections (id) ON DELETE CASCADE,

  -- Deliberately NOT a foreign key to scryfall_cards. That table is a cache
  -- rebuilt from the weekly bulk download; a FK would either block the refresh
  -- or cascade-delete real user data when Scryfall reshuffles a printing.
  -- Integrity is checked in the app on import instead (unresolved rows land in
  -- collection_import_issues below).
  scryfall_id   UUID NOT NULL,

  quantity      INTEGER NOT NULL CHECK (quantity > 0),

  -- 'nonfoil' | 'foil' | 'etched' | 'glossy' — matches Scryfall's `finishes`.
  -- The source export marks foils with a trailing *F* (71 of 1457 lines).
  finish        TEXT NOT NULL DEFAULT 'nonfoil',

  condition     TEXT,      -- NM/LP/MP/HP/DMG. Absent from the text export.
  language      TEXT NOT NULL DEFAULT 'en',
  purchase_price NUMERIC(10,2),
  notes         TEXT,

  added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE important constraint. In the real data 16 printings appear TWICE — once
-- foil, once not (e.g. Involuntary Cooldown (BRO) 53: 2 plain + 1 foil), which
-- is why 1457 rows collapse to only 1441 distinct Scryfall IDs. Keying on
-- scryfall_id alone would silently merge those and lose 16 foils.
CREATE UNIQUE INDEX collection_cards_unique_printing_idx
  ON collection_cards (collection_id, scryfall_id, finish, language);

CREATE INDEX collection_cards_collection_idx ON collection_cards (collection_id);
CREATE INDEX collection_cards_scryfall_idx ON collection_cards (scryfall_id);

-- Import runs, so a partial scan can be re-run and diffed rather than
-- re-imported blind. The collection is being built incrementally.
CREATE TABLE collection_imports (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  source_format TEXT NOT NULL,     -- 'moxfield_text' | 'manabox_csv' | ...
  filename      TEXT,
  lines_total   INTEGER,
  lines_matched INTEGER,
  cards_added   INTEGER,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running',   -- running | ok | failed
  error         TEXT
);

-- Rows the importer could not resolve to a Scryfall printing. Kept rather than
-- dropped: with 179 distinct sets including oddities (PLST, CMB2, PIKO) and
-- non-numeric collector numbers (CHK-19, pp319sb, S4, 19b), a silent skip is
-- how cards quietly go missing from a collection.
CREATE TABLE collection_import_issues (
  id          SERIAL PRIMARY KEY,
  import_id   INTEGER NOT NULL REFERENCES collection_imports (id) ON DELETE CASCADE,
  line_number INTEGER,
  raw_line    TEXT NOT NULL,
  reason      TEXT NOT NULL,   -- 'no_match' | 'ambiguous' | 'parse_error'
  candidates  JSONB            -- near-misses, for a manual resolve UI
);

CREATE INDEX collection_import_issues_import_idx ON collection_import_issues (import_id);
