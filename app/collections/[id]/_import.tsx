import { pool, query } from "@/lib/db";
import {
  ERROR_PARAM, IMPORT_ERROR_TEXT, IMPORT_PARAM, IMPORT_URL_KEYS, MISSED_PARAM,
  MORE_PARAM, SOURCE_PARAM,
  decodeImportSummary, issueCount, parseImportError, unmatchedLines,
  type ImportSummary,
} from "@/lib/import/form";
import { loadImportIssues, type ImportIssue } from "@/lib/import/issues";
import { importCollectionAction } from "../_actions";

/**
 * The collection import UI: a form, and an honest report of what the last run
 * did.
 *
 * All server components. The form posts to `importCollectionAction` — see the
 * header of app/collections/_actions.ts for why it does not post to the HTTP
 * route — and everything else is read out of the query string the action
 * redirected with, so the whole thing works with JavaScript disabled and a
 * refresh shows the same summary rather than an empty page.
 */

type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

const many = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v : v ? [v] : [];

const IMPORT_KEYS = new Set(IMPORT_URL_KEYS);

/**
 * Scryfall's language codes. Offered as a list because typing one is a chore,
 * but `parseLanguage` validates by shape rather than against this list — see
 * the note there.
 */
const LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht",
  "he", "la", "grc", "ar", "sa", "ph",
];

