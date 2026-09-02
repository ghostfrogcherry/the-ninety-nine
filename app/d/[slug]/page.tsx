import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { query } from "@/lib/db";
import { validateCommanderDeck, type CommanderCard, type DeckBoard } from "@/lib/commander";
import { BOARD_LABELS, DECK_BOARDS } from "@/lib/deck";
import { Identity, usd } from "@/app/_ui";
import { isPlausibleSlug } from "../_share";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated deck view.
 *
 * Deliberately NOT reusing loadDeckContents: that computes "copies you own",
 * which is both meaningless to a stranger and a leak of the owner's collection.
 * Nothing on this page exposes the owner's identity or the deck's numeric id —
 * the slug is the only handle.
 */

interface PublicDeck extends Record<string, unknown> {
  name: string;
  format: string;
  description: string | null;
}

interface PublicCard extends CommanderCard {
  quantity: number;
  board: DeckBoard;
  finish: string;
  cmc: number | null;
  image: string | null;
  unit_price: string | null;
  [key: string]: unknown;
}

async function load(slug: string) {
  // `is_public` is what decides visibility, not the presence of a slug: an
  // un-shared deck keeps its slug so re-sharing restores the same link, so
  // checking only the slug would keep every revoked URL alive.
  const [deck] = await query<PublicDeck>(
    `SELECT name, format, description
       FROM decks
      WHERE public_slug = $1 AND is_public = TRUE`,
    [slug],
  );
  if (!deck) return null;

  const cards = await query<PublicCard>(
    `SELECT dc.quantity, dc.board, dc.finish,
            s.id::text AS id, s.oracle_id::text AS oracle_id, s.name,
            s.set_code, s.collector_number, s.layout,
            s.type_line, s.oracle_text, s.color_identity, s.legalities, s.card_faces,
            s.cmc,
            COALESCE(s.image_uris->>'normal', s.card_faces->0->'image_uris'->>'normal') AS image,
            (CASE dc.finish
               WHEN 'foil'   THEN s.prices->>'usd_foil'
               WHEN 'etched' THEN s.prices->>'usd_etched'
               ELSE s.prices->>'usd' END) AS unit_price
       FROM decks d
       JOIN deck_cards dc ON dc.deck_id = d.id
       JOIN scryfall_cards s ON s.id = dc.scryfall_id
      WHERE d.public_slug = $1 AND d.is_public = TRUE
      ORDER BY dc.board, s.name`,
    [slug],
  );

  return { deck, cards };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!isPlausibleSlug(slug)) return { title: "Not found" };
  const found = await load(slug);
  return found
    ? { title: `${found.deck.name} — The Ninety Nine`, description: `A ${found.deck.format} deck.` }
    : { title: "Not found" };
}

export default async function PublicDeckPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Reject malformed slugs before touching the database — a 404 either way, but
  // this keeps junk paths off the query.
  if (!isPlausibleSlug(slug)) notFound();

  const found = await load(slug);
  // Never-existed and no-longer-shared are the same 404, so the URL space
  // cannot be probed for decks that were once public.
  if (!found) notFound();

  const { deck, cards } = found;
  const validation = validateCommanderDeck(
    cards.map((c) => ({ card: c, quantity: c.quantity, board: c.board })),
  );
  const value = cards.reduce((s, c) => s + Number(c.unit_price ?? 0) * c.quantity, 0);

  return (
    <main style={{ maxWidth: "62rem", margin: "0 auto", padding: "1.75rem 1.5rem 4rem" }}>
      <nav className="topnav">
        <span className="brand">the·ninety·nine</span>
        <span style={{ color: "var(--dim2)", fontSize: 11 }}>shared deck</span>
      </nav>

      <h1 className="prompt" style={{ margin: "0 0 0.25rem", fontSize: "1.4rem" }}>{deck.name}</h1>
      <p style={{ margin: "0 0 1.5rem", color: "var(--dim)" }}>
        {deck.format} · <span className="stat">{validation.deckSize}</span> cards ·{" "}
        <span className={validation.legal ? "legal-ok" : "legal-bad"}>
          {validation.legal ? "legal" : `${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"}`}
        </span>{" "}
        <Identity identity={validation.commanderColorIdentity} />
        {" · "}
        <span style={{ color: "var(--dim)" }}>{usd(value)}</span>
      </p>

      {deck.description ? (
        <p style={{ color: "var(--fg2)", marginBottom: "1.5rem" }}>{deck.description}</p>
      ) : null}

      {DECK_BOARDS.map((board) => {
        const rows = cards.filter((c) => c.board === board);
        if (rows.length === 0) return null;
        const count = rows.reduce((s, c) => s + c.quantity, 0);
        return (
          <section key={board}>
            <h2 className="board-head">
              {BOARD_LABELS[board]} <span className="count">{count}</span>
            </h2>
            <div className="grid">
              {rows.map((c) => (
                <figure className="tile" key={`${c.id}-${c.finish}-${board}`}>
                  {c.image ? (
                    <img src={c.image} alt={c.name} loading="lazy" decoding="async" />
                  ) : (
                    <div className="tile-missing">{c.name}</div>
                  )}
                  {c.quantity > 1 ? <span className="qty">×{c.quantity}</span> : null}
                  {c.finish !== "nonfoil" ? <span className="foil">{c.finish}</span> : null}
                  <figcaption>
                    <span className="setcode">{c.name}</span>
                    <span className="p">{usd(c.unit_price)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        );
      })}

      {validation.violations.length > 0 ? (
        <section className="panel" style={{ marginTop: "2rem" }}>
          <h2>Commander legality</h2>
          {validation.violations.map((v, i) => (
            <div key={`${v.rule}-${i}`} className={`violation${v.severity === "warning" ? " warn" : ""}`}>
              <div style={{ fontSize: 12, color: v.severity === "error" ? "var(--red)" : "var(--yellow)" }}>
                {v.message}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </main>
  );
}
