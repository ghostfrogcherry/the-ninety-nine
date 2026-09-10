import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import PostgresAdapter from "@auth/pg-adapter";
import type { Provider } from "next-auth/providers";

import { pool } from "@/lib/db";
import { authConfig } from "@/lib/auth/config";
import { createEmailProvider } from "@/lib/auth/email-provider";
import { verifyPassword } from "@/lib/auth/password";
import { credentialsSchema } from "@/lib/auth/schemas";
import { findUserByEmail } from "@/lib/auth/users";

/**
 * Auth.js v5 entry point. It pulls in `pg` and `bcryptjs`, so it belongs to
 * route handlers and server actions only. `proxy.ts` must import
 * `lib/auth/config` instead — nothing but that rule stops it now, since a
 * proxy file runs on Node and would import this one without complaint.
 *
 * v5 shape: `NextAuth(config)` returns `{ handlers, auth, signIn, signOut }`.
 * There is no `getServerSession`, no `NextAuthOptions`, and no default export
 * to hand to an API route — the route handler re-exports `handlers`.
 */

const emailProvider = createEmailProvider();

const providers: Provider[] = [
  Credentials({
    id: "credentials",
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },

    /**
     * Returning `null` is how a credential check FAILS in v5. Throwing is how
     * it *errors* — a thrown exception is reported to the user as a
     * configuration problem, not as a bad password, and is logged as a server
     * fault. Every rejection below is therefore a `return null`.
     */
    async authorize(rawCredentials) {
      const parsed = credentialsSchema.safeParse(rawCredentials);
      if (!parsed.success) return null; // malformed/missing input

      const { email, password } = parsed.data; // email already lowercased

      const user = await findUserByEmail(email);
      if (!user) {
        // Unknown address. Still pay the bcrypt cost so that "no such user"
        // and "wrong password" take the same wall-clock time.
        await verifyPassword(password, null);
        return null;
      }

      // password_hash IS NULL for magic-link-only users. verifyPassword
      // handles that case by returning false — it does not throw.
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return null;

      return {
        id: String(user.id), // SERIAL -> number -> string, once, here
        email: user.email,
        name: user.name,
        image: user.image,
      };
    },
  }),
];

// Magic link is entirely optional: no SMTP env, no provider, no crash.
if (emailProvider) providers.push(emailProvider);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // The adapter is what makes magic links work at all (it owns
  // verification_token) and it is what created `users` in 0001_auth.sql.
  // Sessions still come from the JWT — see the note in lib/auth/config.ts.
  adapter: PostgresAdapter(pool),
  providers,
});

export { isEmailProviderConfigured } from "@/lib/auth/email-provider";
