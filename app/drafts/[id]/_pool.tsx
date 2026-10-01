import Link from "next/link";

import type { DraftSeatState } from "@/lib/draft";
import { savePicksAction } from "../_actions";
import { CardFace, LiveRefresh, PicksPanel, SeatRing } from "../_parts";
import { groupPicks } from "../_form";

/*
 * After your last pick: your pool, and the way out of the draft — saving it
 * as a deck, which is where basics get added and the list gets exported to
 * untap.in.
 *
 * Two moments share this view. When the whole pod is done nothing here
 * changes by itself, so it does not poll. When only YOU are done — friends
 * still picking — the pool is already final and saveable (the engine allows a
 * save from your last pick on), and the seats above keep updating so you can
 * watch the others finish.
 */

export function Pool({ state }: { state: DraftSeatState }) {
  const { draft, picks } = state;
  const me = state.seats.find((s) => s.seat === state.my_seat) ?? null;
  const groups = groupPicks(picks);
  const othersPicking = draft.status === "drafting";
  const total = draft.pack_count * draft.pack_size;
  const unfinished = state.seats.filter((s) => s.picks_made < total).map((s) => s.label);

  return (
    <>
      {othersPicking ? (
        <div className="done-banner">
          <p className="waiting-line" style={{ margin: 0 }}>
            <span className="pulse" aria-hidden="true" />
            You’re done — {unfinished.length > 0
              ? <>still picking: <b>{unfinished.join(", ")}</b></>
              : <>the last picks are landing</>}
          </p>
          <p className="draft-hint" style={{ margin: "0.3rem 0 0" }}>
            Your pool is final. Save it now and start building, or watch the table finish.
          </p>
          <LiveRefresh seconds={5} />
        </div>
      ) : null}

      <SeatRing
        seats={state.seats}
        seatCount={draft.seat_count}
        mySeat={state.my_seat}
        round={draft.pack_count - 1}
        packSize={draft.pack_size}
        waitingOn={null}
        status={othersPicking ? "drafting" : "done"}
      />

      <div className="draft-cols">
        <section>
          {picks.length === 0 ? (
            <p className="empty">You took no cards in this draft.</p>
          ) : (
            groups.map((g) => (
              <div key={g.group}>
                <h2 className="board-head">
                  {g.label} <span className="count">{g.cards.length}</span>
                </h2>
                <div className="pack-grid pool">
                  {g.cards.map((c) => (
                    <figure key={c.id} className="pool-card" title={c.name}>
                      <CardFace card={c} />
                      <figcaption className="sr-only">{c.name}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>

        <aside className="draft-side save-first">
          <div className="panel save-panel">
            <h2>Your deck</h2>
            {me?.deck_id != null ? (
              <>
                <p className="panel-note" style={{ marginTop: 0 }}>
                  Saved. Add basic lands, trim to your forty, then export it to
                  untap.in from the deck page.
                </p>
                <Link className="big-link" href={`/decks/${me.deck_id}`}>open the deck →</Link>
              </>
            ) : picks.length > 0 ? (
              <form action={savePicksAction}>
                <input type="hidden" name="draftId" value={draft.id} />
                <p className="panel-note" style={{ marginTop: 0 }}>
                  Saves all {picks.length} picks as a new <b>limited</b> deck called
                  “{draft.name}”. Add basic lands there, move what you are not playing
                  to the sideboard, and export it to untap.in.
                </p>
                <button type="submit" className="big">Save as deck</button>
              </form>
            ) : (
              <p className="panel-note" style={{ margin: 0 }}>Nothing to save.</p>
            )}
          </div>
          <PicksPanel picks={picks} title="Your pool" />
        </aside>
      </div>
    </>
  );
}
