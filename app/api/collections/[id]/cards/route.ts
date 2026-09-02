/**
 * GET /api/collections/[id]/cards — list the cards in one collection.
 *
 * Joined to the local Scryfall mirror for display data. The join is a LEFT
 * JOIN on purpose: `collection_cards.scryfall_id` is deliberately not a foreign
 * key (see 0003_collections.sql), so a printing the weekly refresh has not
 * mirrored yet must still list — as a row with a null card, not as a row that
 * silently vanishes from the user's collection.
 */

import { query } from "@/lib/db";
import { currentUserId, jsonError, loadOwnedCollection, parseCollectionId } from "../../access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) return jsonError(401, "not_signed_in");

  const { id } = await ctx.params;
  const collectionId = parseCollectionId(id);
  if (collectionId === null) return jsonError(400, "invalid_collection_id");

  const collection = await loadOwnedCollection(collectionId, userId);
  if (!collection) return jsonError(404, "collection_not_found");

  const url = new URL(request.url);
  const limit = intParam(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const search = url.searchParams.get("q")?.trim() || null;
  const finish = url.searchParams.get("finish")?.trim() || null;

  const rows = await query(
    `SELECT cc.id, cc.scryfall_id::text AS scryfall_id, cc.quantity, cc.finish,
            cc.language, cc.condition, cc.purchase_price, cc.added_at,
            s.name, s.set_code, s.set_name, s.collector_number, s.rarity,
            s.image_uris, s.prices
       FROM collection_cards cc
       LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE cc.collection_id = $1
        AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR cc.finish = $3)
      ORDER BY s.name NULLS LAST, s.set_code, s.collector_number, cc.finish
      LIMIT $4 OFFSET $5`,
    [collectionId, search, finish, limit, offset],
  );

  const totals = await query<{ distinct_printings: number; physical_cards: number; matched: number }>(
    `SELECT count(*)::int                                   AS distinct_printings,
            COALESCE(sum(cc.quantity), 0)::int              AS physical_cards,
            count(s.id)::int                                AS matched
       FROM collection_cards cc
       LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE cc.collection_id = $1`,
    [collectionId],
  );

  return Response.json({
    collection: { id: collection.id, name: collection.name, is_public: collection.is_public },
    totals: totals[0],
    page: { limit, offset, returned: rows.length },
    cards: rows,
  });
}
