import { notFound, redirect } from "next/navigation";

import { currentUserId, parseCollectionId } from "@/app/api/collections/access";
import { query } from "@/lib/db";
import { validateCommanderDeck } from "@/lib/commander";
import type { CommanderCard, DeckBoard, DeckEntry } from "@/lib/commander";
import { Badge, Empty, Identity, Shell } from "@/app/_ui";

export const dynamic = "force-dynamic";

/**
 * A `deck_cards` row joined to its mirror card. The index signature is there to
 * satisfy `query<T extends Record<string, unknown>>`; CommanderCard is a closed
 * interface by design, so it is added here rather than loosening the library type.
 */
interface DeckCardRow extends CommanderCard {
  quantity: number;
  board: DeckBoard;
  finish: string;
  [key: string]: unknown;
}

export default async function DeckPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const id = parseCollectionId((await params).id);
  if (id === null) notFound();

  const [deck] = await query<{ id: number; name: string; format: string }>(
    "SELECT id, name, format FROM decks WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (!deck) notFound();

  // INNER JOIN here, unlike the collection view: legality cannot be judged on a
  // card the mirror does not know, so an unresolved row must not silently count
  // as legal. The count difference is surfaced below.
  const rows = await query<DeckCardRow>(
    `SELECT dc.quantity, dc.board, dc.finish,
            s.id, s.oracle_id, s.name, s.set_code, s.collector_number, s.layout,
            s.type_line, s.oracle_text, s.color_identity, s.legalities, s.card_faces
       FROM deck_cards dc
       JOIN scryfall_cards s ON s.id = dc.scryfall_id
      WHERE dc.deck_id = $1
      ORDER BY dc.board, s.name`,
    [id],
  );

  const [{ total }] = await query<{ total: string }>(
    "SELECT COUNT(*)::text AS total FROM deck_cards WHERE deck_id = $1",
    [id],
  );
  const missing = Number(total) - rows.length;

  const entries: DeckEntry[] = rows.map((r) => ({
    card: r,
    quantity: r.quantity,
    board: r.board,
  }));

  const result = validateCommanderDeck(entries);
  const commanders = rows.filter((r) => r.board === "commander");
  const main = rows.filter((r) => r.board === "main");

  return (
    <Shell
      title={deck.name}
      subtitle={
        <>
          {deck.format} · {result.deckSize} cards ·{" "}
          {result.legal ? <Badge tone="good">legal</Badge> : <Badge tone="bad">illegal</Badge>}{" "}
          <Identity identity={result.commanderColorIdentity} />
        </>
      }
    >
      {missing > 0 ? (
        <p style={{ color: "var(--orange)" }}>
          {missing} card{missing === 1 ? "" : "s"} could not be found in the local Scryfall
          mirror and were excluded from validation. Refresh the mirror.
        </p>
      ) : null}

      {result.violations.length > 0 ? (
        <section style={{ marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Rules</h2>
          <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>
            {result.violations.map((v, i) => (
              <li
                key={`${v.rule}-${i}`}
                style={{ color: v.severity === "error" ? "var(--red)" : "var(--yellow)" }}
              >
                {v.message}
                {v.cards.length ? (
                  <span style={{ color: "var(--dim)" }}>
                    {" "}
                    — {v.cards.map((c) => c.name).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : rows.length > 0 ? (
        <p style={{ color: "var(--green)" }}>No rules violations.</p>
      ) : null}

      {commanders.length > 0 ? (
        <section style={{ marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Commander</h2>
          {commanders.map((c) => (
            <div key={c.id}>
              {c.name} <Identity identity={c.color_identity ?? []} />{" "}
              <span style={{ color: "var(--dim)" }}>{c.type_line}</span>
            </div>
          ))}
        </section>
      ) : null}

      <h2 style={{ fontSize: "1rem" }}>Deck</h2>
      {main.length === 0 ? (
        <Empty>No cards in this deck yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">Qty</th>
              <th>Card</th>
              <th>Type</th>
              <th>Identity</th>
            </tr>
          </thead>
          <tbody>
            {main.map((c) => (
              <tr key={`${c.id}-${c.finish}`}>
                <td className="num">{c.quantity}</td>
                <td>{c.name}</td>
                <td style={{ color: "var(--dim)" }}>{c.type_line}</td>
                <td>
                  <Identity identity={c.color_identity ?? []} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
