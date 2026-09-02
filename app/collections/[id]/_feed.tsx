"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, Identity, usd } from "@/app/_ui";

export interface FeedCard {
  scryfall_id: string;
  quantity: number;
  finish: string;
  name: string | null;
  set_code: string | null;
  collector_number: string | null;
  rarity: string | null;
  type_line: string | null;
  cmc: number | null;
  color_identity: string[] | null;
  image: string | null;
  unit_price: string | null;
}

/**
 * Infinite-scrolling card feed.
 *
 * The first page is rendered on the server and passed in, so the collection is
 * visible before hydration and with JavaScript off entirely. Scrolling then
 * appends further pages from /api/collections/[id]/browse, which shares its
 * filter code with the page — the feed cannot drift from the initial render.
 */
export function CardFeed({
  collectionId,
  initialRows,
  initialHasMore,
  view,
  queryString,
}: {
  collectionId: number;
  initialRows: FeedCard[];
  initialHasMore: boolean;
  view: "grid" | "table";
  /** The page's own filters, replayed verbatim so paging matches the render. */
  queryString: string;
}) {
  const [rows, setRows] = useState<FeedCard[]>(initialRows);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Filters live in the URL; when they change the server sends a fresh first
  // page. Reset rather than appending onto the previous filter's results.
  useEffect(() => {
    setRows(initialRows);
    setPage(1);
    setHasMore(initialHasMore);
    setError(null);
  }, [initialRows, initialHasMore, queryString, view]);

  const loadMore = useCallback(async () => {
    // The guard is inside the callback, not the observer, because the observer
    // can fire again before React has re-rendered with loading = true.
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    try {
      const next = page + 1;
      const qs = new URLSearchParams(queryString);
      qs.set("page", String(next));
      qs.set("view", view);
      const res = await fetch(`/api/collections/${collectionId}/browse?${qs}`);
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const data: { rows: FeedCard[]; hasMore: boolean } = await res.json();
      setRows((prev) => [...prev, ...data.rows]);
      setPage(next);
      setHasMore(data.hasMore);
    } catch (err) {
      // Surface it and stop, rather than spinning forever against a dead
      // endpoint — the sentinel would otherwise retry on every scroll tick.
      setError(err instanceof Error ? err.message : "could not load more");
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [collectionId, hasMore, loading, page, queryString, view]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      // Start fetching before the sentinel is actually on screen so the next
      // page is usually already there by the time you reach the bottom.
      { rootMargin: "800px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  return (
    <>
      {view === "grid" ? <Grid rows={rows} /> : <Table rows={rows} />}

      <div ref={sentinel} aria-hidden style={{ height: 1 }} />

      <div style={{ textAlign: "center", padding: "1.5rem 0", fontSize: 12, color: "var(--dim)" }}>
        {error ? (
          <span style={{ color: "var(--red)" }}>
            {error} —{" "}
            <button
              type="button"
              onClick={() => { setHasMore(true); setError(null); void loadMore(); }}
              style={{ background: "none", border: 0, color: "var(--aqua)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
            >
              retry
            </button>
          </span>
        ) : loading ? (
          <span className="blink">loading…</span>
        ) : hasMore ? (
          // Real button as well as the observer: keyboard users and anyone
          // whose browser never fires the observer still have a way down.
          <button
            type="button"
            onClick={() => void loadMore()}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 3, color: "var(--dim)", cursor: "pointer", font: "inherit", fontSize: 12, padding: "0.3rem 1rem" }}
          >
            load more
          </button>
        ) : rows.length > 0 ? (
          <span style={{ color: "var(--dim2)" }}>— {rows.length} shown —</span>
        ) : null}
      </div>
    </>
  );
}

function Grid({ rows }: { rows: FeedCard[] }) {
  return (
    <div className="grid">
      {rows.map((c, i) => (
        <figure className="tile" key={`${c.scryfall_id}-${c.finish}-${i}`} style={{ margin: 0 }}>
          {c.image ? (
            // Plain <img>: Scryfall's CDN already serves correctly-sized art, and
            // next/image would proxy every one of these through the app for no gain.
            <img src={c.image} alt={c.name ?? "card"} loading="lazy" decoding="async" />
          ) : (
            <div className="tile-missing">{c.name ?? "not in mirror"}</div>
          )}
          {c.quantity > 1 ? <span className="qty">×{c.quantity}</span> : null}
          {c.finish !== "nonfoil" ? <span className="foil">{c.finish}</span> : null}
          <figcaption>
            <span className="setcode">
              {c.set_code?.toUpperCase()} {c.collector_number}
            </span>
            <span className="p">{usd(c.unit_price)}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function Table({ rows }: { rows: FeedCard[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th className="num">Qty</th>
          <th>Card</th>
          <th>Type</th>
          <th className="num">MV</th>
          <th>Set</th>
          <th>Identity</th>
          <th className="num">Price</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <tr key={`${c.scryfall_id}-${c.finish}-${i}`}>
            <td className="num">{c.quantity}</td>
            <td>
              {c.name ?? <span style={{ color: "var(--dim2)" }}>{c.scryfall_id}</span>}{" "}
              {c.finish !== "nonfoil" ? <Badge tone="warn">{c.finish}</Badge> : null}
            </td>
            <td style={{ color: "var(--dim)" }}>{c.type_line}</td>
            <td className="num" style={{ color: "var(--dim)" }}>{c.cmc ?? "—"}</td>
            <td style={{ color: "var(--dim)" }}>
              {c.set_code ? `${c.set_code.toUpperCase()} ${c.collector_number}` : "—"}
            </td>
            <td><Identity identity={c.color_identity ?? []} /></td>
            <td className="num">{usd(c.unit_price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
