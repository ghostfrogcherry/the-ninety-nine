import type { DraftCardView, DraftError, DraftSeatView, DraftStatus } from "@/lib/draft";
import { Badge, Notice } from "@/app/_ui";
import { AutoRefresh } from "./[id]/_live";
import {
  DRAFT_ERROR_TEXT, groupPicks, manaSymbols, passesTo, pickCurve, pickGroup,
} from "./_form";

/*
 * Pieces more than one draft view draws: a card, a mana cost, the seats round
 * the table, the picks panel, and the live-refresh pair. Server components all;
 * the only client code they reach is AutoRefresh.
 */

export function StatusBadge({ status }: { status: DraftStatus }) {
  if (status === "lobby") return <Badge tone="warn">lobby</Badge>;
  if (status === "drafting") return <Badge tone="good">drafting</Badge>;
  return <Badge>done</Badge>;
}

/** The sentence for an `?err=` code the page recognised. Warn, not bad: every
 *  one of these is "that did not happen", never "something broke". */
export function DraftErrorNotice({ error }: { error: DraftError | null }) {
  if (!error) return null;
  return (
    <Notice tone="warn">
      <p className="notice-line">{DRAFT_ERROR_TEXT[error]}</p>
    </Notice>
  );
}

/**
 * Keeps a waiting page current.
 *
 * Both halves render, and only one ever acts: the <meta> refresh sits inside
 * <noscript>, which a browser running JavaScript treats as inert text, and
 * AutoRefresh is a client component that does nothing until it hydrates.
 * React 19 hoists a bare <meta> into <head> — where it would reload the page
 * even with JavaScript on — but leaves one inside <noscript> where it is.
 */
export function LiveRefresh({ seconds }: { seconds: number }) {
  return (
    <>
      <noscript>
        <meta httpEquiv="refresh" content={String(seconds)} />
      </noscript>
      <AutoRefresh intervalMs={seconds * 1000} />
    </>
  );
}

function pipClass(sym: string): string {
  if (/^[WUBRG]$/.test(sym)) return sym.toLowerCase();
  const colour = sym.match(/[WUBRG]/);
  return colour ? `${colour[0].toLowerCase()} hybrid` : "n";
}

/** `{2}{U}{U}` as pips. The printed text rides along for screen readers and
 *  for the tooltip; the pips themselves are decoration. */
export function ManaCost({ cost }: { cost: string | null }) {
  const syms = manaSymbols(cost);
  if (syms.length === 0) return null;
  return (
    <span className="mana" title={cost ?? undefined}>
      <span className="sr-only">{cost}</span>
      <span aria-hidden="true">
        {syms.map((s, i) =>
          s === "//" ? (
            <span key={i} className="mana-sep">/</span>
          ) : (
            <span key={i} className={`pip ${pipClass(s)}`}>{s.replace("/P", "ᵖ")}</span>
          ),
        )}
      </span>
    </span>
  );
}

/**
 * A card as the pack and the pool draw it: the image, or — when the mirror has
 * no image for it — a text frame with the name, cost and type, so a missing
 * image never leaves a blank, unpickable hole in the pack.
 */
export function CardFace({ card }: { card: DraftCardView }) {
  if (card.image) {
    return (
      <img
        src={card.image}
        // The button around it carries the accessible name; repeating it here
        // would make a screen reader announce every card twice.
        alt=""
        loading="lazy"
        decoding="async"
        width={146}
        height={204}
      />
    );
  }
  return (
    <span className={`card-text r-${card.rarity} g-${pickGroup(card)}`}>
      <span className="card-text-top">
        <span className="card-text-name">{card.name}</span>
        <ManaCost cost={card.mana_cost} />
      </span>
      {/* Where the art would be, tinted by colour, so a text card still reads
          as a card at a glance rather than as an empty box. */}
      <span className="card-text-art" aria-hidden="true" />
      <span className="card-text-type">{card.type_line}</span>
      <span className="card-text-rarity">{card.rarity}</span>
    </span>
  );
}

/**
 * The table, seat by seat, in passing order.
 *
 * Progress is picks this round (picks_made less the rounds before), because
 * that is what "who is holding things up" means at a real table. The seat you
 * are waiting on is marked, and the arrow between seats turns with the round.
 */
