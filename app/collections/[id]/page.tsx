import { notFound, redirect } from "next/navigation";

import { currentUserId, parseCollectionId } from "@/app/api/collections/access";
import { query } from "@/lib/db";
import { Badge, Empty, Identity, Shell, usd } from "@/app/_ui";

export const dynamic = "force-dynamic";

interface CardRow extends Record<string, unknown> {
  scryfall_id: string;
  quantity: number;
  finish: string;
  name: string | null;
  set_code: string | null;
  collector_number: string | null;
  rarity: string | null;
  color_identity: string[] | null;
  usd: string | null;
}

export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const id = parseCollectionId((await params).id);
  if (id === null) notFound();

  const [collection] = await query<{ id: number; name: string }>(
    "SELECT id, name FROM collections WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  // Someone else's collection reads as missing rather than forbidden, so the
  // page cannot be used to enumerate which ids exist.
  if (!collection) notFound();

  // LEFT JOIN scryfall_cards: the mirror is a cache and may be empty or stale,
  // and a card the mirror has not heard of must still show its quantity rather
  // than disappear from the owner's collection.
  const cards = await query<CardRow>(
    `SELECT cc.scryfall_id, cc.quantity, cc.finish,
            s.name, s.set_code, s.collector_number, s.rarity, s.color_identity,
            CASE WHEN cc.finish = 'foil' THEN s.prices->>'usd_foil'
                 WHEN cc.finish = 'etched' THEN s.prices->>'usd_etched'
                 ELSE s.prices->>'usd' END AS usd
       FROM collection_cards cc
       LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
      WHERE cc.collection_id = $1
      ORDER BY s.name NULLS LAST, s.set_code, s.collector_number`,
    [id],
  );

  const physical = cards.reduce((s, c) => s + c.quantity, 0);
  const value = cards.reduce((s, c) => s + Number(c.usd ?? 0) * c.quantity, 0);
  const unresolved = cards.filter((c) => c.name === null).length;

  return (
    <Shell
      title={collection.name}
      subtitle={
        `${cards.length} printings · ${physical} cards · ${usd(value)}` +
        (unresolved ? ` · ${unresolved} not in the local mirror` : "")
      }
    >
      {cards.length === 0 ? (
        <Empty>This collection is empty.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">Qty</th>
              <th>Card</th>
              <th>Set</th>
              <th>Identity</th>
              <th className="num">Price</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={`${c.scryfall_id}-${c.finish}`}>
                <td className="num">{c.quantity}</td>
                <td>
                  {c.name ?? <span style={{ color: "var(--dim2)" }}>{c.scryfall_id}</span>}{" "}
                  {c.finish !== "nonfoil" ? <Badge tone="warn">{c.finish}</Badge> : null}
                </td>
                <td style={{ color: "var(--dim)" }}>
                  {c.set_code ? `${c.set_code.toUpperCase()} ${c.collector_number}` : "—"}
                </td>
                <td>
                  <Identity identity={c.color_identity ?? []} />
                </td>
                <td className="num">{usd(c.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
