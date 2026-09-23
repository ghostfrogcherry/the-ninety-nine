/**
 * GET /api/health — 200 `{"ok":true}` when the app can reach its database,
 * 503 `{"ok":false}` when it cannot. What the compose healthcheck polls.
 *
 * Unauthenticated on purpose, and not by exemption: `proxy.ts` matches an
 * allow-list of guarded paths (/collections, /decks) and this path is on no
 * list, so the proxy never runs for it. Docker's probe has no session cookie,
 * and a healthcheck that needed one would report "unhealthy" for a perfectly
 * good app. Do not "fix" that by widening the matcher.
 *
 * Because anyone who can reach the port can call it, the body is a boolean and
 * nothing else — no error text, no version, no counts. Why a check failed goes
 * to the server log, where `docker compose logs app` finds it.
 */

import { pool } from "@/lib/db";
import { checkDatabase, healthStatus } from "@/lib/health";

// `pg` is Node-only.
export const runtime = "nodejs";
// A health answer baked in at build time would say "healthy" forever. The build
// has no database anyway (the Dockerfile's DATABASE_URL is a placeholder), so a
// statically evaluated check would bake in a permanent 503 instead.
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await checkDatabase(pool);
  if (!result.ok) console.error(`health: database check failed (${result.reason})`);
  return Response.json(
    { ok: result.ok },
    {
      status: healthStatus(result),
      // Belt and braces with force-dynamic: nothing between Docker and the app
      // caches today, but Caddy or a browser answering from cache would turn a
      // dead database into a green check.
      headers: { "Cache-Control": "no-store" },
    },
  );
}
