/**
 * Reading back what an import could not resolve.
 *
 * The write half lives in resolve.ts, which records every unmatched line in
 * `collection_import_issues` rather than dropping it. This is the read half,
 * used by the collection page to show the user exactly which rows did not land.
 * Kept out of the component so the ownership predicate below is something a
 * test can pin rather than something a comment claims.
 */

import type { Queryable } from "./resolve";

export interface ImportIssue extends Record<string, unknown> {
  /** NULL is possible in the schema; a parse error always has one in practice. */
  line_number: number | null;
  raw_line: string;
  /** 'parse_error' | 'no_match' | 'ambiguous'. */
  reason: string;
  /** JSONB. Near-misses for an ambiguous line — arrives parsed but untyped. */
  candidates: unknown;
}

/**
 * Cap on how many issues are fetched for one report.
 *
 * A 30,000-line file in the wrong format resolves to 30,000 issues, and hauling
 * all of them into a page render is a lot of work to tell the user something the
 * first fifty already said. The true total comes from the import summary, so the
 * count stays honest even when the list is trimmed.
 */
export const ISSUE_RENDER_LIMIT = 500;

/**
 * Issues belonging to one import, scoped to the collection that owns it.
 *
 * `ci.collection_id = $2` is an ownership check, not decoration. The caller has
 * already proved the *collection* belongs to the signed-in user, but the import
 * id arrives from the query string — without this join, editing that number by
 * hand would print somebody else's raw import lines, which are the contents of
 * their collection in plain text. An import id from another collection returns
 * an empty list, exactly as a nonexistent one does, so this cannot be used to
 * probe which import ids exist either.
 */
export async function loadImportIssues(
  db: Queryable,
  importId: number,
  collectionId: number,
  limit: number = ISSUE_RENDER_LIMIT,
): Promise<ImportIssue[]> {
  const res = await db.query(
    `SELECT i.line_number, i.raw_line, i.reason, i.candidates
       FROM collection_import_issues i
       JOIN collection_imports ci ON ci.id = i.import_id
      WHERE i.import_id = $1 AND ci.collection_id = $2
      -- Line order, because the user is reading this next to the file they
      -- uploaded. NULLS LAST keeps a line-less row from heading the list.
      ORDER BY i.line_number NULLS LAST, i.id
      LIMIT $3`,
    [importId, collectionId, limit],
  );
  return res.rows as ImportIssue[];
}
