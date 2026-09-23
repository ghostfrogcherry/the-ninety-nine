"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { pool, query } from "@/lib/db";
import { disableSharing, enableSharing } from "@/app/d/_share";
import { applyDeckList, parseDeckList, resolveDeckList } from "@/lib/deck/decklist";
import {
  addDeckCard, createDeck, deleteDeck, loadOwnedDeck, moveDeckCard, removeDeckCard,
  renameDeck, setDeckCardQuantity,
  confirmsDeckName,
  parseAddQuantity, parseBoard, parseDeckName, parseFinish, parseFormat,
  parseId, parseQuantity, parseScryfallId,
  type DeckRow,
} from "@/lib/deck";

/**
 * Deck mutations, as server actions so the builder works from plain <form>
 * posts with no client JavaScript.
 *
 * Every one of these re-checks ownership through `loadOwnedDeck` rather than
 * trusting the deck id in the form. A form field is user input; a hidden input
 * is not a permission.
 */

/** The `SqlExec` shape app/d/_share.ts asks for, backed by the shared pool. */
const exec = (text: string, params: unknown[]) =>
  query<Record<string, unknown>>(text, params);

/** Ownership gate shared by every mutation. Throws rather than returning, so a
 *  caller cannot forget to check.
 *
 *  The loaded row comes back with it because the deck-level actions need the
 *  deck's own state to do their job — the name the delete confirmation must
 *  match, and the slug whose public path has to be revalidated. Re-reading it
 *  inside those actions would mean two reads that can disagree. */
async function ownedDeckOr404(
  deckId: number | null,
): Promise<{ userId: number; deckId: number; deck: DeckRow }> {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  // `notFound()`, not a thrown Error, and the same call the page makes for the
  // same condition. A stale tab posting to a deck that has since been deleted
  // is an ordinary thing to do, and it used to land on the generic error
  // screen while merely *viewing* that deck gave a clean 404 — one rule
  // presented two ways, the uglier one reserved for the person who had the
  // deck open longest. Both paths render app/not-found.tsx now.
  if (deckId === null) notFound();
  const deck = await loadOwnedDeck(pool, deckId, userId);
  // Someone else's deck and a nonexistent deck are indistinguishable here on
  // purpose — otherwise this confirms which deck ids exist.
  if (!deck) notFound();
  return { userId, deckId, deck };
}

export async function createDeckAction(formData: FormData) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const name = parseDeckName(formData.get("name"));
  const format = parseFormat(formData.get("format")) ?? "commander";
  if (!name) return; // Empty name: fall through and re-render, no deck created.

  const deck = await createDeck(pool, userId, { name, format });
  revalidatePath("/decks");
  redirect(`/decks/${deck.id}`);
}

/**
 * Rename a deck, and re-format it in the same submit.
 *
 * Format is editable here for the same reason the name is: `decks.format` is
 * picked once from a select on a page where you have not yet added a card, and
 * nothing about it is destructive to change. It selects which rules
 * `lib/commander/` is asked to judge, and that judgement is recomputed on every
 * render from `deck_cards`, so a format change rewrites no rows and invalidates
 * no card — the alternative is deleting a 99-card deck to fix a dropdown.
 *
 * A rejected format leaves the column untouched rather than falling back to
 * 'commander': `parseFormat` returns null for a value outside DECK_FORMATS, and
 * a deck sitting on a format this select cannot represent must not be retyped
 * by a rename that never mentioned it.
 */
export async function renameDeckAction(formData: FormData) {
  const { userId, deckId, deck } = await ownedDeckOr404(parseId(formData.get("deckId")));

  const name = parseDeckName(formData.get("name"));
  const format = parseFormat(formData.get("format"));
  // Empty name: re-render unchanged, exactly as createDeckAction does. Clearing
  // the box is a slip, not an instruction to store "".
  if (!name) return;

  await renameDeck(pool, deckId, userId, { name, format });

  revalidatePath(`/decks/${deckId}`);
  // The list shows the name and the format, and orders by updated_at, which the
  // rename just moved.
  revalidatePath("/decks");
  // The public page renders the name and the format too, so a shared deck that
  // was renamed must not keep serving the old title to strangers.
  if (deck.is_public && deck.public_slug) revalidatePath(`/d/${deck.public_slug}`);
}

/**
 * Delete a deck, its cards, and its share link.
 *
 * Two steps, both of them server-side. The page only shows this form once
 * `?confirm=1` is in the URL (see app/decks/[id]/page.tsx), and this action
 * additionally requires the deck's own name to have been typed — no client
 * JavaScript is loaded anywhere in this app, so `confirm()` does not exist and
 * a single POST-on-click button would be one stray tap from destroying a
 * finished deck. The typed name is re-checked here rather than trusted from the
 * page, because the query-string gate is UI and a hidden field is not a
 * permission; on a mismatch nothing is deleted and the user lands back on the
 * confirm state with the reason.
 *
 * `deleteDeck` returns the row it removed, so the slug being invalidated below
 * is the slug that actually existed at the moment of deletion.
 */
