import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe base config.
 *
 * `middleware.ts` runs in the Edge runtime, where `pg` and `bcryptjs` cannot
 * load. So the config is split: THIS file holds everything the middleware needs
 * (session strategy, cookie/JWT settings, pages, callbacks) and NOTHING that
 * touches Node APIs. `auth.ts` imports it and adds the adapter and the
 * providers, and is only ever imported from Node-runtime code.
 *
 * Both halves are initialised with the same AUTH_SECRET, so the JWT the
 * middleware reads is the one the route handlers wrote.
 */

export const PROTECTED_PREFIXES = ["/collections", "/decks"] as const;

/** Routes that must stay reachable signed-out. Public share links are v1. */
export const PUBLIC_PREFIXES = ["/d/", "/api/auth/", "/signin", "/signup"] as const;

export const authConfig = {
  /**
   * Empty on purpose, and required by the type.
   *
   * The middleware only ever VERIFIES an existing JWT — it never runs a
   * provider — so it needs none. `auth.ts` overrides this with the real list.
   * Listing the Credentials provider here would drag `bcryptjs` into the Edge
   * bundle for no benefit.
   */
  providers: [],

  /**
   * MUST be "jwt", and this is not a preference.
   *
   * The Credentials provider is incompatible with database sessions: Auth.js
   * refuses to persist a session for a user the adapter did not authenticate,
   * so with strategy "database" every credential sign-in succeeds and then
   * immediately presents as signed-out. Because `adapter` is set in `auth.ts`,
   * the default would flip to "database" — hence the explicit override.
   *
   * Consequence worth knowing: the `sessions` table in 0001_auth.sql stays
   * EMPTY. It is not dead schema (switching to OAuth-only later would use it),
   * but do not go looking there to debug a login.
   */
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },

  // AUTH_SECRET / AUTH_URL / AUTH_TRUST_HOST are read from the environment by
  // Auth.js itself; compose sets all three. Nothing to wire here.

  pages: {
    signIn: "/signin",
    // Send auth errors back to the sign-in form rather than Auth.js's default
    // error page, so a bad password looks like a form error, not a crash.
    error: "/signin",
    verifyRequest: "/signin?sent=1",
    newUser: "/collections",
  },

  callbacks: {
    /**
     * `users.id` is SERIAL, so the adapter yields a number while Auth.js's
     * `User.id` is typed `string`. Pin it to a string once, here, and every
     * consumer downstream sees the same type.
     */
    async jwt({ token, user }) {
      if (user?.id != null) token.id = String(user.id);
      return token;
    },

    async session({ session, token }) {
      if (session.user && typeof token.id === "string") session.user.id = token.id;
      return session;
    },

    /**
     * Consulted by `middleware.ts`. Kept here so the rule lives next to the
     * prefix lists rather than being duplicated.
     */
    authorized({ request, auth }) {
      const { pathname } = request.nextUrl;
      if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
      if (!PROTECTED_PREFIXES.some((prefix) => isUnder(pathname, prefix))) return true;
      return Boolean(auth?.user);
    },
  },
} satisfies NextAuthConfig;

/** `/decks` and `/decks/x` match; `/decksomething` does not. */
export function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
