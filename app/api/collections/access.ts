/**
 * Shared auth + ownership checks for the collection routes.
 *
 * Not a route file (Next only treats `route.ts` / `page.ts` as routes), so this
 * sits next to the handlers rather than in `lib/`.
 */

import { auth } from "@/auth";
import { query } from "@/lib/db";

export interface CollectionRow extends Record<string, unknown> {
  id: number;
  user_id: number;
  name: string;
  is_public: boolean;
}

/**
 * `users.id` is SERIAL, but Auth.js pins `session.user.id` to a string (see the
 * jwt callback in lib/auth/config.ts). Convert once, here, and reject anything
 * that is not a clean integer rather than letting `NaN` reach a query.
 */
export async function currentUserId(): Promise<number | null> {
  const session = await auth();
  const raw = session?.user?.id;
  if (typeof raw !== "string" || raw === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function jsonError(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ error, ...extra }, { status });
}

/**
 * Ids are SERIAL, i.e. int4.
 *
 * The upper bound is load-bearing, not defensive dressing: `pg` infers a bind
 * parameter's type from the column it is compared against, so a value above
 * int4 does not match zero rows — it raises 22003 and surfaces as a 500.
 * `/collections/2147483648` returned 500 while `/collections/999999999`
 * correctly returned 404. Same bound as `MAX_INT4` in lib/deck.
 */
const MAX_INT4 = 2147483647;

export function parseCollectionId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 && id <= MAX_INT4 ? id : null;
}

/**
 * Look up a collection the caller is allowed to touch.
 *
 * Returns a discriminated result rather than throwing so each handler can pick
 * its own status code. A collection owned by someone else comes back as
 * `not_found`, not `forbidden` — otherwise the API confirms which ids exist.
 */
export async function loadOwnedCollection(
  collectionId: number,
  userId: number,
): Promise<CollectionRow | null> {
  const rows = await query<CollectionRow>(
    `SELECT id, user_id, name, is_public FROM collections WHERE id = $1 AND user_id = $2`,
    [collectionId, userId],
  );
  return rows[0] ?? null;
}
