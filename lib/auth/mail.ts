import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Outbound mail — the one place that decides where a message actually goes.
 *
 * Two features need to send: the magic-link provider (`email-provider.ts`) and
 * password reset (`actions.ts`). They used to have one and a half transports
 * between them, because the provider built its own nodemailer transport inside
 * `sendVerificationRequest`. Anything that needs to send now calls `sendMail`,
 * so "is mail configured" has exactly one answer and both features appear and
 * disappear together.
 *
 * Two destinations:
 *
 *   SMTP     EMAIL_FROM + SMTP_URL, or EMAIL_FROM + SMTP_HOST/PORT/USER/PASS.
 *            The real thing.
 *
 *   capture  EMAIL_FROM + MAIL_CAPTURE_DIR. Every message is written to that
 *            directory as an .eml file and nothing is dialled. This exists
 *            because magic-link sign-in had never once been exercised on this
 *            project: with no SMTP server there was no provider, with no
 *            provider there was no form, and a household running on a NAS is
 *            not going to stand up Postfix to find out whether the flow works.
 *            Point MAIL_CAPTURE_DIR at a folder, click the link in the file.
 *
 * Neither is a default. With EMAIL_FROM unset there is no destination, the
 * magic-link provider is never constructed, `/api/auth/providers` lists only
 * `credentials`, and the reset page says so instead of pretending to send. A
 * half-configured mailer is worse than none: it offers a link that silently
 * never arrives.
 *
 * Dependency-free apart from node builtins (nodemailer is reached by a dynamic
 * import, below), so a test can load this module directly under
 * `node --test` and send into a capture directory or at a local listener.
 */

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface SmtpServer {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

export type MailDestination =
  | { kind: "smtp"; from: string; server: SmtpServer | string }
  | { kind: "capture"; from: string; dir: string };

/** Minimal shape we use from nodemailer. Declared locally; see `sendOverSmtp`. */
interface MailTransport {
  sendMail(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ rejected?: unknown[]; pending?: unknown[] }>;
}

/**
 * Read SMTP settings from the environment.
 *
 * Two accepted forms:
 *   SMTP_URL=smtp://user:pass@host:587       (single connection string)
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
 *
 * Returns null — not a partial object — unless enough is present to actually
 * connect.
 */
function readSmtpFromEnv(from: string): MailDestination | null {
  const url = process.env.SMTP_URL?.trim();
  if (url) return { kind: "smtp", from, server: url };

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

  return { kind: "smtp", from, server };
}

/**
 * Where mail goes, or null when the operator has configured nowhere.
 *
 * SMTP wins when both are set, so leaving MAIL_CAPTURE_DIR in a .env that later
 * gains a real SMTP host cannot quietly swallow the household's sign-in mail.
 */
export function mailDestination(): MailDestination | null {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) return null;

  const smtp = readSmtpFromEnv(from);
  if (smtp) return smtp;

  const dir = process.env.MAIL_CAPTURE_DIR?.trim();
  if (dir) return { kind: "capture", from, dir };

  return null;
}

/** Whether anything can be sent at all. Drives both the provider and the UI. */
export function isMailConfigured(): boolean {
  return mailDestination() !== null;
}

/**
 * The base URL links in mail are built from.
 *
 * AUTH_URL, never the incoming request's Host header. A reset link is a bearer
 * credential and the Host header is attacker-controlled: a request with
 * `Host: evil.example` would otherwise mail *the real user* a link pointing at
 * the attacker's box, and the user clicking it hands over the token. Auth.js
 * already requires AUTH_URL for its own callbacks, so this asks for nothing new
 * — and returning null when it is unset is deliberate: no link is far better
 * than a link to the wrong origin.
 */
export function appBaseUrl(): string | null {
  const raw = process.env.AUTH_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // Trailing slash stripped once, here, so callers can always concatenate.
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/**
 * RFC 5322 on disk: headers, blank line, multipart/alternative body.
 *
 * CRLF and a real MIME structure rather than a convenient text dump, so the
 * file opens in a mail client as the recipient would see it — the point of the
 * capture mode is to exercise the actual message, not a paraphrase of it.
 */
function toEml(mail: OutboundMail, from: string): string {
  const boundary = `nn-${randomUUID()}`;
  return [
    `Date: ${new Date().toUTCString()}`,
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    mail.text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    mail.html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function captureToDisk(mail: OutboundMail, dest: { from: string; dir: string }): Promise<string> {
  await mkdir(dest.dir, { recursive: true });
  // Sortable prefix so `ls` is newest-last, plus a uuid because two magic-link
  // requests in the same millisecond are exactly what a nervous first test does.
  const file = path.join(dest.dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.eml`);
  await writeFile(file, toEml(mail, dest.from), "utf8");

  // The PATH, never the body. The body holds a link that signs someone in, and
  // container logs are the one place a secret is guaranteed to be read by
  // people who were not sent it.
  console.log(`[mail] captured to ${file}`);
  return file;
}

async function sendOverSmtp(
  mail: OutboundMail,
  dest: { from: string; server: SmtpServer | string },
): Promise<void> {
  /**
   * nodemailer is a real dependency (pinned to 8.x, which is what Auth.js
   * peer-accepts) but it is still reached through a dynamic import held in a
   * variable. Two reasons, and neither is superstition:
   *
   *   - `next-auth/providers/nodemailer` imports it at module top level, which
   *     is why this project hand-builds the provider instead; importing it
   *     here at top level would put the same package on the boot path of every
   *     install, including the majority that send no mail at all.
   *   - The specifier is a variable so the bundler does not try to resolve it,
   *     which keeps `pg`-style native-ish deps out of the traced build for an
   *     install that has pruned it.
   *
   * If the package is genuinely missing the throw below says exactly that,
   * rather than surfacing as a 500 from deep inside the provider.
   */
  const specifier = "nodemailer";
  let createTransport: (options: unknown) => MailTransport;
  try {
    ({ createTransport } = (await import(/* webpackIgnore: true */ specifier)) as {
      createTransport: (options: unknown) => MailTransport;
    });
  } catch {
    throw new Error(
      "Mail is configured (EMAIL_FROM/SMTP_* are set) but the `nodemailer` package " +
        "is not installed. Run `npm install nodemailer`, or set MAIL_CAPTURE_DIR " +
        "instead to write messages to disk, or unset EMAIL_FROM to disable mail.",
    );
  }

  const transport = createTransport(dest.server);
  const result = await transport.sendMail({ ...mail, from: dest.from });

  // A message the server accepted "for later" is not a message that arrived.
  // Both lists are failures as far as the caller is concerned.
  const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
  if (failed.length > 0) {
    throw new Error(`mail could not be delivered to ${failed.join(", ")}`);
  }
}

/**
 * Send one message.
 *
 * Throws when mail is not configured rather than returning quietly: every
 * caller has already checked `isMailConfigured()` to decide whether to offer
 * the feature, so reaching here with nowhere to send is a bug, not a state.
 */
export async function sendMail(mail: OutboundMail): Promise<void> {
  const dest = mailDestination();
  if (!dest) throw new Error("no mail destination configured (set EMAIL_FROM and SMTP_* or MAIL_CAPTURE_DIR)");

  if (dest.kind === "capture") {
    await captureToDisk(mail, dest);
    return;
  }
  await sendOverSmtp(mail, dest);
}
