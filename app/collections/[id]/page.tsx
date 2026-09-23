import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { currentUserId, parseCollectionId } from "@/app/api/collections/access";
import { query } from "@/lib/db";
import {
  IMAGE_SQL, PAGE_SIZES, UNIT_PRICE_SQL,
  buildWhere, isFiltered, parseFilters, withParam,
  type View,
} from "@/lib/collection/filters";
import { IMPORT_URL_KEYS } from "@/lib/import/form";
import { Shell, usd } from "@/app/_ui";
import { FilterBar, ViewToggle } from "./_filters";
import { CardFeed, type FeedCard } from "./_feed";
import { ImportSection } from "./_import";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const id = parseCollectionId((await params).id);
  if (id === null) notFound();

  const [collection] = await query<{ id: number; name: string }>(
    "SELECT id, name FROM collections WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  // Someone else's collection reads as missing rather than forbidden, so this
  // page cannot be used to enumerate which ids exist.
  if (!collection) notFound();

  const sp = await searchParams;
  const filters = parseFilters(sp);
  const { where, params: whereParams, orderBy } = buildWhere(filters, id);
  const base = `/collections/${id}`;

  // One aggregate pass over the filtered set, so the header describes what is
  // actually on screen rather than the collection total.
  const [totals] = await query<{ printings: string; cards: string; value: string | null }>(
    `SELECT count(*)::text AS printings,
            COALESCE(sum(cc.quantity),0)::text AS cards,
            COALESCE(sum(cc.quantity * ${UNIT_PRICE_SQL}),0)::text AS value
       FROM collection_cards cc
       LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE ${where}`,
    whereParams,
  );

  const perPage = PAGE_SIZES[filters.view];

  // One row beyond the page, purely to tell the feed whether to keep scrolling.
  const fetched = await query<FeedCard & Record<string, unknown>>(
    `SELECT cc.scryfall_id::text AS scryfall_id, cc.quantity, cc.finish,
            s.name, s.set_code, s.collector_number, s.rarity, s.type_line, s.cmc,
            s.color_identity,
            ${IMAGE_SQL} AS image,
            ${UNIT_PRICE_SQL}::text AS unit_price
       FROM collection_cards cc
       LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT $${whereParams.length + 1}`,
    [...whereParams, perPage + 1],
  );

  const hasMore = fetched.length > perPage;
  const rows = hasMore ? fetched.slice(0, perPage) : fetched;

  // Whether the collection holds anything at all, which is NOT the same as the
  // filtered count above: a filter that matches nothing must not make the
  // import form spring open over a collection that is perfectly well stocked.
  const [{ any_cards: hasCards }] = await query<{ any_cards: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM collection_cards WHERE collection_id = $1) AS any_cards",
    [id],
  );

  // Sets actually present in this collection, for the dropdown.
  const setRows = await query<{ set_code: string }>(
    `SELECT DISTINCT s.set_code
       FROM collection_cards cc JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE cc.collection_id = $1 AND s.set_code IS NOT NULL
      ORDER BY s.set_code`,
    [id],
  );

  // Replayed verbatim by the feed so scrolled pages match the first render.
  // The import report's own params are dropped: they say nothing about which
  // cards to fetch, and a dry run's dozen unresolved lines would otherwise be
  // appended to every scroll request for as long as the banner is on screen.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined || k === "page" || IMPORT_URL_KEYS.includes(k)) continue;
    for (const item of Array.isArray(v) ? v : [v]) if (item) qs.append(k, item);
  }

  const matched = Number(totals.printings);

  return (
    <Shell
      title={collection.name}
      actions={
        <Link href={`/collections/${id}/prices`} style={{ fontSize: 12 }}>
          price history →
        </Link>
      }
      subtitle={
        <>
          <span className="stat">{matched}</span> printings ·{" "}
          <span className="stat">{totals.cards}</span> cards ·{" "}
          <span className="stat">{usd(totals.value)}</span>
          {isFiltered(filters) ? <> · <span style={{ color: "var(--yellow)" }}>filtered</span></> : null}
          {" · "}
          <ViewToggle current={filters.view} hrefFor={(v: View) => `${base}${withParam(sp, "view", v)}`} />
        </>
      }
    >
      <ImportSection collectionId={id} searchParams={sp} empty={!hasCards} />

      <FilterBar filters={filters} sets={setRows.map((r) => r.set_code)} action={base} />

      {rows.length === 0 ? (
        <p className="empty">
          {isFiltered(filters)
            ? "Nothing matches those filters."
            : "This collection is empty — import an export above."}
        </p>
      ) : (
        <CardFeed
          collectionId={id}
          // Keyed on the query so changing a filter remounts the feed rather
          // than appending new results onto the previous filter's rows.
          key={`${qs.toString()}|${filters.view}`}
          initialRows={rows}
          initialHasMore={hasMore}
          view={filters.view}
          queryString={qs.toString()}
        />
      )}
    </Shell>
  );
}
