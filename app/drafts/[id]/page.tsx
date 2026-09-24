import { notFound, redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import { loadSeatState } from "@/lib/draft";
import { appBaseUrl } from "@/lib/auth/mail";
import { Shell } from "@/app/_ui";
import { Account } from "@/app/_account";
import { DraftErrorNotice, StatusBadge } from "../_parts";
import { parseId } from "@/lib/deck";
import { ERR_PARAM, inviteUrl, parseDraftError } from "../_form";
import { Lobby } from "./_lobby";
import { Pool } from "./_pool";
import { Table } from "./_table";

/**
 * One pod, from where the viewer sits: the lobby, the table, or the finished
 * pool. The three are separate files from the start — the deck page grew to
 * 560 lines as one file before it was split.
 *
 * Dynamic, never prerendered: every render is one person's seat at one moment,
 * and the engine reads the database on every call.
 */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function DraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const draftId = parseId((await params).id);
  if (draftId === null) notFound();

  const state = await loadSeatState(pool, draftId, userId);
  // Not in this pod and no such pod are the same 404, so pod ids cannot be
  // walked to find out which exist. The invite link is the way in.
  if (!state) notFound();

  const { draft } = state;
  const error = parseDraftError(one((await searchParams)[ERR_PARAM]));

  return (
    <Shell
      account={<Account />}
      title={draft.name}
      actions={<StatusBadge status={draft.status} />}
      subtitle={
        <>
          {draft.set_name} <span style={{ color: "var(--dim2)" }}>({draft.set_code.toUpperCase()})</span>
          {" · "}<span className="stat">{draft.seat_count}</span> seats
          {" · "}<span className="stat">{draft.pack_count}</span> pack{draft.pack_count === 1 ? "" : "s"} of{" "}
          <span className="stat">{draft.pack_size}</span>
        </>
      }
    >
      <DraftErrorNotice error={error} />

      {draft.status === "lobby" ? (
        <Lobby state={state} userId={userId} invite={inviteUrl(draft.join_slug, appBaseUrl())} />
      ) : draft.status === "drafting" && state.round < draft.pack_count ? (
        <Table state={state} />
      ) : (
        // Also the view for a seat that has made its last pick while friends
        // are still drafting: the engine reports round = pack_count, and the
        // pool is final — and saveable — from that moment.
        <Pool state={state} />
      )}
    </Shell>
  );
}
