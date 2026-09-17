import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { currentUserId, parseCollectionId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { validateCommanderDeck, type DeckBoard } from "@/lib/commander";
import {
  BOARD_LABELS, DECK_BOARDS, DECK_FORMATS, loadDeckContents, loadOwnedDeck, parseScope,
  searchMirror, toDeckEntries,
  type DeckCardDetail, type DeckRow, type MirrorSearchRow,
} from "@/lib/deck";
import { Badge, Identity, Notice, Shell, usd } from "@/app/_ui";
import {
  addCardAction, deleteDeckAction, importDeckListAction, moveCardAction, removeCardAction,
  renameDeckAction, setQuantityAction, shareDeckAction, unshareDeckAction,
} from "../_actions";

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

/* ------------------------------------------------------------------ */

/**
 * Share toggle.
 *
 * "unshare" leaves the slug in place so re-sharing restores the same link a
 * friend may have bookmarked; "rotate" is the separate, explicit button for
 * when the point IS to kill the old URL.
 */
function ShareControl({ deckId, isPublic, slug }: {
  deckId: number; isPublic: boolean; slug: string | null;
}) {
  if (!isPublic) {
    return (
      <form action={shareDeckAction} style={{ display: "inline-flex", gap: "0.4rem" }}>
        <input type="hidden" name="deckId" value={deckId} />
        <button className="mini" type="submit" title="publish at a public link">share</button>
      </form>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center", fontSize: 11 }}>
      <Link href={`/d/${slug}`} title="open the public page">/d/{slug?.slice(0, 8)}…</Link>
      <form action={shareDeckAction} style={{ display: "inline" }}>
        <input type="hidden" name="deckId" value={deckId} />
        <input type="hidden" name="rotate" value="1" />
        <button className="mini" type="submit" title="issue a new link; the old one stops working">
          rotate
        </button>
      </form>
      <form action={unshareDeckAction} style={{ display: "inline" }}>
        <input type="hidden" name="deckId" value={deckId} />
        <button className="mini danger" type="submit" title="make private again">unshare</button>
      </form>
    </span>
  );
}

/**
 * Rename, re-format, and the way in to deleting.
 *
 * The delete control is a GET form, not a POST. Clicking it navigates to
 * `?confirm=1` and re-renders this page with the confirmation at the top; it
 * cannot itself destroy anything. That is the whole trick: this app ships no
 * client JavaScript, so there is no `confirm()` to fall back on, and the only
 * safe first click is one that merely changes the URL.
 */
function SettingsPanel({ deck, deckId, base }: {
  deck: DeckRow; deckId: number; base: string;
}) {
  // `decks.format` is free TEXT (0004_decks.sql) and only the create form ever
  // constrains it, so a deck can hold a format this select does not list — a
  // row inserted by hand, or a value later dropped from DECK_FORMATS. Carried
  // as an extra option because otherwise the select renders showing
  // 'commander', and a rename that never touched the format would look like it
  // had changed one. (The action would keep the old value regardless:
  // parseFormat rejects it and renameDeck COALESCEs. This is about not lying.)
  const formats = (DECK_FORMATS as readonly string[]).includes(deck.format)
    ? [...DECK_FORMATS]
    : [deck.format, ...DECK_FORMATS];

  return (
    <div className="panel">
      <h2>Deck settings</h2>

      <form action={renameDeckAction} style={{ display: "grid", gap: "0.4rem" }}>
        <input type="hidden" name="deckId" value={deckId} />
        <input
          type="text"
          name="name"
          defaultValue={deck.name}
          required
          // Matches parseDeckName, which truncates rather than rejects — better
          // to stop the 121st character here than to silently drop it.
          maxLength={120}
          aria-label="Deck name"
          style={{ width: "100%", fontSize: 12 }}
        />
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <select
            className="mini"
            name="format"
            defaultValue={deck.format}
            aria-label="Format"
            style={{ flex: 1, minWidth: 0 }}
          >
            {formats.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <button className="mini" type="submit" title="save the name and format">rename</button>
        </div>
      </form>

      <div style={{ borderTop: "1px solid var(--bg2)", margin: "0.8rem 0 0.6rem" }} />

      <form method="get" action={base}>
        <input type="hidden" name="confirm" value="1" />
        <button
          className="mini danger"
          type="submit"
          style={{ borderColor: "var(--red)", color: "var(--red)" }}
          title="delete this deck — you get to confirm first"
        >
          delete deck…
        </button>
      </form>
      <p style={{ fontSize: 10, color: "var(--dim2)", margin: "0.4rem 0 0" }}>
        Deleting takes the deck and its cards. Your collection is a separate
        table and is not touched.
      </p>
    </div>
  );
}

/**
 * Step two of the delete, gated behind `?confirm=1`.
 *
 * The submit is only armed by typing the deck's name, checked server-side in
 * `deleteDeckAction` — not because a hidden token would be hard to forge, but
 * because the realistic accident is the right button on the wrong deck: a tab
 * left open on this URL, or a second window. A name has to match; a token
 * matches everywhere.
 */
function DeleteConfirm({ deckId, deck, cards, unresolved, err, base }: {
  deckId: number; deck: DeckRow; cards: number; unresolved: number; err: string; base: string;
}) {
  return (
    <Notice tone="bad" title={<>Delete “{deck.name}”?</>}>

      <p style={{ fontSize: 12, margin: "0 0 0.6rem" }}>
        This removes the deck and the <span className="stat">{cards}</span> card
        {cards === 1 ? "" : "s"} on its boards
        {unresolved > 0 ? (
          <>, plus {unresolved} row{unresolved === 1 ? "" : "s"} not currently in the mirror</>
        ) : null}
        . There is no undo.
      </p>

      {deck.is_public && deck.public_slug ? (
        <p style={{ fontSize: 12, color: "var(--orange)", margin: "0 0 0.6rem" }}>
          This deck is shared. <span style={{ color: "var(--fg0)" }}>/d/{deck.public_slug}</span>{" "}
          stops resolving the moment it goes, for everyone holding the link.
        </p>
      ) : null}

      {err === "name" ? (
        <p style={{ fontSize: 12, color: "var(--orange)", margin: "0 0 0.6rem" }}>
          That did not match, so nothing was deleted. Type the deck name exactly
          as it appears above.
        </p>
      ) : null}

      <form
        action={deleteDeckAction}
        style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}
      >
        <input type="hidden" name="deckId" value={deckId} />
        <input
          type="text"
          name="confirmName"
          required
          autoComplete="off"
          spellCheck={false}
          // Deliberately looser than the 120 parseDeckName enforces: a name that
          // predates that cap still has to be typeable in full.
          maxLength={200}
          placeholder={deck.name}
          aria-label={`Type the deck name ${deck.name} to confirm deletion`}
          style={{ fontSize: 12, minWidth: "14rem" }}
        />
        <button
          className="mini danger"
          type="submit"
          style={{ borderColor: "var(--red)", color: "var(--red)" }}
        >
          delete permanently
        </button>
        <Link href={base} style={{ fontSize: 11 }}>cancel</Link>
      </form>

      <p style={{ fontSize: 10, color: "var(--dim2)", margin: "0.5rem 0 0" }}>
        Type the deck name to confirm. Case and spacing are forgiven; the wrong
        deck is not.
      </p>
    </Notice>
  );
}

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

/** Result banner for a paste import. Reads the counts the action redirected with. */
function ImportSummary({ sp }: { sp: SearchParams }) {
  const added = one(sp.added);
  if (added === "") return null;
  const missed = Array.isArray(sp.missed) ? sp.missed : sp.missed ? [sp.missed] : [];
  const more = Number(one(sp.more) || 0);

  return (
    <Notice tone="good" title="Import">
      <div style={{ fontSize: 12 }}>
        Added <span className="stat">{added}</span> card{added === "1" ? "" : "s"} across{" "}
        <span className="stat">{one(sp.rows)}</span> row{one(sp.rows) === "1" ? "" : "s"}.
      </div>
      {missed.length > 0 ? (
        <div style={{ marginTop: "0.5rem" }}>
          <div style={{ fontSize: 12, color: "var(--orange)" }}>
            {missed.length + more} line{missed.length + more === 1 ? "" : "s"} could not be matched
            in the local mirror and were NOT added:
          </div>
          <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem", fontSize: 11, color: "var(--dim)" }}>
            {missed.map((m, i) => <li key={i}>{m}</li>)}
            {more > 0 ? <li>…and {more} more</li> : null}
          </ul>
        </div>
      ) : null}
    </Notice>
  );
}

/** Paste a decklist. Accepts bare names, `1x` forms, section headers and
 *  `(SET) number` — see lib/deck/decklist.ts. */
function PastePanel({ deckId }: { deckId: number }) {
  return (
    <div className="panel">
      <h2>Paste a list</h2>
      <form action={importDeckListAction}>
        <input type="hidden" name="deckId" value={deckId} />
        <textarea
          name="list"
          rows={7}
          placeholder={"1 Sol Ring\n1x Swords to Plowshares\n\nCommander\n1 Arahbo, Roar of the World"}
          style={{ width: "100%", resize: "vertical", fontSize: 11, lineHeight: 1.45 }}
          aria-label="Paste a decklist"
        />
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.4rem" }}>
          <span style={{ fontSize: 11, color: "var(--dim2)" }}>default board</span>
          <select className="mini" name="board" defaultValue="main" aria-label="Default board">
            {DECK_BOARDS.map((b) => <option key={b} value={b}>{BOARD_LABELS[b]}</option>)}
          </select>
          <button className="mini" type="submit">import</button>
        </div>
      </form>
      <p style={{ fontSize: 10, color: "var(--dim2)", margin: "0.5rem 0 0" }}>
        Section headers (Commander / Deck / Sideboard) switch board. Adds to what
        is already there rather than replacing it.
      </p>
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
