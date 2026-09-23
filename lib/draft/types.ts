/**
 * The contract between the draft engine (lib/draft/) and the pages that drive
 * it (app/drafts/). Types only: the engine implements these shapes in
 * lib/draft/index.ts, and the pages import nothing from the engine that is not
 * named here.
 *
 * Every function in lib/draft takes a `Queryable` / `PoolLike` as its first
 * argument, as lib/deck does, so the tests can hand it a throwaway database
 * and the app hands it the shared pool.
 */

export type DraftStatus = "lobby" | "drafting" | "done";

export interface DraftSetOption {
  set_code: string;
  set_name: string;
  set_type: string | null;
  released_at: string | null;
  /** Distinct booster-eligible cards (by oracle_id) — or all, if unknown. */
  card_count: number;
  /** Whether Scryfall's booster flag is known for this set's rows. */
  booster_known: boolean;
}

export interface DraftSummary {
  id: number;
  name: string;
  set_code: string;
  set_name: string;
  status: DraftStatus;
  seat_count: number;
  pack_size: number;
  pack_count: number;
  join_slug: string;
  created_by: number;
  created_at: string;
}

export interface DraftSeatView {
  seat: number;
  /** null for a bot. */
  user_id: number | null;
  /** The person's name or email local part; "Bot 3" for a bot. */
  label: string;
  is_bot: boolean;
  picks_made: number;
  deck_id: number | null;
}

export interface DraftCardView {
  /** draft_cards.id — the value a pick form posts. */
  id: number;
  scryfall_id: string;
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  rarity: string;
  colors: string[] | null;
  /** The small/normal image URL, from image_uris or the first face. */
  image: string | null;
}

/**
 * What one person sees at one moment. Exactly one of `pack` / `waiting_on` is
 * set while drafting: either there is a pack in front of you, or you are
 * waiting for the named seat to pass one.
 */
export interface DraftSeatState {
  draft: DraftSummary;
  seats: DraftSeatView[];
  /** The viewer's seat, or null if they are not in this pod. */
  my_seat: number | null;
  /** 0-based round and pick the viewer is on. */
  round: number;
  pick: number;
  pack: DraftCardView[] | null;
  waiting_on: DraftSeatView | null;
  /** Everything the viewer has taken so far, in pick order. */
  picks: DraftCardView[];
}

export interface CreateDraftInput {
  userId: number;
  name: string;
  setCode: string;
  seatCount: number;
  packSize?: number;   // default 14
  packCount?: number;  // default 3
}

/** Failures a person can cause; everything else throws. */
export type DraftError =
  | "not_found"        // no such pod, or not yours to act on
  | "not_lobby"        // joining or starting after the draft began
  | "full"             // every seat already has a person
  | "not_creator"      // only the creator starts a pod
  | "unknown_set"      // set_code not in the mirror
  | "too_few_cards"    // the set cannot fill seat_count x pack_count packs
  | "not_your_turn"    // no pack in front of you right now
  | "not_in_pack"      // that card is not in the pack in front of you
  | "done";            // the draft is over
