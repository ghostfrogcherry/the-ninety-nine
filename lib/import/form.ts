/**
 * Form-facing helpers for the browser import UI.
 *
 * `app/api/collections/[id]/import/route.ts` keeps working for curl and for
 * anything scripted; this file is what the server actions in
 * `app/collections/_actions.ts` use, so a plain <form> post never has to
 * round-trip through the app's own HTTP API and land the user on a page of raw
 * JSON. Both front doors end up calling the same `importCollection`.
 *
 * Everything here is pure and Next-free — no `next/*` import, no DOM types, no
 * pool — so `test/collection-import-form.test.ts` can exercise the whole
 * parse/encode surface without a browser, a server or a Postgres.
 */

/* ------------------------------------------------------------------ *
 * Size limits
 * ------------------------------------------------------------------ */

/**
 * The ceiling the HTTP route enforces, as its own `MAX_BYTES`.
 *
 * Duplicated rather than imported because route.ts does not export it and this
 * module must not import a route file. If one moves, move both — they describe
 * the same policy for two transports.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * What a <form> post can actually deliver, which is less.
 *
 * Next caps a Server Action request body at 1 MB by default and rejects a
 * larger one with a 413 raised inside its own action handler — *before* the
 * action runs, so a 1.5 MB file would surface as an unhandled error page
 * rather than as the readable message in IMPORT_ERROR_TEXT. The cap therefore
 * sits under 1 MB, leaving room for the multipart boundaries and the RSC
 * action envelope that ride along with the file bytes.
 *
 * Raising this requires `experimental.serverActions.bodySizeLimit` in
 * next.config.ts to be raised to match; until then MAX_IMPORT_BYTES is
 * reachable only over curl. That is not much of a loss: 960 KB is still about
 * 21x the largest real export seen (45 KB / 1457 lines), i.e. ~30,000 lines.
 */
export const MAX_FORM_BYTES = 960 * 1024;

/* ------------------------------------------------------------------ *
 * Failures a user can actually cause
 * ------------------------------------------------------------------ */

export const IMPORT_ERRORS = ["empty", "too_large"] as const;
export type ImportErrorCode = (typeof IMPORT_ERRORS)[number];

/**
 * Prose, not codes. These are the two ways a person genuinely gets this wrong —
 * hitting "import" with both controls untouched, and feeding it something huge.
 * Anything else (a dead pool, a missing table) is a real fault and belongs in
 * the error page, not in a friendly banner that implies the user mistyped.
 */
export const IMPORT_ERROR_TEXT: Record<ImportErrorCode, string> = {
  empty: "Nothing to import — choose a file or paste an export first.",
  too_large:
    `That export is over ${Math.round(MAX_FORM_BYTES / 1024)} KB, which is more than a browser ` +
    "upload can carry here. Split it, or use scripts/import-collection.mjs.",
};

export function parseImportError(value: unknown): ImportErrorCode | null {
  return typeof value === "string" && (IMPORT_ERRORS as readonly string[]).includes(value)
    ? (value as ImportErrorCode)
    : null;
}

/* ------------------------------------------------------------------ *
 * Input parsing
 *
 * Same contract as lib/deck: every helper takes `unknown` (FormData hands out
 * string | File | null) and returns null on anything unexpected rather than
 * coercing, so a hand-edited form cannot smuggle a value into SQL or into a
 * column shaped like an enum.
 * ------------------------------------------------------------------ */