const REASON_TEXT: Record<string, string> = {
  parse_error: "could not be parsed",
  no_match: "no printing in the local mirror",
  ambiguous: "matched several printings",
};

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function ImportSection({
  collectionId,
  searchParams,
  empty,
}: {
  collectionId: number;
  searchParams: SearchParams;
  /** True when the collection holds no cards at all — the import form then
   *  opens by default, because it is the only useful thing on the page. */
  empty: boolean;
}) {
  const summary = decodeImportSummary(one(searchParams[IMPORT_PARAM]));
  const error = parseImportError(one(searchParams[ERROR_PARAM]));

  // Everything not owned by this feature is put back, so dismissing a report
  // does not also clear the filters the user had set.
  const kept = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined || IMPORT_KEYS.has(k)) continue;
    for (const item of Array.isArray(v) ? v : [v]) if (item) kept.append(k, item);
  }
  const clearHref = `/collections/${collectionId}${kept.size ? `?${kept}` : ""}`;

  // Scoped to this collection inside loadImportIssues — the import id arrives
  // in the URL, and this page has only proved the *collection* is the caller's.
  const issues: ImportIssue[] =
    summary !== null && summary.importId !== null
      ? await loadImportIssues(pool, summary.importId, collectionId)
      : [];

  // Nothing matched at all is nearly always an empty mirror rather than a bad
  // file — the first install has no `scryfall_cards` rows until the refresh has
  // run once, and "0 of 1457 matched" with no explanation reads as a broken
  // importer. Only asked when it is the plausible explanation.
  let mirrorEmpty = false;
  if (summary && summary.linesTotal > 0 && summary.linesMatched === 0) {
    const [row] = await query<{ any_cards: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM scryfall_cards) AS any_cards",
    );
    mirrorEmpty = !row?.any_cards;
  }

  return (
    <>
      {error ? (
        <div className="import-note">
          <span>{IMPORT_ERROR_TEXT[error]}</span>
          <a href={clearHref}>dismiss</a>
        </div>
      ) : null}

      {summary ? (
        <ImportReport
          summary={summary}
          source={one(searchParams[SOURCE_PARAM])}
          issues={issues}
          missed={many(searchParams[MISSED_PARAM])}
          more={Number(one(searchParams[MORE_PARAM])) || 0}
          mirrorEmpty={mirrorEmpty}
          clearHref={clearHref}
        />
      ) : null}

      <ImportPanel
        collectionId={collectionId}
        open={empty || summary !== null || error !== null}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The form
 * ------------------------------------------------------------------ */

/**
 * Upload a file, or paste an export, or both — a file wins, and the report says
 * which source was used. Pasting is not a nicety: the format is plain text and
 * the realistic way to get it here is to copy it out of Moxfield.
 *
 * No `method` or `encType` on the <form>. React sets both itself for a form
 * whose action is a function (POST, multipart/form-data, which is what carries
 * the file part when JavaScript is off) and warns that it is overriding you if
 * you set them anyway.
 */
function ImportPanel({ collectionId, open }: { collectionId: number; open: boolean }) {
  return (
    <details className="import-panel" open={open}>
      <summary>import cards</summary>

      <form action={importCollectionAction} className="filters" style={{ marginTop: "0.6rem" }}>
        <input type="hidden" name="collectionId" value={collectionId} />

        <fieldset>
          <legend>File</legend>
          <input
            type="file"
            name="file"
            accept=".txt,.text,text/plain"
            aria-label="Collection export file"
          />
          <span style={{ fontSize: 11, color: "var(--dim2)" }}>
            Moxfield / MTGO plain text — not ManaBox CSV.
          </span>
        </fieldset>

        <fieldset style={{ display: "block" }}>
          <legend>Or paste</legend>
          <textarea
            name="paste"
            rows={6}
            placeholder={
              "1 Growing Ranks (C19) 193\n" +
              "2 Makindi Stampede // Makindi Mesas (ZNR) 26\n" +
              "1 Reflections of Littjara (KHM) 400 *F*"
            }
            style={{ width: "100%", resize: "vertical", fontSize: 11, lineHeight: 1.45 }}
            aria-label="Paste a collection export"
          />
        </fieldset>

        <fieldset style={{ marginBottom: 0 }}>
          <legend>Options</legend>
          <select name="onConflict" defaultValue="set" aria-label="Conflict mode">
            <option value="set">set quantities — re-importing changes nothing</option>
            <option value="add">add quantities — a batch of new cards</option>
          </select>
          <select name="language" defaultValue="en" aria-label="Language">
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          {/* defaultChecked, not checked: uncontrolled server-rendered form. */}
          <label className="chip">
            <input type="checkbox" name="dryRun" defaultChecked={false} />
            <span>dry run</span>
          </label>
          <button type="submit">import</button>
        </fieldset>
      </form>

      <p className="import-hint">
        <b>set</b> is the safe default — the same file imported twice leaves the
        collection unchanged instead of doubling every quantity. Tick{" "}
        <b>dry run</b> to see exactly what would happen without writing anything.
      </p>
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

function Count({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <span>
      <b style={tone ? { color: tone } : undefined}>{value}</b> {label}
    </span>
  );
}

function ImportReport({
  summary, source, issues, missed, more, mirrorEmpty, clearHref,
}: {
  summary: ImportSummary;
  source: string;
  issues: ImportIssue[];
  missed: string[];
  more: number;
  mirrorEmpty: boolean;
  clearHref: string;
}) {
  const total = issueCount(summary);
  const shortfall = unmatchedLines(summary);
  const wrote = summary.dryRun ? "would write" : "wrote";
  const delta = summary.quantityDelta;

  return (
    <div className={`panel import-report${summary.dryRun ? " dry" : ""}`}>
      <h2>
        {summary.dryRun ? "Dry run — nothing was written" : "Imported"}
        {source ? <span className="src"> from {source}</span> : null}
        <a className="dismiss" href={clearHref}>dismiss</a>
      </h2>

      <div className="import-counts">
        {/* "parsed", not "in the file": a line the parser rejected never
            reaches linesTotal, so labelling this as the file's line count would
            hide exactly the rows the next paragraph is about. */}
        <Count label="lines parsed" value={summary.linesTotal} />
        <Count
          label="resolved"
          value={summary.linesMatched}
          tone={shortfall > 0 ? "var(--orange)" : "var(--green)"}
        />
        <Count label={`printings ${wrote}`} value={summary.rowsWritten} />
        <Count label="new" value={summary.rowsInserted} />
        <Count label="updated" value={summary.rowsUpdated} />
        <Count label="physical cards matched" value={summary.cardsMatched} />
        <Count
          label="net quantity"
          value={delta > 0 ? `+${delta}` : String(delta)}
          tone={delta < 0 ? "var(--orange)" : undefined}
        />
      </div>

      {/* The whole reason this report exists: a collection that quietly ends up
          smaller than the file it was built from is the failure mode.
          `issueCount`, not the resolve shortfall — a line the parser rejected
          is missing from the collection just as surely as one that resolved to
          nothing, and it is not counted in linesTotal, so keying this branch on
          the shortfall alone would print "every line resolved" over a file that
          failed to parse. */}
      {total > 0 ? (
        <p className="import-short">
          <b>{total}</b> row{total === 1 ? "" : "s"}{" "}
          {summary.dryRun ? "would not be imported" : "did not land"} —{" "}
          {summary.parseErrors} unparseable · {summary.noMatch} with no match ·{" "}
          {summary.ambiguous} ambiguous.
          {summary.dryRun ? null : <> Recorded in <code>collection_import_issues</code>.</>}
          {summary.linesTotal === 0 ? (
            <>
              {" "}Nothing parsed at all, which usually means the wrong format:
              this reads Moxfield / MTGO plain text
              (<code>1 Sol Ring (C19) 193</code>), not ManaBox CSV.
            </>
          ) : null}
        </p>
      ) : summary.linesTotal > 0 ? (
        <p className="import-ok">Every line in the file resolved to a printing.</p>
      ) : (
        <p className="import-short">
          <b>No card lines found.</b> Blank lines, comments and section headers
          are skipped, and this file held nothing else.
        </p>
      )}

      {mirrorEmpty ? (
        <p className="import-short">
          <b>The local Scryfall mirror is empty</b>, which is why nothing matched.
          Populate it with{" "}
          <code>docker compose --profile refresh run --rm scryfall-refresh</code>{" "}
          and import again.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <details className="import-issues">
          <summary>
            show the {issues.length < total ? `first ${issues.length} of ${total}` : total}{" "}
            unresolved line{total === 1 ? "" : "s"}
          </summary>
          <ul className="issue-list">
            {issues.map((issue, i) => (
              <li key={`${issue.line_number ?? "x"}-${i}`}>
                <span className="raw">
                  {issue.line_number !== null ? <em>{issue.line_number}</em> : null}
                  {issue.raw_line}
                </span>
                <span className="why"> — {REASON_TEXT[issue.reason] ?? issue.reason}</span>
                <Candidates value={issue.candidates} />
              </li>
            ))}
          </ul>
        </details>
      ) : missed.length > 0 ? (
        // Dry-run path: no audit row exists yet, so these travelled in the URL
        // and are capped. `more` says how many did not fit.
        <details className="import-issues" open>
          <summary>
            show {missed.length}
            {more > 0 ? ` of ${missed.length + more}` : ""} unresolved line
            {missed.length + more === 1 ? "" : "s"}
          </summary>
          <ul className="issue-list">
            {missed.map((m, i) => (
              <li key={i}><span className="raw">{m}</span></li>
            ))}
            {more > 0 ? (
              <li><span className="why">…and {more} more — run it for real to see them all</span></li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Near-misses stored alongside an ambiguous line.
 *
 * `candidates` is a JSONB column, so it arrives already parsed but with no type
 * whatsoever — anything written by an older importer, or a hand-edited row, has
 * to render as nothing rather than throw inside a server component and take the
 * whole page down with it.
 */
function Candidates({ value }: { value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const shown = value.slice(0, 3).map((c) => {
    const card = (c ?? {}) as Record<string, unknown>;
    const name = typeof card.name === "string" ? card.name : "?";
    const set = typeof card.set_code === "string" ? card.set_code.toUpperCase() : "?";
    const cn = typeof card.collector_number === "string" ? card.collector_number : "?";
    return `${name} (${set}) ${cn}`;
  });
  return (
    <span className="cands">
      {" "}did you mean: {shown.join(" · ")}
      {value.length > shown.length ? ` · +${value.length - shown.length} more` : ""}
    </span>
  );
}
