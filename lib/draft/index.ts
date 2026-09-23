/**
 * Booster draft engine. See lib/draft/types.ts for the shapes, and
 * db/migrations/0008_drafts.sql for the tables.
 *
 * SIGNATURES ONLY — the bodies are being written. Pages may import and call
 * these; every one throws until implemented.
 */

import type { PoolLike } from "@/lib/import/resolve";
import type { Queryable } from "@/lib/deck";

import type {
  CreateDraftInput,
  DraftError,
  DraftSeatState,
  DraftSetOption,
  DraftSummary,
} from "./types";

export type * from "./types";

/** Seed for deterministic pack opening and bot picks in tests. */
export type Rng = () => number;

const todo = (): never => {
  throw new Error("lib/draft: not implemented yet");
};

/** Sets that can be drafted, newest first, optionally filtered by name/code. */
export async function listDraftableSets(_db: Queryable, _search?: string): Promise<DraftSetOption[]> {
  return todo();
}

/** Create a pod in 'lobby' with the creator in seat 0. */
export async function createDraft(
  _db: Queryable,
  _input: CreateDraftInput,
): Promise<{ id: number } | { error: DraftError }> {
  return todo();
}

/** The pod an invite slug names, or null. For the join page. */
export async function findDraftBySlug(_db: Queryable, _slug: string): Promise<DraftSummary | null> {
  return todo();
}

/** Take the lowest free seat. Joining a pod you are already in is a no-op success. */
export async function joinDraft(
  _db: PoolLike,
  _slug: string,
  _userId: number,
): Promise<{ id: number } | { error: DraftError }> {
  return todo();
}

/**
 * Creator only. Fills empty seats with bots, opens every pack, moves to
 * 'drafting', and lets the bots take every pick they can.
 */
export async function startDraft(
  _db: PoolLike,
  _draftId: number,
  _userId: number,
  _rng?: Rng,
): Promise<{ ok: true } | { error: DraftError }> {
  return todo();
}

/**
 * Take one card from the pack in front of this person, then let the bots
 * catch up. Marks the draft 'done' when the last card goes.
 */
export async function makePick(
  _db: PoolLike,
  _draftId: number,
  _userId: number,
  _draftCardId: number,
  _rng?: Rng,
): Promise<{ ok: true } | { error: DraftError }> {
  return todo();
}

/** Everything one member sees. null when the pod does not exist or they are not in it. */
export async function loadSeatState(
  _db: Queryable,
  _draftId: number,
  _userId: number,
): Promise<DraftSeatState | null> {
  return todo();
}

/** Pods this person created or sits in, newest first. */
export async function listMyDrafts(_db: Queryable, _userId: number): Promise<DraftSummary[]> {
  return todo();
}

/**
 * Save this person's picks as a new deck (format 'limited', every pick in
 * 'main'), remember it on their seat, and return it. Saving twice returns the
 * deck already saved rather than making a second.
 */
export async function savePicksAsDeck(
  _db: PoolLike,
  _draftId: number,
  _userId: number,
): Promise<{ deckId: number } | { error: DraftError }> {
  return todo();
}
