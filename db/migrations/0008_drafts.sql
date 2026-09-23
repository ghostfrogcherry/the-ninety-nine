-- 0008_drafts.sql
--
-- Booster draft pods: a few friends and bots draft a set, then each person
-- saves their picks as an ordinary deck.
--
-- Two mirror columns come first, because a draft needs to know which printings
-- actually appear in packs. Scryfall's `booster` flag is the only reliable
-- answer: a set's rows also include showcase frames, promos and collector-
-- booster extras that would flood a pack if every printing in the set were
-- eligible. NULL means "not known yet" — every row a pre-0008 refresh wrote —
-- and lib/draft falls back to the whole set rather than refusing to draft it.
-- The next `scryfall-refresh --force` fills both in.

ALTER TABLE scryfall_cards ADD COLUMN booster BOOLEAN;
ALTER TABLE scryfall_cards ADD COLUMN set_type TEXT;

CREATE INDEX scryfall_cards_set_code_idx ON scryfall_cards (set_code);

CREATE TABLE drafts (
  id           SERIAL PRIMARY KEY,
  -- Whoever created the pod: the only one who can start it or cancel it.
  created_by   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  set_code     TEXT NOT NULL,
  set_name     TEXT NOT NULL,

  seat_count   INTEGER NOT NULL CHECK (seat_count BETWEEN 2 AND 8),
  pack_size    INTEGER NOT NULL CHECK (pack_size BETWEEN 5 AND 20),
  pack_count   INTEGER NOT NULL DEFAULT 3 CHECK (pack_count BETWEEN 1 AND 6),

  -- 'lobby' -> 'drafting' -> 'done'. Only 'lobby' accepts joins.
  status       TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'drafting', 'done')),

  -- Random, like decks.public_slug: the invite a friend opens to take a seat.
  -- Not the serial id, so pods cannot be found by counting upward. Joining
  -- still needs an account on this box; the slug only says which pod.
  join_slug    TEXT NOT NULL UNIQUE,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE INDEX drafts_created_by_idx ON drafts (created_by);

CREATE TABLE draft_seats (
  draft_id     INTEGER NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  -- 0-based position around the table. Packs pass to seat+1 in odd-numbered
  -- rounds (1st, 3rd, ...) and to seat-1 in even ones, as at a real table.
  seat         INTEGER NOT NULL CHECK (seat >= 0 AND seat < 8),
  -- NULL is a bot. Bots are filled in when the draft starts, not before, so
  -- the lobby shows only the people who have actually joined.
  user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  -- The deck this seat's picks were saved into, once they have been.
  deck_id      INTEGER REFERENCES decks (id) ON DELETE SET NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, seat)
);

-- One seat per person per pod.
CREATE UNIQUE INDEX draft_seats_user_idx ON draft_seats (draft_id, user_id) WHERE user_id IS NOT NULL;

-- Every card of every pack, opened up front when the draft starts. Generating
-- all packs at once means the pod's contents are fixed and inspectable, and a
-- pick is one UPDATE of one row rather than any pack-shuffling logic.
CREATE TABLE draft_cards (
  id            SERIAL PRIMARY KEY,
  draft_id      INTEGER NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  -- 0-based round (which of the pack_count packs), and the seat that opened it.
  round         INTEGER NOT NULL,
  origin_seat   INTEGER NOT NULL,
  -- Position in the opened pack, for a stable display order.
  slot          INTEGER NOT NULL,
  -- No FK into the rebuildable mirror, as everywhere else.
  scryfall_id   UUID NOT NULL,
  -- Set once taken. pick_number is 0-based within the round: the Nth card any
  -- seat takes in that round, which is also how many cards had already left
  -- this pack when it was taken.
  picked_by     INTEGER,
  pick_number   INTEGER,
  picked_at     TIMESTAMPTZ,
  UNIQUE (draft_id, round, origin_seat, slot)
);

CREATE INDEX draft_cards_pack_idx ON draft_cards (draft_id, round, origin_seat);
CREATE INDEX draft_cards_picked_idx ON draft_cards (draft_id, picked_by) WHERE picked_by IS NOT NULL;

-- A seat takes exactly one card per pick number per round. This is what makes
-- a double-submitted pick form (a double click, a back-button resubmit) fail
-- instead of quietly taking two cards.
CREATE UNIQUE INDEX draft_cards_one_pick_idx ON draft_cards (draft_id, round, picked_by, pick_number)
  WHERE picked_by IS NOT NULL;
