import type { EmailConfig } from "@auth/core/providers/email";

import { normalizeIdentifier } from "@/lib/auth/normalize";

/**
 * Magic-link provider, built by hand instead of imported.
 *
 * TWO separate problems are being avoided here, and they are easy to conflate:
 *
 * 1. `next-auth/providers/nodemailer` does `import { createTransport } from
 *    "nodemailer"` at the TOP LEVEL of the module. `nodemailer` is an optional
 *    peer dependency and is NOT currently installed in this project. A static
 *    import would therefore fail at build/boot time — not at send time —
 *    whether or not the operator ever wants email.
 *
 * 2. This is self-hosted. Most installs will have no SMTP server at all.
 *    "Magic link is unavailable" must be a quiet no-op, not a crash.
 *
 * So: the provider is only constructed when SMTP env vars are present, and
 * `nodemailer` is pulled in with a dynamic import inside `sendVerificationRequest`
 * — the only place it is actually needed. The specifier is held in a variable so
 * neither TypeScript nor the bundler tries to resolve a module that may not
 * exist on disk.
 *
 * If you DO configure SMTP, `npm install nodemailer` first, or the first
 * magic-link attempt fails with the explicit error thrown below.
 */

/** Minimal shape we use from nodemailer. Declared locally; the package is optional. */
interface MailTransport {
  sendMail(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ rejected?: unknown[]; pending?: unknown[] }>;
}

interface SmtpServer {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

/**
 * Read SMTP settings from the environment.
 *
 * Two accepted forms:
 *   SMTP_URL=smtp://user:pass@host:587       (single connection string)
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
 *
 * Returns null — not a partial object — unless enough is present to actually
 * connect. A half-configured provider is worse than an absent one: sign-in
 * shows an email box that always errors.
 */
function readSmtpFromEnv(): { server: SmtpServer | string; from: string } | null {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) return null;

  const url = process.env.SMTP_URL?.trim();
  if (url) return { server: url, from };

  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isFinite(port) || port <= 0) return null;

  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;

  const server: SmtpServer = {
    host,
    port,
    // Implicit TLS is port 465. Everything else is STARTTLS, which nodemailer
    // negotiates on its own when `secure` is false.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
  };
  if (user && typeof pass === "string") server.auth = { user, pass };

  return { server, from };
}

/** Whether magic-link sign-in is available in this deployment. */
export function isEmailProviderConfigured(): boolean {
  return readSmtpFromEnv() !== null;
}

function plainTextBody(url: string, host: string): string {
  return `Sign in to ninetynine (${host})\n\n${url}\n\nIf you did not request this, ignore this email.\n`;
}

function htmlBody(url: string, host: string): string {
  return `<body style="font-family:system-ui,sans-serif;line-height:1.5">
  <p>Sign in to <strong>ninetynine</strong> (${host}).</p>
  <p><a href="${url}">Click here to sign in</a></p>
  <p style="color:#666;font-size:.9em">If you did not request this, ignore this email.</p>
</body>`;
}

/**
 * Build the provider, or return null when SMTP is not configured.
 *
 * `auth.ts` spreads the result into `providers` conditionally, so an
 * unconfigured install simply has one fewer provider — no error, no dead UI.
 */
export function createEmailProvider(): EmailConfig | null {
  const smtp = readSmtpFromEnv();
  if (!smtp) return null;

  return {
    // Keep Auth.js's own id so signIn("nodemailer") and the default UI agree.
    id: "nodemailer",
    name: "Email",
    type: "email",
    from: smtp.from,
    server: smtp.server as EmailConfig["server"],
    maxAge: 24 * 60 * 60, // link valid for 24h
    // Same lowercase rule as everything else, so the adapter's
    // `select * from users where email = $1` finds the row it should.
    normalizeIdentifier,
    options: {},

    async sendVerificationRequest({ identifier, url, provider }) {
      // Variable specifier on purpose — see the file header.
      const specifier = "nodemailer";
      let createTransport: (options: unknown) => MailTransport;
      try {
        ({ createTransport } = (await import(/* webpackIgnore: true */ specifier)) as {
          createTransport: (options: unknown) => MailTransport;
        });
      } catch {
        throw new Error(
          "Magic-link sign-in is configured (EMAIL_FROM/SMTP_* are set) but the " +
            "optional `nodemailer` package is not installed. Run `npm install nodemailer` " +
            "or unset EMAIL_FROM to disable magic links.",
        );
      }

      const { host } = new URL(url);
      const transport = createTransport(provider.server);
      const result = await transport.sendMail({
        to: identifier,
        from: provider.from ?? smtp.from,
        subject: `Sign in to ninetynine (${host})`,
        text: plainTextBody(url, host),
        html: htmlBody(url, host),
      });

      const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
      if (failed.length > 0) {
        throw new Error(`Sign-in email could not be delivered to ${failed.join(", ")}`);
      }
    },
  };
}
