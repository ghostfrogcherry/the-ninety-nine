import NextAuth from "next-auth";

import { authConfig } from "@/lib/auth/config";

/**
 * Route protection.
 *
 * Built from `authConfig` ONLY — never from `auth.ts`. Middleware runs on the
 * Edge runtime, and `auth.ts` imports `pg` and `bcryptjs`, neither of which
 * loads there. Importing the wrong one fails at build time with an error that
 * points at node internals rather than at this line.
 *
 * With `session.strategy = "jwt"` the check is a cookie/JWT verification with
 * no database round-trip, which is what makes it viable in middleware at all.
 */
const { auth } = NextAuth(authConfig);

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
 * Because those paths never enter the middleware, no ordering bug or future
 * edit to the `authorized` callback can accidentally gate them. `:path*`
 * matches zero segments, so `/decks` itself is covered by `/decks/:path*`;
 * the bare entries are listed anyway rather than relying on that.
 */
export const config = {
  matcher: ["/collections", "/collections/:path*", "/decks", "/decks/:path*"],
};
