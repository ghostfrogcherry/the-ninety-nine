/**
 * GET  /api/collections  — the caller's collections, with totals.
 * POST /api/collections  — create one.
 *
 * The per-collection card list and the file import live under
 * /api/collections/[id]/cards and /api/collections/[id]/import.
 */

import { z } from "zod";

import { query } from "@/lib/db";
import { currentUserId, jsonError } from "./access";

// `pg` and Auth.js are Node-only.
export const runtime = "nodejs";
// Every response depends on the session cookie.
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isPublic: z.boolean().optional().default(false),
});

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return jsonError(401, "not_signed_in");

  // LEFT JOIN, not JOIN: a collection with no cards yet must still be listed.
  const rows = await query(
    `SELECT c.id, c.name, c.is_public, c.created_at,
            COALESCE(count(cc.id), 0)::int      AS distinct_printings,
            COALESCE(sum(cc.quantity), 0)::int  AS physical_cards
       FROM collections c
       LEFT JOIN collection_cards cc ON cc.collection_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.created_at, c.id`,
    [userId],
  );

  return Response.json({ collections: rows });
}

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return jsonError(401, "not_signed_in");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "invalid_body", { issues: z.treeifyError(parsed.error) });
  }

  const rows = await query(
    `INSERT INTO collections (user_id, name, is_public)
     VALUES ($1, $2, $3)
     RETURNING id, name, is_public, created_at`,
    [userId, parsed.data.name, parsed.data.isPublic],
  );

  return Response.json({ collection: rows[0] }, { status: 201 });
}
