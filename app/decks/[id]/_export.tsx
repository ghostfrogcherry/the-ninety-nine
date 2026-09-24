import type { DeckCardDetail } from "@/lib/deck";
import { formatDeckText } from "@/lib/deck/export";

/**
 * The deck as a list another tool can read — chiefly untap.in, where a drafted
 * deck actually gets played.
 *
 * A readonly <textarea> rather than a "copy" button: selecting and copying
 * text needs no JavaScript, and this app ships none it can avoid. The download
 * is a plain <a> to the route beside this file, not a <Link>, because the
 * target is a file and the client router would try to render it as a page.
 */
export function ExportPanel({ cards, unresolved, base }: {
  cards: DeckCardDetail[]; unresolved: number; base: string;
}) {
  const text = formatDeckText(cards);
  const lines = text.split("\n").length;

  return (
    <div className="panel">
      <h2>Export</h2>
      <textarea
        readOnly
        value={text}
        rows={Math.min(12, Math.max(4, lines))}
        spellCheck={false}
        aria-label="Deck list as text"
        className="export-text"
      />
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.4rem" }}>
        <a className="mini" href={`${base}/export`} download>download .txt</a>
        <span style={{ fontSize: 11, color: "var(--dim2)" }}>
          Paste into untap.in → Decks → Import
        </span>
      </div>
      {unresolved > 0 ? (
        // Those rows have no name to write: the mirror is where names come from.
        <p style={{ fontSize: 11, color: "var(--orange)", margin: "0.5rem 0 0" }}>
          {unresolved} card{unresolved === 1 ? " is" : "s are"} not in the local mirror and
          {unresolved === 1 ? " is" : " are"} missing from this list.
        </p>
      ) : null}
      <p style={{ fontSize: 10, color: "var(--dim2)", margin: "0.5rem 0 0" }}>
        Arena/MTGO text: commander, deck and sideboard. The maybe-board is left out.
      </p>
    </div>
  );
}
