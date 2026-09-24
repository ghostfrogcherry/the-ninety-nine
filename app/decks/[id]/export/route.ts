/**
 * GET /decks/[id]/export — the deck as a `.txt` download, for untap.in's
 * "Decks → Import" and anything else that reads an Arena/MTGO list.
 *
 * A route handler rather than a page because the answer is a file, not HTML.
 * It sits under /decks, so `proxy.ts` already turns a signed-out request away;
 * the ownership check below is the real one regardless, because the proxy
 * only knows that *someone* is signed in.
 */

import { currentUserId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { loadDeckContents, loadOwnedDeck, parseId } from "@/lib/deck";
import { deckFileDisposition, formatDeckText } from "@/lib/deck/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A bare 404. Not-yours, not-real and not-signed-in all look like this, so
 *  the route cannot be used to find out which deck ids exist — the same rule
 *  as ownedDeckOr404 in app/decks/_actions.ts. */
const notFound = () =>
  new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) return notFound();

  const deckId = parseId((await ctx.params).id);
  if (deckId === null) return notFound();

  const deck = await loadOwnedDeck(pool, deckId, userId);
  if (!deck) return notFound();

  const { cards } = await loadDeckContents(pool, deckId, userId);
  return new Response(formatDeckText(cards), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": deckFileDisposition(deck.name),
      // A private deck list: not for a shared cache, and not worth keeping —
      // the next export should reflect the next edit.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
