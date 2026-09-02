import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { currentUserId, parseCollectionId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { validateCommanderDeck, type DeckBoard } from "@/lib/commander";
import {
  BOARD_LABELS, DECK_BOARDS, loadDeckContents, loadOwnedDeck, parseScope,
  searchMirror, toDeckEntries,
  type DeckCardDetail, type MirrorSearchRow,
} from "@/lib/deck";
import { Badge, Identity, Shell, usd } from "@/app/_ui";
import { addCardAction, moveCardAction, removeCardAction, setQuantityAction } from "../_actions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function DeckPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const deckId = parseCollectionId((await params).id);
  if (deckId === null) notFound();

  const deck = await loadOwnedDeck(pool, deckId, userId);
  // Not-yours and not-real are the same 404, so this cannot enumerate deck ids.
  if (!deck) notFound();

  const sp = await searchParams;
  const q = one(sp.q).slice(0, 80);
  const scope = parseScope(one(sp.scope));

  const { cards, unresolved } = await loadDeckContents(pool, deckId, userId);
  const results = q ? await searchMirror(pool, { userId, q, scope, limit: 30 }) : [];

  const validation = validateCommanderDeck(toDeckEntries(cards));
  const byBoard = (b: DeckBoard) => cards.filter((c) => c.board === b);
  const base = `/decks/${deckId}`;

  return (
    <Shell
      title={deck.name}
      subtitle={
        <>
          {deck.format} · <span className="stat">{validation.deckSize}</span> cards ·{" "}
          <span className={validation.legal ? "legal-ok" : "legal-bad"}>
            {validation.legal ? "legal" : `${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"}`}
          </span>{" "}
          <Identity identity={validation.commanderColorIdentity} />
          {" · "}
          <span style={{ color: "var(--dim)" }}>
            {usd(cards.reduce((s, c) => s + Number(c.unit_price ?? 0) * c.quantity, 0))}
          </span>
        </>
      }
    >
      {unresolved > 0 ? (
        <p style={{ color: "var(--orange)" }}>
          {unresolved} card{unresolved === 1 ? "" : "s"} in this deck are not in the local
          Scryfall mirror and are excluded from validation. Refresh the mirror.
        </p>
      ) : null}

      <div className="deck-cols">
        <section>
          {DECK_BOARDS.map((board) => {
            const rows = byBoard(board);
            if (rows.length === 0 && board !== "main" && board !== "commander") return null;
            const count = rows.reduce((s, c) => s + c.quantity, 0);
            return (
              <div key={board}>
                <h2 className="board-head">
                  {BOARD_LABELS[board]} <span className="count">{count}</span>
                </h2>
                {rows.length === 0 ? (
                  <p style={{ color: "var(--dim2)", fontSize: 12, margin: "0.3rem 0 0" }}>
                    {board === "commander" ? "no commander set — add one from the search panel" : "empty"}
                  </p>
                ) : (
                  rows.map((c) => <CardLine key={c.row_id} card={c} deckId={deckId} board={board} />)
                )}
              </div>
            );
          })}
        </section>

        <aside style={{ display: "grid", gap: "1rem" }}>
          <AddPanel base={base} q={q} scope={scope} results={results} deckId={deckId} />
          <LegalityPanel validation={validation} />
          <CurvePanel cards={cards} />
        </aside>
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */

function CardLine({ card, deckId, board }: {
  card: DeckCardDetail; deckId: number; board: DeckBoard;
}) {
  // Owning fewer copies than the deck asks for is worth flagging — this is a
  // collection app, and a deck you cannot physically build is useful to know.
  const short = card.owned < card.quantity;
  return (
    <div className="rowline">
      <form action={setQuantityAction}>
        <input type="hidden" name="deckId" value={deckId} />
        <input type="hidden" name="rowId" value={card.row_id} />
        <input
          className="qtybox"
          type="number"
          name="quantity"
          min={0}
          max={999}
          defaultValue={card.quantity}
          aria-label={`Quantity of ${card.name}`}
        />
        <button className="mini" type="submit" title="set quantity (0 removes)">set</button>
      </form>

      <span className="grow">
        {card.name}
        {card.finish !== "nonfoil" ? <> <Badge tone="warn">{card.finish}</Badge></> : null}
        <span style={{ color: "var(--dim2)", fontSize: 11 }}>
          {" "}{card.set_code?.toUpperCase()} · {card.type_line}
        </span>
      </span>

      <span
        style={{ fontSize: 11, color: short ? "var(--orange)" : "var(--dim2)" }}
        title={short ? "you own fewer copies than this deck uses" : "copies you own"}
      >
        {card.owned}/{card.quantity}
      </span>
      <Identity identity={card.color_identity ?? []} />
      <span style={{ fontSize: 11, color: "var(--dim)", minWidth: "3.2rem", textAlign: "right" }}>
        {usd(card.unit_price)}
      </span>

      <form action={moveCardAction}>
        <input type="hidden" name="deckId" value={deckId} />
        <input type="hidden" name="rowId" value={card.row_id} />
        <select className="mini" name="board" defaultValue={board} aria-label={`Move ${card.name}`}>
          {DECK_BOARDS.map((b) => (
            <option key={b} value={b}>{BOARD_LABELS[b]}</option>
          ))}
        </select>
        <button className="mini" type="submit" title="move to board">→</button>
      </form>

      <form action={removeCardAction}>
        <input type="hidden" name="deckId" value={deckId} />
        <input type="hidden" name="rowId" value={card.row_id} />
        <button className="mini danger" type="submit" title="remove from deck">✕</button>
      </form>
    </div>
  );
}

function AddPanel({ base, q, scope, results, deckId }: {
  base: string; q: string; scope: string; results: MirrorSearchRow[]; deckId: number;
}) {
  return (
    <div className="panel">
      <h2>Add cards</h2>
      {/* GET form: the search term lives in the URL, so a search survives the
          POST-redirect of adding a card and you can add several in a row. */}
      <form method="get" action={base} style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="card name…"
          style={{ flex: 1, minWidth: "9rem", background: "var(--bg0)", border: "1px solid var(--border)", color: "var(--fg1)", borderRadius: 3, padding: "0.25rem 0.4rem", font: "inherit", fontSize: 12 }}
          aria-label="Search cards"
        />
        <select
          name="scope"
          defaultValue={scope}
          aria-label="Search scope"
          style={{ background: "var(--bg0)", border: "1px solid var(--border)", color: "var(--fg1)", borderRadius: 3, fontSize: 12 }}
        >
          <option value="owned">owned</option>
          <option value="all">all cards</option>
        </select>
        <button className="mini" type="submit">search</button>
      </form>

      <div style={{ marginTop: "0.6rem", maxHeight: "22rem", overflowY: "auto" }}>
        {q === "" ? (
          <p style={{ color: "var(--dim2)", fontSize: 11 }}>
            Search your collection, or switch to “all cards” for the full mirror.
            Nothing here calls Scryfall — it is all local.
          </p>
        ) : results.length === 0 ? (
          <p style={{ color: "var(--dim2)", fontSize: 11 }}>No match in the local mirror.</p>
        ) : (
          results.map((r) => (
            <form key={r.id} action={addCardAction} className="rowline" style={{ gap: "0.35rem" }}>
              <input type="hidden" name="deckId" value={deckId} />
              <input type="hidden" name="scryfallId" value={r.id} />
              <input type="hidden" name="quantity" value="1" />
              <span className="grow" style={{ fontSize: 12 }}>
                {r.name}
                <span style={{ color: "var(--dim2)", fontSize: 10 }}>
                  {" "}{r.set_code?.toUpperCase()}
                  {r.owned > 0 ? <> · owned {r.owned}</> : null}
                  {r.legalities?.commander === "banned" ? <> · <span style={{ color: "var(--red)" }}>banned</span></> : null}
                </span>
              </span>
              <Identity identity={r.color_identity ?? []} />
              <select className="mini" name="board" defaultValue="main" aria-label="Board">
                {DECK_BOARDS.map((b) => <option key={b} value={b}>{BOARD_LABELS[b]}</option>)}
              </select>
              <button className="mini" type="submit" title="add to deck">+</button>
            </form>
          ))
        )}
      </div>
    </div>
  );
}

function LegalityPanel({ validation }: { validation: ReturnType<typeof validateCommanderDeck> }) {
  return (
    <div className="panel">
      <h2>Commander legality</h2>
      {validation.violations.length === 0 ? (
        <p className="legal-ok" style={{ margin: 0, fontSize: 12 }}>No rules violations.</p>
      ) : (
        validation.violations.map((v, i) => (
          <div key={`${v.rule}-${i}`} className={`violation${v.severity === "warning" ? " warn" : ""}`}>
            <div style={{ fontSize: 12, color: v.severity === "error" ? "var(--red)" : "var(--yellow)" }}>
              {v.message}
            </div>
            {v.cards.length ? (
              <div style={{ fontSize: 11, color: "var(--dim)" }}>
                {v.cards.map((c) => c.name).join(", ")}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

/** Mana curve over the main board. Lands are excluded — they have no mana value
 *  to speak of and would swamp the 0 column. */
function CurvePanel({ cards }: { cards: DeckCardDetail[] }) {
  const buckets = new Array(8).fill(0) as number[];
  let counted = 0;
  for (const c of cards) {
    if (c.board !== "main") continue;
    if (/\bland\b/i.test(c.type_line ?? "")) continue;
    const mv = Math.max(0, Math.round(c.cmc ?? 0));
    buckets[Math.min(mv, 7)] += c.quantity;
    counted += c.quantity;
  }
  const max = Math.max(1, ...buckets);

  return (
    <div className="panel">
      <h2>Mana curve <span style={{ color: "var(--dim2)" }}>({counted} nonland)</span></h2>
      {counted === 0 ? (
        <p style={{ color: "var(--dim2)", fontSize: 11, margin: 0 }}>Nothing to chart yet.</p>
      ) : (
        <>
          <div className="curve">
            {buckets.map((n, i) => (
              <div
                key={i}
                className="bar"
                style={{ height: `${(n / max) * 100}%` }}
                title={`${n} card${n === 1 ? "" : "s"} at mana value ${i === 7 ? "7+" : i}`}
              />
            ))}
          </div>
          <div className="curve-labels">
            {buckets.map((_, i) => <span key={i}>{i === 7 ? "7+" : i}</span>)}
          </div>
        </>
      )}
    </div>
  );
}