export function SeatRing({ seats, seatCount, mySeat, round, packSize, waitingOn, status }: {
  seats: DraftSeatView[];
  seatCount: number;
  mySeat: number | null;
  round: number;
  packSize: number;
  waitingOn: number | null;
  status: DraftStatus;
}) {
  const bySeat = new Map(seats.map((s) => [s.seat, s]));
  const left = seatCount > 1 && passesTo(0, round, seatCount) === 1;

  return (
    <ol className={`seat-ring s-${status} ${left ? "pass-left" : "pass-right"}`} aria-label="Seats around the table">
      {Array.from({ length: seatCount }, (_, i) => {
        const s = bySeat.get(i);
        const thisRound = s ? Math.max(0, Math.min(packSize, s.picks_made - round * packSize)) : 0;
        const pct = status === "done" ? 100 : Math.round((thisRound / packSize) * 100);
        const classes = [
          "seat",
          i === mySeat ? "me" : "",
          i === waitingOn ? "blocking" : "",
          s?.is_bot ? "bot" : "",
          s ? "" : "open",
        ].filter(Boolean).join(" ");
        return (
          <li key={i} className={classes}>
            <span className="seat-top">
              <span className="seat-no">{i + 1}</span>
              <span className="seat-name">{s ? s.label : "open seat"}</span>
              {i === mySeat ? <span className="seat-tag you">you</span> : null}
              {s?.is_bot ? <span className="seat-tag">bot</span> : null}
            </span>
            {status !== "lobby" && s ? (
              <>
                <span className="seat-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                <span className="seat-meta">
                  {status === "done" ? `${s.picks_made} picks` : `${thisRound}/${packSize} this pack`}
                  {i === waitingOn ? <span className="seat-wait"> · you’re waiting on them</span> : null}
                  {status === "done" && s.deck_id !== null ? <span className="seat-saved"> · saved</span> : null}
                </span>
              </>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Copies of one card as one row with a count, as a decklist writes them:
 *  three commons of the same name are "3× Anchor of Dread", not three lines.
 *  groupPicks sorts by mana value then name, so copies are already adjacent. */
function collapse(cards: DraftCardView[]): { card: DraftCardView; n: number }[] {
  const out: { card: DraftCardView; n: number }[] = [];
  for (const card of cards) {
    const last = out[out.length - 1];
    if (last && last.card.name === card.name) last.n += 1;
    else out.push({ card, n: 1 });
  }
  return out;
}

/**
 * What you have taken so far: a small curve, then the picks by colour and
 * mana value, with counts. On a pointer device hovering a name shows the card
 * — CSS only, and the preview image is lazy, so a panel of forty names does
 * not fetch forty images until someone actually looks.
 */
export function PicksPanel({ picks, title = "Your picks" }: { picks: DraftCardView[]; title?: string }) {
  const groups = groupPicks(picks);
  const curve = pickCurve(picks);
  const max = Math.max(1, ...curve);
  const nonland = curve.reduce((a, b) => a + b, 0);

  return (
    <div className="panel picks-panel">
      <h2>
        {title} <span className="count">{picks.length}</span>
      </h2>
      {picks.length === 0 ? (
        <p className="picks-empty">Nothing yet — your first pick lands here.</p>
      ) : (
        <>
          {nonland > 0 ? (
            <div className="picks-curve" aria-label="Mana curve of your nonland picks">
              <div className="curve">
                {curve.map((n, i) => (
                  <div
                    key={i}
                    className="bar"
                    style={{ height: `${(n / max) * 100}%` }}
                    title={`${n} at mana value ${i === 7 ? "7+" : i}`}
                  />
                ))}
              </div>
              <div className="curve-labels">
                {curve.map((_, i) => <span key={i}>{i === 7 ? "7+" : i}</span>)}
              </div>
            </div>
          ) : null}
          {groups.map((g) => (
            <section key={g.group} className={`pick-group g-${g.group}`}>
              <h3>
                <span className="pick-swatch" aria-hidden="true" />
                {g.label} <span className="count">{g.cards.length}</span>
              </h3>
              <ul>
                {collapse(g.cards).map(({ card: c, n }) => (
                  <li key={c.id} className="pick-row">
                    <span className="pick-name">
                      {n > 1 ? <span className="pick-n">{n}×</span> : null}
                      {c.name}
                    </span>
                    <ManaCost cost={c.mana_cost} />
                    {c.image ? (
                      <img className="pick-preview" src={c.image} alt="" loading="lazy" decoding="async" />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
