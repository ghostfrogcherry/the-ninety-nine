import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { findDraftBySlug, isPlausibleJoinSlug, loadSeatState } from "@/lib/draft";
import { CALLBACK_PARAM } from "@/lib/auth/callback";
import { Shell } from "@/app/_ui";
import { Account } from "@/app/_account";
import { joinDraftAction } from "../../_actions";
import { DraftErrorNotice, StatusBadge } from "../../_parts";
import { ERR_PARAM, invitePath, parseDraftError } from "../../_form";

/**
 * The page an invite link opens.
 *
 * Behind the proxy like the rest of /drafts: the slug says which pod, but a
 * seat belongs to an account on this box. A signed-out friend is sent to
 * /signin with this path as the callbackUrl and comes back here afterwards —
 * via /signup too, if they have to make an account first.
 *
 * Showing the pod before joining, rather than joining on GET, is deliberate: a
 * GET that takes a seat can be triggered by any page that embeds the link as
 * an image, and a link preview bot unfurling it in a group chat would sit down
 * at the table.
 */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function JoinDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  // Malformed and unknown are one 404, checked before the database is asked.
  if (!isPlausibleJoinSlug(slug)) notFound();

  const userId = await currentUserId();
  // The proxy does this already; this is the belt to its braces, and it keeps
  // the way back to the invite.
  if (!userId) redirect(`/signin?${new URLSearchParams({ [CALLBACK_PARAM]: invitePath(slug) })}`);

  const draft = await findDraftBySlug(pool, slug);
  if (!draft) notFound();

  // The engine answers null for a pod you are not in, so a non-null state is
  // the membership test.
  const seated = (await loadSeatState(pool, draft.id, userId)) !== null;
  const error = parseDraftError(one((await searchParams)[ERR_PARAM]));

  return (
    <Shell account={<Account />} title="join a draft">
      <DraftErrorNotice error={error} />

      <div className="panel join-card">
        <div className="join-head">
          <h2 className="join-name">{draft.name}</h2>
          <StatusBadge status={draft.status} />
        </div>
        <dl className="facts">
          <dt>Set</dt><dd>{draft.set_name} <span className="dim">({draft.set_code.toUpperCase()})</span></dd>
          <dt>Table</dt><dd>{draft.seat_count} seats — empty ones become bots</dd>
          <dt>Packs</dt><dd>{draft.pack_count} × {draft.pack_size} cards</dd>
        </dl>

        {seated ? (
          <>
            <p className="panel-note">You already have a seat at this table.</p>
            <Link className="big-link" href={`/drafts/${draft.id}`}>go to the table →</Link>
          </>
        ) : draft.status !== "lobby" ? (
          <p className="panel-note" style={{ color: "var(--orange)" }}>
            This draft has already {draft.status === "done" ? "finished" : "started"}, so it
            cannot take new players. Ask for an invite to the next one.
          </p>
        ) : (
          <form action={joinDraftAction} className="start-row">
            <input type="hidden" name="slug" value={slug} />
            <button type="submit" className="big">Take a seat</button>
            <span className="draft-hint" style={{ margin: 0 }}>
              Then wait at the table: it starts when the host says so.
            </span>
          </form>
        )}
      </div>
    </Shell>
  );
}
