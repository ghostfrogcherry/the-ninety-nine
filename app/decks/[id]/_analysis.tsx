import type { validateCommanderDeck } from "@/lib/commander";
import type { DeckCardDetail } from "@/lib/deck";

/*
 * Read-only panels computed from what the page has already loaded. None of
 * them queries or posts anything, so none needs the deck id.
 */

/** Limited's one deck-construction rule: at least 40 cards, no maximum. */
export const LIMITED_MIN = 40;

/**
 * Stands in for the Commander panel on a 'limited' deck — a drafted pool saved
 * from /drafts. The count is the main board only: a limited sideboard is the
 * rest of your pool and does not count towards the 40.
 */
export function LimitedPanel({ mainCount }: { mainCount: number }) {
  const short = LIMITED_MIN - mainCount;
  return (
    <div className="panel">
      <h2>Limited</h2>
      {short <= 0 ? (
        <p className="legal-ok" style={{ margin: 0, fontSize: 12 }}>
          {mainCount} cards — at least {LIMITED_MIN}, so legal.
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--yellow)" }}>
          {mainCount} of {LIMITED_MIN} cards. Add {short} more — usually basic lands,
          which the search above finds with “all cards”.
        </p>
      )}
      <p style={{ fontSize: 10, color: "var(--dim2)", margin: "0.5rem 0 0" }}>
        Move the picks you are not playing to the sideboard; it does not count.
      </p>
    </div>
  );
}

export function LegalityPanel({ validation }: { validation: ReturnType<typeof validateCommanderDeck> }) {
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
export function CurvePanel({ cards }: { cards: DeckCardDetail[] }) {
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
