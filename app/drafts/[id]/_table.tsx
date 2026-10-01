import type { DraftSeatState } from "@/lib/draft";
import { pickAction } from "../_actions";
import { CardFace, LiveRefresh, PicksPanel, SeatRing } from "../_parts";
import { passDirection } from "../_form";
import { PickButton } from "./_live";

/*
 * Mid-draft: the pack in front of you, or who you are waiting on, with the
 * table and your picks beside it.
 *
 * Every card is its own tiny <form> with one submit button wrapping the image.
 * That is the whole pick UI — no selection state, no "confirm pick" step, and
 * nothing that needs JavaScript. The draft id and the card id are posted as
 * plain fields; pickAction and the engine re-check both against the seat that
 * is actually signed in, so editing them picks nothing that is not yours.
 */

export function Table({ state }: { state: DraftSeatState }) {
  const { draft, pack, waiting_on, picks } = state;
  const direction = passDirection(state.round);

  return (
    <>
      <div className="draft-head">
        <h2 className="draft-pick">
          Pack <b>{state.round + 1}</b><span className="of">/{draft.pack_count}</span>
          <span className="sep">·</span>
          Pick <b>{state.pick + 1}</b><span className="of">/{draft.pack_size}</span>
        </h2>
        <span className={`draft-dir ${direction}`}>
          passing {direction} <span aria-hidden="true">{direction === "left" ? "→" : "←"}</span>
        </span>
        {pack && pack.length > 0 ? (
          // In the header row rather than above the grid, so the pack and the
          // picks panel beside it start on the same line.
          <span className="draft-left">
            {pack.length} card{pack.length === 1 ? "" : "s"} left — click one to take it
          </span>
        ) : null}
        <a className="picks-jump" href="#picks">your picks ({picks.length}) ↓</a>
      </div>

      <SeatRing
        seats={state.seats}
        seatCount={draft.seat_count}
        mySeat={state.my_seat}
        round={state.round}
        packSize={draft.pack_size}
        waitingOn={waiting_on?.seat ?? null}
        status="drafting"
      />

      <div className="draft-cols">
        <section aria-live="polite">
          {pack && pack.length > 0 ? (
            <>
              {/* Keyed by position, so each new pack mounts fresh and its
                  fade-in plays; the same pack re-rendered by a refresh keeps
                  its key and does not flicker. */}
              <div className="pack-grid" key={`${state.round}-${state.pick}`}>
                {pack.map((card) => (
                  <form key={card.id} action={pickAction}>
                    <input type="hidden" name="draftId" value={draft.id} />
                    <input type="hidden" name="draftCardId" value={card.id} />
                    <PickButton label={`Pick ${card.name}`}>
                      <CardFace card={card} />
                    </PickButton>
                  </form>
                ))}
              </div>
            </>
          ) : (
            <div className="waiting-panel">
              <p className="waiting-line">
                <span className="pulse" aria-hidden="true" />
                {waiting_on ? (
                  <>Waiting for <b>{waiting_on.label}</b> to pass</>
                ) : (
                  <>Waiting for the next pack</>
                )}
              </p>
              <p className="draft-hint" style={{ margin: 0 }}>
                Your next pack is still in someone else’s hands. This page
                updates by itself when it reaches you.
              </p>
              <div className="ghost-pack" aria-hidden="true">
                {Array.from({ length: Math.min(5, Math.max(1, draft.pack_size - state.pick)) }, (_, i) => (
                  <span key={i} className="ghost-card" />
                ))}
              </div>
              <LiveRefresh seconds={3} />
            </div>
          )}
        </section>

        <aside className="draft-side" id="picks">
          <PicksPanel picks={picks} />
        </aside>
      </div>
    </>
  );
}
