"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { parseId } from "@/lib/deck";
import {
  createDraft, joinDraft, makePick, savePicksAsDeck, startDraft,
  isPlausibleJoinSlug, parsePackCount, parsePackSize, parseSeatCount, parseSetCode,
  type DraftError,
} from "@/lib/draft";
import { DEFAULT_SEATS, ERR_PARAM, invitePath, parseSetSearch } from "./_form";

/**
 * Draft mutations, as server actions behind plain <form> posts, so a whole
 * draft can be played with JavaScript off.
 *
 * None of these trusts the draft id in the form to mean "a pod you are in".
 * Membership and turn order are re-checked by lib/draft on every call — a
 * hidden input is user input, not a seat — and this file's job is only to turn
 * the engine's answer into a redirect:
 *
 *  - `not_found` is `notFound()`, as in app/decks/_actions.ts: someone else's
 *    pod and no pod at all are the same 404, so pod ids cannot be enumerated
 *    by posting to them.
 *  - Every other DraftError rides back on `?err=<code>` to the page it came
 *    from, which turns it into a sentence (DRAFT_ERROR_TEXT). A redirect rather
 *    than a re-render because a refresh after a failed POST must not resubmit
 *    it — least of all a pick.
 *  - Success always redirects too, to the pod's own path. With JavaScript on,
 *    a redirect to the page you are already on is a soft navigation: the new
 *    pack streams into place with no full reload.
 */

async function signedIn(): Promise<number> {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return userId;
}

function tablePath(draftId: number, err?: DraftError): string {
  return err ? `/drafts/${draftId}?${new URLSearchParams({ [ERR_PARAM]: err })}` : `/drafts/${draftId}`;
}

/** Shared by every action on an existing pod: 404 for not-found, back to the
 *  table with the reason for anything else. */
function failed(draftId: number, error: DraftError): never {
  if (error === "not_found") notFound();
  redirect(tablePath(draftId, error));
}

export async function createDraftAction(formData: FormData) {
  const userId = await signedIn();

  // The set filter the form was rendered under, so a failure lands back on the
  // same short list rather than all several hundred sets.
  const q = parseSetSearch(formData.get("q"));
  function back(err: DraftError): never {
    const qs = new URLSearchParams({ [ERR_PARAM]: err });
    if (q) qs.set("q", q);
    redirect(`/drafts?${qs}`);
  }

  const setCode = parseSetCode(formData.get("set"));
  if (!setCode) back("unknown_set");

  // The advanced fields are optional: blank, or anything that is not a whole
  // number in range, means "the default" — which lib/draft owns, so undefined
  // is passed rather than a copy of its numbers. They MUST be parsed here:
  // createDraft throws on an out-of-range number (a caller bug, to it), and
  // a hand-edited form would otherwise reach the error page.
  const rawName = formData.get("name");
  const result = await createDraft(pool, {
    userId,
    // Blank becomes "<set name> draft" in the engine, which knows the name.
    name: typeof rawName === "string" ? rawName : "",
    setCode,
    seatCount: parseSeatCount(formData.get("seats")) ?? DEFAULT_SEATS,
    packSize: parsePackSize(formData.get("packSize")) ?? undefined,
    packCount: parsePackCount(formData.get("packCount")) ?? undefined,
  });
  if ("error" in result) back(result.error);

  revalidatePath("/drafts");
  redirect(`/drafts/${result.id}`);
}

/**
 * Take a seat from an invite. The slug is re-validated here rather than
 * trusted from the join page's hidden field. Joining a pod you already sit in
 * is a no-op success in the engine, so a double click lands on the table
 * rather than on an error.
 */
export async function joinDraftAction(formData: FormData) {
  const userId = await signedIn();
  const slug = formData.get("slug");
  if (!isPlausibleJoinSlug(slug)) notFound();

  const result = await joinDraft(pool, slug, userId);
  if ("error" in result) {
    if (result.error === "not_found") notFound();
    redirect(`${invitePath(slug)}?${new URLSearchParams({ [ERR_PARAM]: result.error })}`);
  }

  revalidatePath("/drafts");
  revalidatePath(`/drafts/${result.id}`);
  redirect(`/drafts/${result.id}`);
}

/** Creator only — the engine says `not_creator` to anyone else, and the page
 *  does not show them the button in the first place. */
export async function startDraftAction(formData: FormData) {
  const userId = await signedIn();
  const draftId = parseId(formData.get("draftId"));
  if (draftId === null) notFound();

  const result = await startDraft(pool, draftId, userId);
  if ("error" in result) failed(draftId, result.error);

  revalidatePath("/drafts");
  redirect(tablePath(draftId));
}

/**
 * One pick. A double click or a back-button resubmit posts the same card twice;
 * the second arrives when that card has already left the pack and comes back
 * as `not_in_pack` or `not_your_turn`, which the page words as "here is the
 * pack as it is now" rather than as a failure — the unique pick index in
 * 0008_drafts.sql is what guarantees it never takes a second card.
 */
export async function pickAction(formData: FormData) {
  const userId = await signedIn();
  const draftId = parseId(formData.get("draftId"));
  const cardId = parseId(formData.get("draftCardId"));
  if (draftId === null) notFound();
  if (cardId === null) redirect(tablePath(draftId, "not_in_pack"));

  const result = await makePick(pool, draftId, userId, cardId);
  if ("error" in result) failed(draftId, result.error);

  redirect(tablePath(draftId));
}

/** Save this seat's picks as a 'limited' deck and go and build it. Saving
 *  twice returns the same deck, so this is safe to resubmit. */
export async function savePicksAction(formData: FormData) {
  const userId = await signedIn();
  const draftId = parseId(formData.get("draftId"));
  if (draftId === null) notFound();

  const result = await savePicksAsDeck(pool, draftId, userId);
  if ("error" in result) failed(draftId, result.error);

  revalidatePath("/decks");
  revalidatePath(tablePath(draftId));
  redirect(`/decks/${result.deckId}`);
}
