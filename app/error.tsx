"use client";

import Link from "next/link";

import { Notice, Shell } from "@/app/_ui";

/**
 * The error boundary for everything under the root layout.
 *
 * `"use client"` is not a preference here and is not a crack in the no-client-JS
 * rule the rest of the app keeps: React error boundaries are a client-component
 * feature, and Next will not accept a server component in this file. The `reset`
 * button is the reason it has to be one — it re-runs the failed render without a
 * full page load, which is worth having when the failure was a dropped database
 * connection and the next attempt would succeed.
 *
 * What it must NOT do is show `error.message`. Next scrubs that to a generic
 * string in production builds, but a development build hands over the real
 * message, and ours are database errors — table names, column names, sometimes
 * a fragment of the failing query. Printing it would leak schema into the
 * browser of whoever tripped it, and nothing about that helps a household user
 * decide what to do next. `digest` is the safe half: a hash Next also writes to
 * the server log, so a person can quote it and someone with shell access can
 * find the real error.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Shell title="something broke" subtitle="500">
      <Notice tone="bad" title="That did not work">
        <p className="notice-line">
          The page failed to render. Nothing you were looking at was changed by
          the failure itself, though an action that was mid-flight may or may not
          have completed — reload the list to see where things stand.
        </p>
      </Notice>

      <p style={{ fontSize: 12 }}>
        <button type="button" className="mini" onClick={reset}>try again</button>
        {" · "}
        <Link href="/collections">collections</Link>
        {" · "}
        <Link href="/decks">decks</Link>
      </p>

      {error.digest ? (
        <p style={{ fontSize: 12, color: "var(--dim2)" }}>
          Reference <code>{error.digest}</code>. The matching error is in the
          app container&rsquo;s log: <code>docker compose logs app</code>.
        </p>
      ) : null}
    </Shell>
  );
}