function str(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

/** "on" is what an unvalued HTML checkbox sends; the HTTP route accepts the
 *  same three spellings, and a checkbox that is off sends nothing at all. */
export function parseCheckbox(value: unknown): boolean {
  const s = str(value);
  return s === "on" || s === "true" || s === "1";
}

export const ON_CONFLICT_MODES = ["set", "add"] as const;
export type OnConflict = (typeof ON_CONFLICT_MODES)[number];

export function parseOnConflict(value: unknown): OnConflict | null {
  const s = str(value);
  return (ON_CONFLICT_MODES as readonly string[]).includes(s ?? "") ? (s as OnConflict) : null;
}

/**
 * `collection_cards.language` is bare TEXT with no CHECK, so this is the only
 * thing keeping a sentence out of the column.
 *
 * A shape test, deliberately, not a whitelist of Scryfall's current languages:
 * Scryfall adds languages (`grc` and `ph` were both late arrivals), a whitelist
 * would reject a legitimate new one, and there is nothing dangerous about an
 * unrecognised two- or three-letter code — it simply matches no printing.
 */
export function parseLanguage(value: unknown): string | null {
  const s = str(value)?.toLowerCase() ?? null;
  return s !== null && /^[a-z]{2,3}$/.test(s) ? s : null;
}

/** 120 matches `createSchema` in app/api/collections/route.ts, so the two ways
 *  of creating a collection cannot accept different names. */
export function parseCollectionName(value: unknown): string | null {
  const s = str(value);
  if (s === null || s === "") return null;
  return s.length > 120 ? s.slice(0, 120) : s;
}

/**
 * `collection_imports.id` is SERIAL, i.e. int4.
 *
 * The upper bound is load-bearing rather than defensive dressing: `pg` infers a
 * bind parameter's type from the column it is compared against, so
 * `?imp=…2147483648` does not match zero rows — it raises 22003 and surfaces as
 * a 500. Same bound and same reason as `parseCollectionId` in
 * app/api/collections/access.ts and `MAX_INT4` in lib/deck.
 */
const MAX_INT4 = 2147483647;

export function parseImportId(value: unknown): number | null {
  const s = typeof value === "number" ? String(value) : str(value);
  if (s === null || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
}

/* ------------------------------------------------------------------ *
 * Reading the upload
 * ------------------------------------------------------------------ */

/**
 * The bits of `File` this module needs.
 *
 * Structural rather than the DOM `File`, so a test can hand it a plain object
 * and so nothing in lib/ depends on the DOM lib being present. A real `File`
 * from FormData satisfies this as-is — the same trick lib/import/resolve.ts
 * plays with `pg`'s Pool.
 */
export interface UploadLike {
  name: string;
  size: number;
  text(): Promise<string>;
}

export function isUpload(value: unknown): value is UploadLike {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<UploadLike>;
  return typeof v.size === "number" && typeof v.text === "function";
}

export type ImportSource =
  | { ok: true; text: string; filename: string | null }
  | { ok: false; error: ImportErrorCode };

/**
 * Decide what is actually being imported, from the file part and the textarea.
 *
 * Two behaviours here exist because of specific ways this goes wrong:
 *
 *  1. **A zero-byte file part is not a file.** An `<input type="file">` the user
 *     never touched still submits a part — empty name, zero bytes. Treated as a
 *     real upload it would beat the textarea and fail a perfectly good paste
 *     with "nothing to import", which is exactly the combination someone who
 *     scrolls past the file picker to the paste box will produce.
 *
 *  2. **A file beats a paste, rather than being concatenated with it.** Both
 *     filled in is ambiguous, and joining them would double any printing
 *     present in both — which, under the default `onConflict: "set"`, reads as
 *     a perfectly successful import with the wrong quantities. The report names
 *     the source that was used so the choice is visible rather than silent.
 */
export async function readImportSource(
  file: unknown,
  pasted: unknown,
  limit: number = MAX_FORM_BYTES,
): Promise<ImportSource> {
  const upload = isUpload(file) && file.size > 0 ? file : null;

  if (upload) {
    if (upload.size > limit) return { ok: false, error: "too_large" };
    const text = await upload.text();
    if (text.trim() === "") return { ok: false, error: "empty" };
    return { ok: true, text, filename: upload.name || null };
  }

  const text = typeof pasted === "string" ? pasted : "";
  if (text.trim() === "") return { ok: false, error: "empty" };
  // Byte length, not string length — the export is UTF-8 and card names carry
  // accented characters. Same measurement the HTTP route makes on a raw body.
  if (new TextEncoder().encode(text).length > limit) return { ok: false, error: "too_large" };
  return { ok: true, text, filename: null };
}

/* ------------------------------------------------------------------ *
 * The result summary, encoded for the URL
 * ------------------------------------------------------------------ */

export interface ImportSummary {
  dryRun: boolean;
  /** null for a dry run — no `collection_imports` row is written. */
  importId: number | null;
  linesTotal: number;
  linesMatched: number;
  rowsWritten: number;
  rowsInserted: number;
  rowsUpdated: number;
  cardsMatched: number;
  /** Net change in total quantity held. Negative when `set` shrinks a row. */
  quantityDelta: number;
  parseErrors: number;
  noMatch: number;
  ambiguous: number;
}

export const IMPORT_PARAM = "imp";
export const SOURCE_PARAM = "impFrom";
export const MISSED_PARAM = "impMiss";
export const MORE_PARAM = "impMore";
export const ERROR_PARAM = "impErr";

/**
 * Every query-string key this feature owns, in one place.
 *
 * Two callers need it and neither is allowed to guess. The report strips them
 * to build its "dismiss" link, so dismissing a report cannot also clear the
 * filters the user had set; and the collection page strips them before
 * replaying its query string to the browse endpoint, so a dry run's dozen
 * unresolved lines do not ride along on every infinite-scroll request for the
 * rest of the session.
 */
export const IMPORT_URL_KEYS: readonly string[] = [
  IMPORT_PARAM, SOURCE_PARAM, MISSED_PARAM, MORE_PARAM, ERROR_PARAM,
];

/**
 * Field order of the packed `imp` value. Adding a field means bumping the
 * version tag below.
 */
const SUMMARY_FIELDS = [
  "linesTotal", "linesMatched", "rowsWritten", "rowsInserted", "rowsUpdated",
  "cardsMatched", "quantityDelta", "parseErrors", "noMatch", "ambiguous",
] as const;

/**
 * Version tag on the packed value.
 *
 * A bookmarked `?imp=…` from before a field was inserted would otherwise decode
 * with every count shifted one place — plausible-looking numbers that are all
 * wrong, which is worse than showing nothing. A stale tag decodes to null.
 */
const SUMMARY_VERSION = "v1";

/**
 * The summary rides back on the query string, the way `importDeckListAction`
 * does: it is a dozen integers, it should survive a refresh, and it leaves the
 * action with no flash cookie or session row for the next request to clean up.
 *
 * Packed into ONE parameter rather than a dozen because this URL is shared with
 * the collection's filters (q, set, sort, view, page, …) and a wall of `impFoo`
 * keys would both collide with that namespace and bury the filters a user
 * actually wants to edit by hand.
 */
export function encodeImportSummary(summary: ImportSummary): string {
  return [
    SUMMARY_VERSION,
    summary.dryRun ? "1" : "0",
    summary.importId === null ? "-" : String(summary.importId),
    ...SUMMARY_FIELDS.map((f) => String(Math.trunc(summary[f]))),
  ].join(".");
}

/** Integers only, sign allowed (`quantityDelta` goes negative). */
const RE_INT = /^-?\d+$/;

export function decodeImportSummary(value: unknown): ImportSummary | null {
  const s = str(value);
  if (s === null) return null;

  const parts = s.split(".");
  if (parts.length !== SUMMARY_FIELDS.length + 3) return null;

  const [version, dry, rawId, ...rest] = parts;
  if (version !== SUMMARY_VERSION) return null;
  if (dry !== "0" && dry !== "1") return null;
  if (!rest.every((p) => RE_INT.test(p))) return null;

  // The import id is the one field that reaches SQL, so it goes through the
  // int4 range check rather than being trusted because it looked numeric.
  const importId = rawId === "-" ? null : parseImportId(rawId);
  if (rawId !== "-" && importId === null) return null;

  const numbers = Object.fromEntries(
    SUMMARY_FIELDS.map((f, i) => [f, Number(rest[i])]),
  ) as Record<(typeof SUMMARY_FIELDS)[number], number>;

  return { dryRun: dry === "1", importId, ...numbers };
}

/** Total unresolved rows: parse failures plus both flavours of resolve miss. */
export function issueCount(summary: ImportSummary): number {
  return summary.parseErrors + summary.noMatch + summary.ambiguous;
}

/**
 * Physical cards in the file that did NOT land, because their line did not
 * resolve. This is the number that makes a discrepancy explicit instead of
 * leaving the user to subtract two totals and guess.
 *
 * Quantities of unresolved lines are not carried in the summary, so this counts
 * lines, not copies — named accordingly at the call site.
 */
export function unmatchedLines(summary: ImportSummary): number {
  return Math.max(0, summary.linesTotal - summary.linesMatched);
}

/**
 * Cap on unresolved lines carried in the URL: a dry run of pure junk should not
 * produce a multi-kilobyte redirect. Only the dry-run path uses this — a
 * committed import reads its issues back out of `collection_import_issues` by
 * import id, so all of them show, not the first twelve that fit in a URL.
 */
export const MISSED_IN_URL = 12;
const MISSED_LINE_CHARS = 80;

export function truncateMissed(
  lines: string[],
  cap: number = MISSED_IN_URL,
): { shown: string[]; more: number } {
  const usable = lines.map((l) => l.trim()).filter(Boolean);
  return {
    shown: usable.slice(0, cap).map((l) => l.slice(0, MISSED_LINE_CHARS)),
    more: Math.max(0, usable.length - cap),
  };
}
