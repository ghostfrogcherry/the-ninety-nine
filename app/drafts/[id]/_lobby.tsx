import type { DraftSeatState } from "@/lib/draft";
import { startDraftAction } from "../_actions";
import { LiveRefresh, SeatRing } from "../_parts";
import { passDirection } from "../_form";
import { CopyButton } from "./_live";

/*
 * Before the first pack: who has sat down, the invite, and the host's start
 * button. Bots are not shown yet — the engine fills empty seats only when the
 * draft starts, so the lobby lists exactly the people who have joined.
 */

export function Lobby({ state, userId, invite }: {
  state: DraftSeatState; userId: number; invite: string;
}) {
  const { draft, seats } = state;
  const isCreator = draft.created_by === userId;
  const host = seats.find((s) => s.user_id === draft.created_by)?.label ?? "the host";
  const people = seats.filter((s) => !s.is_bot).length;
  const bots = Math.max(0, draft.seat_count - people);

  return (
    <div className="draft-cols">
      <section>
        <h2 className="board-head">
          Seats <span className="count">{people}/{draft.seat_count} taken</span>
        </h2>
        <SeatRing
          seats={seats}
          seatCount={draft.seat_count}
          mySeat={state.my_seat}
          round={0}
          packSize={draft.pack_size}
          waitingOn={null}
          status="lobby"
        />
        <p className="draft-hint">
          Empty seats become bots when the draft starts. A bot picks the
          moment a pack reaches it, so it never keeps anyone waiting.
        </p>

        {isCreator ? (
          <form action={startDraftAction} className="start-row">
            <input type="hidden" name="draftId" value={draft.id} />
            <button type="submit" className="big">Start the draft</button>
            <span className="draft-hint" style={{ margin: 0 }}>
              {people} {people === 1 ? "person" : "people"}
              {bots > 0 ? <> and {bots} bot{bots === 1 ? "" : "s"}</> : null}.
              Nobody can join once it starts.
            </span>
          </form>
        ) : (
          <p className="waiting-line">
            <span className="pulse" aria-hidden="true" />
            Waiting for <b>{host}</b> to start the draft.
          </p>
        )}
        {/* Everyone polls in the lobby, the host included: the host is the one
            watching seats fill up. */}
        <LiveRefresh seconds={5} />
      </section>

      <aside className="draft-side">
        <div className="panel">
          <h2>Invite friends</h2>
          <div className="invite-row">
            <input
              className="invite-input"
              type="text"
              readOnly
              value={invite}
              aria-label="Invite link"
              spellCheck={false}
            />
            <CopyButton text={invite} />
          </div>
          <p className="panel-note">
            Send this link. Anyone with an account on this box can take a seat;
            a friend without one can make one at <b>/signup</b>, and the link
            brings them back here afterwards.
          </p>
        </div>

        <div className="panel">
          <h2>The draft</h2>
          <dl className="facts">
            <dt>Set</dt><dd>{draft.set_name} <span className="dim">({draft.set_code.toUpperCase()})</span></dd>
            <dt>Packs</dt><dd>{draft.pack_count} × {draft.pack_size} cards</dd>
            <dt>Passing</dt>
            <dd>
              {Array.from({ length: draft.pack_count }, (_, r) => passDirection(r)).join(", ")}
            </dd>
            <dt>Pool</dt><dd>{draft.pack_count * draft.pack_size} picks each</dd>
          </dl>
        </div>
      </aside>
    </div>
  );
}
