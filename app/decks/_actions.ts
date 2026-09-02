"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { pool, query } from "@/lib/db";
import { disableSharing, enableSharing } from "@/app/d/_share";
import {
  addDeckCard, createDeck, loadOwnedDeck, moveDeckCard, removeDeckCard,
  setDeckCardQuantity,
  parseAddQuantity, parseBoard, parseDeckName, parseFinish, parseFormat,
  parseId, parseQuantity, parseScryfallId,
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
 *  caller cannot forget to check. */
async function ownedDeckOr404(deckId: number | null): Promise<{ userId: number; deckId: number }> {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  if (deckId === null) throw new Error("invalid deck id");
  const deck = await loadOwnedDeck(pool, deckId, userId);
  // Someone else's deck and a nonexistent deck are indistinguishable here on
  // purpose — otherwise this confirms which deck ids exist.
  if (!deck) throw new Error("deck not found");
  return { userId, deckId };
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
