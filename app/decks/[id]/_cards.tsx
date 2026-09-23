import type { DeckBoard } from "@/lib/commander";
import { BOARD_LABELS, DECK_BOARDS, type DeckCardDetail } from "@/lib/deck";
import { Badge, Identity, usd } from "@/app/_ui";
import { moveCardAction, removeCardAction, setQuantityAction } from "../_actions";

export function CardLine({ card, deckId, board }: {
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
