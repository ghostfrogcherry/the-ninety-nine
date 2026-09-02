/**
 * GET /api/collections/[id]/browse — the collection browser's paging feed.
 *
 * Separate from ../cards on purpose. That route is a general listing API with
 * its own stable contract; this one exists to serve the browser UI and shares
 * lib/collection/filters.ts with the page, so an infinite-scroll page can never
 * drift from what the server rendered first. Same params in, same ORDER BY,
 * same finish-aware price.
 */

import { query } from "@/lib/db";
import { currentUserId, jsonError, loadOwnedCollection, parseCollectionId } from "../../access";
import {
  IMAGE_SQL, PAGE_SIZES, UNIT_PRICE_SQL, buildWhere, parseFilters,
} from "@/lib/collection/filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) return jsonError(401, "not_signed_in");

  const { id } = await ctx.params;
  const collectionId = parseCollectionId(id);
  if (collectionId === null) return jsonError(400, "invalid_collection_id");

  // A collection owned by someone else reads as missing, not forbidden, so this
  // endpoint cannot be used to enumerate which ids exist.
  const collection = await loadOwnedCollection(collectionId, userId);
  if (!collection) return jsonError(404, "collection_not_found");

  const url = new URL(request.url);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }

  const filters = parseFilters(raw);
  const { where, params, orderBy } = buildWhere(filters, collectionId);
  const perPage = PAGE_SIZES[filters.view];
  const offset = (filters.page - 1) * perPage;

  // Fetch one extra row rather than running a second COUNT: the client only
  // needs to know whether to keep scrolling, and a count over a filtered join
  // on every scroll tick is wasted work.
  const rows = await query(
    `SELECT cc.scryfall_id::text AS scryfall_id, cc.quantity, cc.finish,
            s.name, s.set_code, s.collector_number, s.rarity, s.type_line, s.cmc,
            s.color_identity,
            ${IMAGE_SQL} AS image,
            ${UNIT_PRICE_SQL}::text AS unit_price
       FROM collection_cards cc
       LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage + 1, offset],
  );

  const hasMore = rows.length > perPage;
  return Response.json({
    rows: hasMore ? rows.slice(0, perPage) : rows,
    page: filters.page,
    hasMore,
  });
}
