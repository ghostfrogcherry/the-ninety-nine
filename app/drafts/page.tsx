import Link from "next/link";
import { redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { pool } from "@/lib/db";
import {
  DEFAULT_PACK_COUNT, DEFAULT_PACK_SIZE, MIN_DRAFTABLE_CARDS,
  PACK_COUNT_MAX, PACK_COUNT_MIN, PACK_SIZE_MAX, PACK_SIZE_MIN, SEAT_COUNT_MAX, SEAT_COUNT_MIN,
  listDraftableSets, listMyDrafts, type DraftSetOption,
} from "@/lib/draft";
import { Empty, Shell } from "@/app/_ui";
import { Account } from "@/app/_account";
import { createDraftAction } from "./_actions";
import { DraftErrorNotice, StatusBadge } from "./_parts";
import { DEFAULT_SEATS, DRAFT_NAME_MAX, ERR_PARAM, parseDraftError, parseSetSearch } from "./_form";

/**
 * Your pods, and a form to start one.
 *
 * The set list is filtered by a GET form above the create form rather than by
 * a type-ahead: a real mirror has several hundred draftable sets, a <select>
 * of all of them is a long scroll on a phone, and a `?q=` in the URL narrows it
 * with no JavaScript at all.
 */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

function setLabel(s: DraftSetOption): string {
  // Through Date rather than slicing the string: `pg` hands a DATE column back
  // as a Date object unless the query casts it, and the contract's `string`
  // would not survive an engine that forgot the cast.
  const released = s.released_at ? new Date(s.released_at) : null;
  const year = released && !Number.isNaN(released.getTime()) ? ` · ${released.getUTCFullYear()}` : "";
  // A set whose rows predate migration 0008 has no booster flag yet, so its
  // packs would be drawn from every printing — worth saying in the picker.
  const caveat = s.booster_known ? "" : " · all printings";
  return `${s.set_name} (${s.set_code.toUpperCase()})${year} · ${s.card_count} cards${caveat}`;
}

export default async function DraftsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const sp = await searchParams;
  const q = parseSetSearch(one(sp.q));
  const error = parseDraftError(one(sp[ERR_PARAM]));

  const [pods, sets] = await Promise.all([
    listMyDrafts(pool, userId),
    listDraftableSets(pool, q || undefined),
  ]);
  // A filter that matches nothing is not the same as a mirror with nothing
  // draftable in it, and the two need different advice.
  const anySets = q ? sets.length > 0 || (await listDraftableSets(pool)).length > 0 : sets.length > 0;

  return (
    <Shell
      account={<Account />}
      title="drafts"
      subtitle={
        pods.length
          ? `${pods.length} pod${pods.length === 1 ? "" : "s"} · booster draft with friends and bots`
          : "booster draft with friends and bots"
      }
    >
      <DraftErrorNotice error={error} />

      <div className="draft-cols">
        <section>
          <h2 className="board-head">Your pods <span className="count">{pods.length}</span></h2>
          {pods.length === 0 ? (
            <Empty>
              No pods yet. Start one on the right, then send the invite link to
              whoever is playing.
            </Empty>
          ) : (
            <ul className="pod-list">
              {pods.map((p) => (
                <li key={p.id}>
                  <Link href={`/drafts/${p.id}`} className="pod">
                    <span className="pod-name">{p.name}</span>
                    <StatusBadge status={p.status} />
                    <span className="pod-meta">
                      {p.set_name} <span className="dim">({p.set_code.toUpperCase()})</span>
                      {" · "}{p.seat_count} seats · {p.pack_count}×{p.pack_size}
                      {p.created_by === userId ? " · you host" : ""}
                      {" · "}{DATE.format(new Date(p.created_at))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="draft-side">
          <div className="panel">
            <h2>New pod</h2>

            {!anySets ? (
              <div className="panel-note" style={{ marginTop: 0 }}>
                <p style={{ marginTop: 0 }}>
                  No set in the local card mirror can be drafted yet. A set needs at
                  least {MIN_DRAFTABLE_CARDS} different cards that appear in boosters, and the demo
                  mirror from <code>seed-demo</code> has only a handful of cards.
                </p>
                <p style={{ marginBottom: 0 }}>
                  Load the real mirror once:{" "}
                  <code>docker compose --profile refresh run --rm scryfall-refresh --force</code>
                </p>
              </div>
            ) : (
              <>
                {/* Step one, a GET: narrow the set list. Its own form, so
                    filtering never submits — and never creates — a pod. */}
                <form method="get" action="/drafts" className="set-filter">
                  <input
                    type="search"
                    name="q"
                    defaultValue={q}
                    placeholder="set name or code…"
                    aria-label="Filter sets"
                    maxLength={60}
                  />
                  <button className="mini" type="submit">filter</button>
                  {q ? <Link className="mini-link" href="/drafts">clear</Link> : null}
                </form>

                {sets.length === 0 ? (
                  <p className="panel-note">No draftable set matches “{q}”.</p>
                ) : (
                  <form action={createDraftAction} className="create-pod">
                    <input type="hidden" name="q" value={q} />
                    <label>
                      <span>Set</span>
                      <select name="set" required defaultValue={sets[0].set_code}>
                        {sets.map((s) => (
                          <option key={s.set_code} value={s.set_code}>{setLabel(s)}</option>
                        ))}
                      </select>
                    </label>
                    {q ? null : (
                      <span className="field-note">{sets.length} set{sets.length === 1 ? "" : "s"}, newest first</span>
                    )}

                    <label>
                      <span>Name</span>
                      <input
                        type="text"
                        name="name"
                        maxLength={DRAFT_NAME_MAX}
                        placeholder="Friday night draft"
                        autoComplete="off"
                      />
                    </label>

                    <label>
                      <span>Seats</span>
                      <select name="seats" defaultValue={String(DEFAULT_SEATS)}>
                        {Array.from({ length: SEAT_COUNT_MAX - SEAT_COUNT_MIN + 1 }, (_, i) => SEAT_COUNT_MIN + i).map((n) => (
                          <option key={n} value={n}>{n} seats</option>
                        ))}
                      </select>
                    </label>
                    <span className="field-note">Seats nobody takes are filled with bots.</span>

                    {/* <details> so the defaults stay out of the way and the
                        form still folds with JavaScript off. */}
                    <details className="advanced">
                      <summary>Advanced</summary>
                      <div className="advanced-grid">
                        <label>
                          <span>Cards per pack</span>
                          <input
                            type="number"
                            name="packSize"
                            min={PACK_SIZE_MIN}
                            max={PACK_SIZE_MAX}
                            placeholder={String(DEFAULT_PACK_SIZE)}
                          />
                        </label>
                        <label>
                          <span>Packs each</span>
                          <input
                            type="number"
                            name="packCount"
                            min={PACK_COUNT_MIN}
                            max={PACK_COUNT_MAX}
                            placeholder={String(DEFAULT_PACK_COUNT)}
                          />
                        </label>
                      </div>
                    </details>

                    <button type="submit" className="big">Create pod</button>
                  </form>
                )}
              </>
            )}
          </div>

          <p className="panel-note side-note">
            Everyone at the table needs an account here. When the last pick is made,
            each player saves their pool as a deck and can export it to untap.in.
          </p>
        </aside>
      </div>
    </Shell>
  );
}
