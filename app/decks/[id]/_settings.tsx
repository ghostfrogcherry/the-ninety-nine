import Link from "next/link";

import { Notice } from "@/app/_ui";
import { DECK_FORMATS, type DeckRow } from "@/lib/deck";
import {
  deleteDeckAction, renameDeckAction, shareDeckAction, unshareDeckAction,
} from "../_actions";

/*
 * Everything that acts on the deck itself rather than on a card in it: its
 * public link, its name and format, and deleting it. Both halves of the delete
 * live here together because each one's safety argument leans on the other.
 */

/**
 * Share toggle.
 *
 * "unshare" leaves the slug in place so re-sharing restores the same link a
 * friend may have bookmarked; "rotate" is the separate, explicit button for
 * when the point IS to kill the old URL.
 */
export function ShareControl({ deckId, isPublic, slug }: {
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
export function SettingsPanel({ deck, deckId, base }: {
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
export function DeleteConfirm({ deckId, deck, cards, unresolved, err, base }: {
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
