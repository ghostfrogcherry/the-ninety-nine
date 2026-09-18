import type { EmailConfig } from "@auth/core/providers/email";

import { isMailConfigured, sendMail } from "@/lib/auth/mail";
import { signInEmail } from "@/lib/auth/messages";
import { normalizeIdentifier } from "@/lib/auth/normalize";

/**
 * Magic-link provider, built by hand instead of imported.
 *
 * `next-auth/providers/nodemailer` does `import { createTransport } from
 * "nodemailer"` at the TOP LEVEL of the module, so importing it puts a mail
 * library on the boot path of an install that may never send anything — and
 * makes "magic link is unavailable" a build-time fact rather than a
 * configuration one. This is self-hosted: most installs have no SMTP server,
 * and an absent provider must be a quiet no-op, not a crash.
 *
 * So the provider is constructed only when there is somewhere to send, and the
 * sending itself belongs to `lib/auth/mail.ts` — which password reset uses too,
 * so both features are configured by the same env and appear together.
 *
 * `server` is deliberately NOT set. It is optional in `EmailConfig`, Auth.js
 * never dials it itself (delivery is entirely `sendVerificationRequest`'s job),
 * and leaving it out is what lets the capture destination work: there is no
 * host to put there when the "transport" is a directory.
 */

/**
 * Whether magic-link sign-in is available in this deployment.
 *
 * Re-exported through `auth.ts` and read by the sign-in page, which hides the
 * magic-link form when it is false. Same answer as password reset's — one
 * mail configuration, both features.
 */
export function isEmailProviderConfigured(): boolean {
  return isMailConfigured();
}

/**
 * Build the provider, or return null when there is nowhere to send.
 *
 * `auth.ts` pushes the result into `providers` conditionally, so an
 * unconfigured install simply has one fewer provider — no error, no dead UI,
 * and `/api/auth/providers` lists only `credentials`.
 */
export function createEmailProvider(): EmailConfig | null {
  if (!isMailConfigured()) return null;

  return {
    // Keep Auth.js's own id so signIn("nodemailer") and the default UI agree.
    id: "nodemailer",
    name: "Email",
    type: "email",
    maxAge: 24 * 60 * 60, // link valid for 24h
    // Same lowercase rule as everything else, so the adapter's
    // `select * from users where email = $1` finds the row it should. Without
    // it a mixed-case address misses the row, falls through to createUser, and
    // dies on users_email_key — locking that account out permanently.
    normalizeIdentifier,
    options: {},

    async sendVerificationRequest({ identifier, url }) {
      await sendMail(signInEmail(identifier, url));
    },
  };
}
