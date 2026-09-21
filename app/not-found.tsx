import Link from "next/link";

import { Notice, Shell } from "@/app/_ui";

/**
 * What `notFound()` renders.
 *
 * Every route that loads something by id calls `notFound()` for both "no such
 * row" and "not yours", deliberately, so a signed-in user cannot map which deck
 * and collection ids exist by watching the difference. That only holds if this
 * page says the same thing in both cases — naming the resource, or hinting that
 * it exists but belongs to someone else, would hand back exactly the signal the
 * 404 was hiding.
 */
export default function NotFound() {
  return (
    <Shell title="not found" subtitle="404">
      <Notice tone="warn" title="Nothing here">
        <p className="notice-line">
          That page does not exist, or it is not yours. Both look the same from
          here, on purpose.
        </p>
      </Notice>
      <p style={{ fontSize: 12 }}>
        <Link href="/collections">collections</Link>
        {" · "}
        <Link href="/decks">decks</Link>
      </p>
    </Shell>
  );
}
