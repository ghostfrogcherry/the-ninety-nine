import Link from "next/link";
import { redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { query } from "@/lib/db";
import { DECK_FORMATS } from "@/lib/deck";
import { Badge, Empty, Shell } from "@/app/_ui";
import { createDeckAction } from "./_actions";

export const dynamic = "force-dynamic";

interface Row extends Record<string, unknown> {
  id: number;
  name: string;
  format: string;
  is_public: boolean;
  public_slug: string | null;
  cards: string;
  commanders: string | null;
}

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function DecksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  // `?deleted=<name>` is set by deleteDeckAction's redirect. Same reasoning as
  // the import summary on the deck page: the deck you were looking at is gone
  // and its page cannot report its own deletion, so the outcome rides on the
  // query string, survives a refresh, and leaves no state to clean up.
  const deleted = one((await searchParams).deleted).slice(0, 120);

  const rows = await query<Row>(
    `SELECT d.id, d.name, d.format, d.is_public, d.public_slug,
            COALESCE(SUM(dc.quantity) FILTER (WHERE dc.board IN ('main','commander')), 0)::text AS cards,
            -- Commander names for the list, from the mirror. LEFT JOIN so a deck
            -- whose commander is not yet mirrored still lists.
            NULLIF(string_agg(s.name, ' + ') FILTER (WHERE dc.board = 'commander'), '') AS commanders
       FROM decks d
       LEFT JOIN deck_cards dc ON dc.deck_id = d.id
       LEFT JOIN scryfall_cards s ON s.id = dc.scryfall_id
      WHERE d.user_id = $1
      GROUP BY d.id
      ORDER BY d.updated_at DESC, d.id DESC`,
    [userId],
  );

  return (
    <Shell
      title="decks"
      subtitle={rows.length ? `${rows.length} deck${rows.length === 1 ? "" : "s"}` : "no decks yet"}
    >
      {deleted ? (
        <p style={{ color: "var(--red)", fontSize: 12, margin: "0 0 1rem" }}>
          Deleted “{deleted}” and everything in it.
        </p>
      ) : null}

      <form action={createDeckAction} className="filters" style={{ marginBottom: "1.5rem" }}>
        <fieldset style={{ marginBottom: 0 }}>
          <legend>New deck</legend>
          <input
            type="text"
            name="name"
            placeholder="deck name…"
            required
            maxLength={120}
            style={{ minWidth: "18rem" }}
            aria-label="Deck name"
          />
          <select name="format" defaultValue="commander" aria-label="Format">
            {DECK_FORMATS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <button type="submit">create</button>
        </fieldset>
      </form>

      {rows.length === 0 ? (
        <Empty>No decks yet — name one above and start building.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Deck</th>
              <th>Commander</th>
              <th>Format</th>
              <th className="num">Cards</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const n = Number(d.cards);
              // 100 is the Commander requirement; anything else is in progress.
              const complete = d.format === "commander" && n === 100;
              return (
                <tr key={d.id}>
                  <td><Link href={`/decks/${d.id}`}>{d.name}</Link></td>
                  <td style={{ color: "var(--dim)" }}>{d.commanders ?? "—"}</td>
                  <td style={{ color: "var(--dim)" }}>{d.format}</td>
                  <td className="num" style={{ color: complete ? "var(--green)" : "var(--dim)" }}>
                    {n}
                  </td>
                  <td>
                    {d.is_public && d.public_slug ? (
                      <Link href={`/d/${d.public_slug}`}><Badge tone="warn">shared</Badge></Link>
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
