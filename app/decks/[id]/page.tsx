import { notFound, redirect } from "next/navigation";

import { currentUserId, parseCollectionId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { validateCommanderDeck, type DeckBoard } from "@/lib/commander";
import {
  BOARD_LABELS, DECK_BOARDS, loadDeckContents, loadOwnedDeck, parseScope,
  searchMirror, toDeckEntries,
} from "@/lib/deck";
import { Identity, Shell, usd } from "@/app/_ui";
import { Account } from "@/app/_account";
import { AddPanel, ImportSummary, PastePanel } from "./_add";
import { CurvePanel, LegalityPanel } from "./_analysis";
import { CardLine } from "./_cards";
import { DeleteConfirm, SettingsPanel, ShareControl } from "./_settings";

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
      account={<Account />}
      title={deck.name}
      actions={<ShareControl deckId={deckId} isPublic={deck.is_public} slug={deck.public_slug} />}
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
      {/* Step two of the delete. Rendered at the top rather than inside the
          settings panel it was launched from: a confirmation you have to go
          hunting for down a scrolled sidebar is one you will confirm blind. */}
      {one(sp.confirm) === "1" ? (
        <DeleteConfirm
          deckId={deckId}
          deck={deck}
          cards={cards.reduce((s, c) => s + c.quantity, 0)}
          unresolved={unresolved}
          err={one(sp.err)}
          base={base}
        />
      ) : null}

      <ImportSummary sp={sp} />

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
          <PastePanel deckId={deckId} />
          <LegalityPanel validation={validation} />
          <CurvePanel cards={cards} />
          <SettingsPanel deck={deck} deckId={deckId} base={base} />
        </aside>
      </div>
    </Shell>
  );
}
