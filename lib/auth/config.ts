import type { NextAuthConfig } from "next-auth";

/**
 * Proxy-safe base config.
 *
 * The config is split so `proxy.ts` can import THIS half — session strategy,
 * cookie/JWT settings, pages, callbacks — and nothing that reaches a database
 * or a password hash. `auth.ts` imports it and adds the adapter and the
 * providers, and belongs to route handlers and server actions only.
 *
 * That split used to enforce itself. As `middleware.ts` this ran on the Edge
 * runtime, which cannot load `pg` or `bcryptjs`, so importing `auth.ts` here
 * failed the build outright. A proxy file always runs on Node, so the same
 * mistake now compiles quietly and opens a Postgres pool in front of every
 * guarded request instead. The rule is unchanged; the thing that used to
 * catch you breaking it is gone, which is why it is written down here.
 *
 * Both halves are initialised with the same AUTH_SECRET, so the JWT the proxy
 * reads is the one the route handlers wrote.
 */

/**
 * Must name the same paths as the matcher in `proxy.ts`: a path the matcher
 * guards but this list omits reaches `authorized` and is waved through.
 * `/drafts` covers the pods, the table and the invite page alike — an invite
 * is not public the way a `/d/` share link is.
 */
export const PROTECTED_PREFIXES = ["/collections", "/decks", "/drafts"] as const;

/**
 * Routes that must stay reachable signed-out. Public share links are v1.
 *
 * `/reset` is here for the obvious reason — someone who cannot sign in is
 * exactly who needs it — and it is the one entry that is currently belt and
 * braces: `proxy.ts` guards an allow-list of paths that does not include it, so
 * a reset request never reaches this callback at all. Listed anyway, because
 * the guarded set is a matcher in another file and "nobody will ever add
 * `/:path*` to it" is not a property worth relying on.
 */
export const PUBLIC_PREFIXES = ["/d/", "/api/auth/", "/signin", "/signup", "/reset"] as const;

export const authConfig = {
  /**
   * Empty on purpose, and required by the type.
   *
   * The proxy only ever VERIFIES an existing JWT — it never runs a provider —
   * so it needs none. `auth.ts` overrides this with the real list. Listing the
   * Credentials provider here would drag `bcryptjs` into the bundle that fronts
   * every guarded request, for no benefit.
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
    /**
     * No query string here, and that is not a style choice. @auth/core builds
     * this redirect as `${pages.verifyRequest}${url.search}` — a bare
     * concatenation — and it always arrives with `?provider=…&type=email`
     * attached. `"/signin?sent=1"` therefore produced
     * `/signin?sent=1?provider=nodemailer&type=email`, in which `sent` parses
     * as `1?provider=nodemailer` and the "check your email" notice never
     * rendered. The first magic-link sign-in this project ever completed is
     * what found it.
     *
     * The page keys off the parameters Auth.js appends instead; `?sent=1` still
     * works for anything that links here by hand.
     */
    verifyRequest: "/signin",
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
     * Consulted by `proxy.ts`. Kept here so the rule lives next to the prefix
     * lists rather than being duplicated.
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
