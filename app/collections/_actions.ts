"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import {
  currentUserId,
  loadOwnedCollection,
  parseCollectionId,
} from "@/app/api/collections/access";
import { pool, query } from "@/lib/db";
import { mergeDuplicates, parseMoxfieldText } from "@/lib/import/moxfield-text";
import { importCollection } from "@/lib/import/resolve";
import {
  ERROR_PARAM, IMPORT_PARAM, MISSED_PARAM, MORE_PARAM, SOURCE_PARAM,
  encodeImportSummary, parseCheckbox, parseCollectionName, parseLanguage,
  parseOnConflict, readImportSource, truncateMissed,
} from "@/lib/import/form";

/**
 * Collection mutations, as server actions so creating a collection and
 * importing into it work from plain <form> posts with no client JavaScript.
 *
 * Deliberately NOT a <form> that posts to /api/collections/[id]/import. That
 * route is a real endpoint and stays one — curl uses it, and it is the tested
 * upload path — but a browser form posting there *navigates* to it: the user's
 * collection page is replaced by a wall of raw JSON with no way back except the
 * back button, and there is no client-side JavaScript anywhere in this app to
 * fetch() it instead. So the form calls a server action, the action calls the
 * same `importCollection` the route calls, and the browser is redirected back
 * to the page it started on with the summary on the query string. One import
 * implementation, two front doors, and neither can drift from the other because
 * both are thin wrappers over lib/import.
 *
 * Every action re-checks ownership through `loadOwnedCollection`, exactly as
 * app/decks/_actions.ts does. The collection id arrives in a hidden input, and
 * a hidden input is user input, not a permission.
 */

/**
 * `parseCollectionId` takes a route segment, which is always a string; FormData
 * hands out `string | File | null`. Narrow first rather than coercing — a File
 * stringifies to "[object File]" and would reach the range check as NaN by
 * accident rather than by design.
 */
function formCollectionId(value: FormDataEntryValue | null): number | null {
  return typeof value === "string" ? parseCollectionId(value) : null;
}

/** Ownership gate shared by every mutation. Throws rather than returning, so a
 *  caller cannot forget to check. */
async function ownedCollectionOr404(collectionId: number | null): Promise<{ id: number }> {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  // `notFound()` rather than a thrown Error, matching the page's handling of
  // the same condition — see the note in app/decks/_actions.ts.
  if (collectionId === null) notFound();
  const collection = await loadOwnedCollection(collectionId, userId);
  // Someone else's collection and a nonexistent one are indistinguishable here
  // on purpose — otherwise this confirms which collection ids exist.
  if (!collection) notFound();
  return { id: collection.id };
}

/**
 * Create an empty collection.
 *
 * Until this existed the only way to get a collection was
 * `scripts/import-collection.mjs --create`, which meant the import UI could
 * only ever be used by someone who had already been to a terminal.
 */
export async function createCollectionAction(formData: FormData) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const name = parseCollectionName(formData.get("name"));
  const isPublic = parseCheckbox(formData.get("isPublic"));
  if (!name) return; // Empty name: fall through and re-render, nothing created.

  const [row] = await query<{ id: number }>(
    `INSERT INTO collections (user_id, name, is_public)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, name, isPublic],
  );

  revalidatePath("/collections");
  // Straight to the new, empty collection — which is where the import panel is.
  // The CLI creates and imports in one `--create` invocation; landing on the
  // page that holds the import form is the browser equivalent, and it avoids a
  // second file input on the index that most visits would never touch.
  redirect(`/collections/${row.id}`);
}

/**
 * Import an export into one collection, from an uploaded file or a paste.
 *
 * The summary rides back on the query string rather than in a session or a
 * flash cookie: it is a handful of counts, it should survive a refresh, and it
 * leaves no state behind for the next request to clean up. Unresolved rows are
 * surfaced too — a silent card-count discrepancy, where the collection quietly
 * ends up smaller than the file, is the failure this whole report exists to
 * prevent.
 */
export async function importCollectionAction(formData: FormData) {
  const { id } = await ownedCollectionOr404(formCollectionId(formData.get("collectionId")));
  const base = `/collections/${id}`;

  const source = await readImportSource(formData.get("file"), formData.get("paste"));
  // An oversized or empty submission is a user mistake, not a fault: redirect
  // back with a code the page turns into a sentence, rather than throwing and
  // showing an error page with a stack trace on it.
  if (!source.ok) redirect(`${base}?${ERROR_PARAM}=${source.error}`);

  const onConflict = parseOnConflict(formData.get("onConflict")) ?? "set";
  const language = parseLanguage(formData.get("language")) ?? "en";
  const dryRun = parseCheckbox(formData.get("dryRun"));

  const parsed = parseMoxfieldText(source.text);
  // Folds duplicate lines within one file, keyed on set + collector + FINISH so
  // a foil and a plain of one printing are never folded together. Same two
  // calls, in the same order, as the HTTP route.
  const cards = mergeDuplicates(parsed.cards);

  const result = await importCollection(
    pool,
    { cards, errors: parsed.errors },
    {
      collectionId: id,
      filename: source.filename,
      sourceFormat: "moxfield_text",
      language,
      onConflict,
      dryRun,
    },
  );

  const qs = new URLSearchParams({
    [IMPORT_PARAM]: encodeImportSummary({
      dryRun: result.dryRun,
      importId: result.importId,
      linesTotal: result.linesTotal,
      linesMatched: result.linesMatched,
      rowsWritten: result.rowsWritten,
      rowsInserted: result.rowsInserted,
      rowsUpdated: result.rowsUpdated,
      cardsMatched: result.cardsMatched,
      quantityDelta: result.quantityDelta,
      parseErrors: result.issueBreakdown.parse_error,
      noMatch: result.issueBreakdown.no_match,
      ambiguous: result.issueBreakdown.ambiguous,
    }),
    // Truncated: the filename is a label on a banner, and it is the one part of
    // this redirect whose length is chosen by the user.
    [SOURCE_PARAM]: (source.filename ?? "pasted text").slice(0, 80),
  });

  // A dry run writes no `collection_imports` row, so it has no persisted issues
  // to read back and its unresolved lines have to travel in the URL. A
  // committed import deliberately does not do this: the page loads the full set
  // from `collection_import_issues` by import id, so an import with 57 misses
  // shows all 57 instead of the first twelve that fit in a query string.
  if (result.importId === null && result.issues > 0) {
    const { shown, more } = truncateMissed([
      ...result.parseErrors.map((e) => e.raw),
      ...result.unresolved.map((u) => u.line.raw),
    ]);
    for (const line of shown) qs.append(MISSED_PARAM, line);
    if (more > 0) qs.set(MORE_PARAM, String(more));
  }

  // Only a real import changed anything; revalidating after a dry run would
  // throw away a warm render to display identical data.
  if (!result.dryRun) revalidatePath(base);
  redirect(`${base}?${qs}`);
}
