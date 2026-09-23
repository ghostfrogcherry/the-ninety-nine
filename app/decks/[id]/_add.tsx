import { BOARD_LABELS, DECK_BOARDS, type MirrorSearchRow } from "@/lib/deck";
import { Identity, Notice } from "@/app/_ui";
import { addCardAction, importDeckListAction } from "../_actions";

/*
 * Getting cards onto the deck: search the local mirror, or paste a list, and
 * the banner reporting what the last paste did.
 */

// The page has the same two lines. They are not imported from it because a
// page module may export only what Next reads as route config.
type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Result banner for a paste import. Reads the counts the action redirected with. */
export function ImportSummary({ sp }: { sp: SearchParams }) {
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
            in the local mirror and {missed.length + more === 1 ? "was" : "were"} NOT added:
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
export function PastePanel({ deckId }: { deckId: number }) {
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

export function AddPanel({ base, q, scope, results, deckId }: {
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
