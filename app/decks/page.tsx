import Link from "next/link";
import { redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { query } from "@/lib/db";
import { Badge, Empty, Shell } from "@/app/_ui";

export const dynamic = "force-dynamic";

interface Row extends Record<string, unknown> {
  id: number;
  name: string;
  format: string;
  is_public: boolean;
  public_slug: string | null;
  cards: string;
}

export default async function DecksPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const rows = await query<Row>(
    `SELECT d.id, d.name, d.format, d.is_public, d.public_slug,
            COALESCE(SUM(dc.quantity) FILTER (WHERE dc.board IN ('main','commander')), 0)::text AS cards
       FROM decks d
       LEFT JOIN deck_cards dc ON dc.deck_id = d.id
      WHERE d.user_id = $1
      GROUP BY d.id
      ORDER BY d.updated_at DESC, d.id DESC`,
    [userId],
  );

  return (
    <Shell title="Decks" subtitle={rows.length ? `${rows.length} deck${rows.length === 1 ? "" : "s"}` : undefined}>
      {rows.length === 0 ? (
        <Empty>No decks yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Format</th>
              <th className="num">Cards</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const n = Number(d.cards);
              return (
                <tr key={d.id}>
                  <td>
                    <Link href={`/decks/${d.id}`}>{d.name}</Link>
                  </td>
                  <td style={{ color: "var(--dim)" }}>{d.format}</td>
                  {/* 100 is the Commander requirement; anything else is a work in progress. */}
                  <td className="num" style={{ color: n === 100 ? "var(--green)" : "var(--dim)" }}>
                    {n}
                  </td>
                  <td>
                    {d.is_public && d.public_slug ? (
                      <Link href={`/d/${d.public_slug}`}>
                        <Badge tone="warn">shared</Badge>
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
