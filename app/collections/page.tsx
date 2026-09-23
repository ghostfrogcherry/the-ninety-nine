import Link from "next/link";
import { redirect } from "next/navigation";

import { currentUserId } from "@/app/api/collections/access";
import { query } from "@/lib/db";
import { Badge, Empty, Shell, usd } from "@/app/_ui";
import { Account } from "@/app/_account";
import { createCollectionAction } from "./_actions";

export const dynamic = "force-dynamic";

interface Row extends Record<string, unknown> {
  id: number;
  name: string;
  is_public: boolean;
  distinct_printings: string | null;
  physical_cards: string | null;
  total_usd: string | null;
}

export default async function CollectionsPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  // LEFT JOIN the view, not an inner one: collection_values is built over
  // collection_cards, so a freshly-created empty collection has no row there
  // and would otherwise vanish from its owner's list.
  const rows = await query<Row>(
    `SELECT c.id, c.name, c.is_public,
            v.distinct_printings, v.physical_cards, v.total_usd
       FROM collections c
       LEFT JOIN collection_values v ON v.collection_id = c.id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC, c.id DESC`,
    [userId],
  );

  const totalCards = rows.reduce((s, r) => s + Number(r.physical_cards ?? 0), 0);

  return (
    <Shell
      account={<Account />}
      title="Collections"
      subtitle={
        rows.length
          ? `${rows.length} collection${rows.length === 1 ? "" : "s"} · ${totalCards} physical cards`
          : undefined
      }
    >
      {/* Creating a collection used to require scripts/import-collection.mjs
          --create, which made the browser import unreachable to anyone who had
          not already been to a terminal. */}
      <form action={createCollectionAction} className="filters" style={{ marginBottom: "1.5rem" }}>
        <fieldset style={{ marginBottom: 0 }}>
          <legend>New</legend>
          <input
            type="text"
            name="name"
            placeholder="collection name…"
            required
            maxLength={120}
            style={{ minWidth: "18rem" }}
            aria-label="Collection name"
          />
          {/* defaultChecked, not checked: uncontrolled server-rendered form. */}
          <label className="chip">
            <input type="checkbox" name="isPublic" defaultChecked={false} />
            <span>public</span>
          </label>
          <button type="submit">create</button>
        </fieldset>
      </form>

      {rows.length === 0 ? (
        <Empty>
          No collections yet — name one above, then upload or paste a Moxfield
          export into it.
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Printings</th>
              <th className="num">Cards</th>
              <th className="num">Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/collections/${r.id}`}>{r.name}</Link>
                </td>
                <td className="num">{r.distinct_printings ?? 0}</td>
                <td className="num">{r.physical_cards ?? 0}</td>
                <td className="num">{usd(r.total_usd)}</td>
                <td>{r.is_public ? <Badge tone="warn">public</Badge> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
