/**
 * POST /api/collections/[id]/import — upload a collection export and import it.
 *
 * Accepts either `multipart/form-data` with a `file` part (what a browser
 * <input type="file"> sends) or a raw `text/plain` body (what curl sends).
 *
 * Shares `importCollection` with scripts/import-collection.mjs, so the CLI and
 * the upload cannot drift apart. In particular both default to `onConflict:
 * "set"`, which makes re-uploading the same export a no-op instead of doubling
 * every quantity — the collection is being scanned incrementally and the same
 * file WILL get uploaded twice.
 */

import { z } from "zod";

import { pool } from "@/lib/db";
import { mergeDuplicates, parseMoxfieldText } from "@/lib/import/moxfield-text";
import { importCollection } from "@/lib/import/resolve";
import { currentUserId, jsonError, loadOwnedCollection, parseCollectionId } from "../../access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Roughly 40x the first real batch (45 KB / 1457 lines). */
const MAX_BYTES = 2 * 1024 * 1024;

const optionsSchema = z.object({
  onConflict: z.enum(["set", "add"]).default("set"),
  language: z.string().trim().min(1).max(16).default("en"),
  dryRun: z.boolean().default(false),
});

/** "on" is what an unvalued HTML checkbox sends. */
const asBool = (v: FormDataEntryValue | string | null): boolean =>
  v === "true" || v === "1" || v === "on";

interface Upload {
  text: string;
  filename: string | null;
  options: z.input<typeof optionsSchema>;
}

async function readUpload(request: Request): Promise<Upload | { error: string }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return { error: "missing_file_part" };
    if (file.size > MAX_BYTES) return { error: "file_too_large" };
    return {
      text: await file.text(),
      filename: file.name || null,
      options: {
        onConflict: (form.get("onConflict") as "set" | "add" | null) ?? undefined,
        language: (form.get("language") as string | null) ?? undefined,
        dryRun: asBool(form.get("dryRun")),
      },
    };
  }

  const url = new URL(request.url);
  const text = await request.text();
  // Byte length, not string length — the export is UTF-8 and names carry
  // accented characters.
  if (new TextEncoder().encode(text).length > MAX_BYTES) return { error: "file_too_large" };
  return {
    text,
    filename: url.searchParams.get("filename"),
    options: {
      onConflict: (url.searchParams.get("onConflict") as "set" | "add" | null) ?? undefined,
      language: url.searchParams.get("language") ?? undefined,
      dryRun: asBool(url.searchParams.get("dryRun")),
    },
  };
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) return jsonError(401, "not_signed_in");

  const { id } = await ctx.params;
  const collectionId = parseCollectionId(id);
  if (collectionId === null) return jsonError(400, "invalid_collection_id");

  const collection = await loadOwnedCollection(collectionId, userId);
  if (!collection) return jsonError(404, "collection_not_found");

  const upload = await readUpload(request);
  if ("error" in upload) return jsonError(400, upload.error);
  if (upload.text.trim() === "") return jsonError(400, "empty_file");

  const options = optionsSchema.safeParse(upload.options);
  if (!options.success) {
    return jsonError(400, "invalid_options", { issues: z.treeifyError(options.error) });
  }

  const parsed = parseMoxfieldText(upload.text);
  // Folds duplicate lines inside one file. Keyed on set + collector + FINISH,
  // so a foil and a plain of the same printing are never folded together.
  const cards = mergeDuplicates(parsed.cards);

  const result = await importCollection(
    pool,
    { cards, errors: parsed.errors },
    {
      collectionId,
      filename: upload.filename,
      sourceFormat: "moxfield_text",
      language: options.data.language,
      onConflict: options.data.onConflict,
      dryRun: options.data.dryRun,
    },
  );

  return Response.json(
    {
      importId: result.importId,
      dryRun: result.dryRun,
      linesParsed: parsed.cards.length,
      physicalCards: parsed.totalCards,
      linesTotal: result.linesTotal,
      linesMatched: result.linesMatched,
      rowsWritten: result.rowsWritten,
      rowsInserted: result.rowsInserted,
      rowsUpdated: result.rowsUpdated,
      cardsMatched: result.cardsMatched,
      quantityDelta: result.quantityDelta,
      issues: result.issues,
      issueBreakdown: result.issueBreakdown,
      resolveCounts: result.resolveCounts,
      // Enough to drive a manual-resolve UI without a second round trip.
      // Everything here is also persisted in collection_import_issues.
      unresolved: [
        ...result.parseErrors.map((e) => ({
          lineNumber: e.lineNumber,
          raw: e.raw,
          status: "parse_error" as const,
          candidates: [],
        })),
        ...result.unresolved.map((u) => ({
          lineNumber: u.line.lineNumber,
          raw: u.line.raw,
          status: u.status,
          stage: u.stage,
          candidates: u.candidates,
        })),
      ].sort((a, b) => a.lineNumber - b.lineNumber),
    },
    // 200, not 207: the rows that resolved are committed either way, and the
    // unresolved ones are reported in the body and stored as issues.
    { status: 200 },
  );
}