export async function deleteDeckAction(formData: FormData) {
  const { userId, deckId, deck } = await ownedDeckOr404(parseId(formData.get("deckId")));

  if (!confirmsDeckName(formData.get("confirmName"), deck.name)) {
    redirect(`/decks/${deckId}?confirm=1&err=name`);
  }

  const deleted = await deleteDeck(pool, deckId, userId);
  if (!deleted) redirect("/decks"); // Already gone — a double submit, not an error.

  // /decks loses a row; the deck's own path now 404s and must not be served
  // from a router cache entry that still remembers the deck.
  revalidatePath("/decks");
  revalidatePath(`/decks/${deckId}`);
  // The share link is dead the moment the row goes (the public query needs a
  // row with is_public = TRUE), but the rendered page can still be sitting in a
  // cache, so drop it explicitly — this is the difference between "the link
  // stops working" and "the link stops working eventually".
  if (deleted.public_slug) revalidatePath(`/d/${deleted.public_slug}`);

  // Back to the list: the page you were on no longer exists. The name rides on
  // the query string so the redirect can say what went, the same way the import
  // summary reports what landed.
  redirect(`/decks?${new URLSearchParams({ deleted: deleted.name })}`);
}

export async function addCardAction(formData: FormData) {
  const { deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));

  const scryfallId = parseScryfallId(formData.get("scryfallId"));
  const board = parseBoard(formData.get("board")) ?? "main";
  const finish = parseFinish(formData.get("finish")) ?? "nonfoil";
  const quantity = parseAddQuantity(formData.get("quantity")) ?? 1;
  if (!scryfallId) return;

  await addDeckCard(pool, deckId, { scryfallId, quantity, board, finish });
  revalidatePath(`/decks/${deckId}`);
}

export async function setQuantityAction(formData: FormData) {
  const { deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));
  const rowId = parseId(formData.get("rowId"));
  const quantity = parseQuantity(formData.get("quantity"));
  if (rowId === null || quantity === null) return;

  // quantity 0 deletes — the column is CHECK (> 0), so the library turns this
  // into a DELETE rather than a constraint violation.
  await setDeckCardQuantity(pool, deckId, rowId, quantity);
  revalidatePath(`/decks/${deckId}`);
}

export async function removeCardAction(formData: FormData) {
  const { deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));
  const rowId = parseId(formData.get("rowId"));
  if (rowId === null) return;

  await removeDeckCard(pool, deckId, rowId);
  revalidatePath(`/decks/${deckId}`);
}

/**
 * Bulk import: paste a decklist.
 *
 * The result summary rides back on the query string rather than in a session or
 * a flash cookie — it is a handful of counts, it should survive a refresh, and
 * it keeps the action free of any state the next request has to clean up.
 * Unresolved lines are carried too, so the user sees exactly what did not land
 * instead of a silent card-count discrepancy.
 */
export async function importDeckListAction(formData: FormData) {
  const { userId, deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));

  const text = String(formData.get("list") ?? "");
  const board = parseBoard(formData.get("board")) ?? "main";
  if (text.trim() === "") redirect(`/decks/${deckId}`);

  const parsed = parseDeckList(text, board);
  const { resolved, unresolved } = await resolveDeckList(pool, parsed.lines, userId);
  const applied = await applyDeckList(pool, deckId, resolved);

  const missed = [...unresolved.map((l) => l.raw), ...parsed.errors.map((e) => e.raw)]
    .map((s) => s.trim())
    .filter(Boolean);

  const qs = new URLSearchParams({
    added: String(applied.cards),
    rows: String(applied.rows),
  });
  // Cap what goes in the URL; a paste of pure junk should not produce a
  // multi-kilobyte redirect.
  for (const m of missed.slice(0, 12)) qs.append("missed", m.slice(0, 80));
  if (missed.length > 12) qs.set("more", String(missed.length - 12));

  revalidatePath(`/decks/${deckId}`);
  redirect(`/decks/${deckId}?${qs}`);
}

/**
 * Publish a deck at /d/<slug>, or rotate an existing slug.
 *
 * Rotating is the "this link leaked" button: the old URL stops resolving the
 * moment the new slug lands. Re-sharing without rotating deliberately restores
 * the SAME url, so a link a friend bookmarked keeps working.
 */
export async function shareDeckAction(formData: FormData) {
  const { userId, deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));
  const rotate = formData.get("rotate") === "1";
  await enableSharing(exec, deckId, userId, { rotate });
  revalidatePath(`/decks/${deckId}`);
  revalidatePath("/decks");
}

export async function unshareDeckAction(formData: FormData) {
  const { userId, deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));
  await disableSharing(exec, deckId, userId);
  revalidatePath(`/decks/${deckId}`);
  revalidatePath("/decks");
}

export async function moveCardAction(formData: FormData) {
  const { deckId } = await ownedDeckOr404(parseId(formData.get("deckId")));
  const rowId = parseId(formData.get("rowId"));
  const board = parseBoard(formData.get("board"));
  if (rowId === null || board === null) return;

  await moveDeckCard(pool, deckId, rowId, board);
  revalidatePath(`/decks/${deckId}`);
}
