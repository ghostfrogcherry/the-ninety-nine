import NextAuth from "next-auth";

import { authConfig } from "@/lib/auth/config";

/**
 * Route protection.
 *
 * The file is called `proxy.ts`, not `middleware.ts`: Next 16 deprecated that
 * filename and warns on every build. Keeping both around is not a middle
 * ground — the build fails outright (E900) if it finds `middleware.ts` and
 * `proxy.ts` together. Nothing else about the convention moved; the matcher
 * below is parsed by exactly the same code under either name.
 *
 * Built from `authConfig` ONLY — never from `auth.ts`, which imports `pg` and
 * `bcryptjs`. As middleware that rule enforced itself: the Edge runtime could
 * not load either package, so the wrong import failed the build with an error
 * pointing at node internals rather than at the import line. A proxy file
 * always runs on the Node runtime instead — `export const runtime` here is
 * itself a build error (E1031) — so the wrong import now compiles quietly and
 * opens a Postgres pool in front of every guarded request. Same rule; the
 * thing that used to enforce it is gone.
 *
 * With `session.strategy = "jwt"` the check is a cookie/JWT verification with
 * no database round-trip, which is what makes it cheap enough to run here.
 */
const { auth } = NextAuth(authConfig);

/** Next runs the default export, or a named `proxy` export. This is the former. */
export default auth;

/**
 * The matcher is the real security boundary here, and it is an ALLOW-list of
 * things to guard rather than a deny-list of things to skip.
 *
 * Guarded:   /collections, /decks and everything beneath them.
 * Untouched: /d/:slug   — public deck share links are a v1 feature. They are
 *                         not "forgotten", they are deliberately anonymous.
 *            /api/auth/* — sign-in itself cannot require being signed in.
 *            /signin, /signup, /, static assets.
 *
 * Because those paths never enter the proxy, no ordering bug or future edit to
 * the `authorized` callback can accidentally gate them. `:path*` matches zero
 * segments, so `/decks` itself is covered by `/decks/:path*`; the bare entries
 * are listed anyway rather than relying on that.
 */
export const config = {
  matcher: ["/collections", "/collections/:path*", "/decks", "/decks/:path*"],
};
