import Link from "next/link";

import { requestPasswordReset } from "@/lib/auth/actions";
import { isMailConfigured } from "@/lib/auth/mail";
import { RESET_TOKEN_TTL_MINUTES } from "@/lib/auth/reset";
import { Field, Notice, buttonStyle, firstParam, readableError } from "../_components";

export const metadata = { title: "Reset password · The Ninety Nine" };

/**
 * "Email me a reset link."
 *
 * Note what is NOT here: any redirect for a signed-in visitor, unlike /signin
 * and /signup. A session says the browser holds a valid JWT, not that the
 * person remembers their password — someone still signed in on their phone is
 * a completely ordinary person to want a reset link.
 *
 * The pool is opened on import, so this page must not be prerendered at build
 * time — the Dockerfile builds with a placeholder DATABASE_URL pointing at
 * nothing.
 */
export const dynamic = "force-dynamic";

export default async function ResetRequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = firstParam(params, "error");
  const sent = firstParam(params, "sent") === "1";
  const expired = firstParam(params, "expired") === "1";
  const mailConfigured = isMailConfigured();

  return (
    <>
      {error ? <Notice tone="bad">{readableError(error)}</Notice> : null}

      {expired ? (
        <Notice tone="bad" title="Link no longer works">
          That reset link has expired, has already been used, or was replaced by a newer
          one. Ask for another below.
        </Notice>
      ) : null}

      {sent ? (
        /**
         * Says "if", and means it. This page renders identically whether the
         * address exists, does not exist, or exists and the mail bounced —
         * anything else turns the form into a way to test which of the
         * household is registered here.
         */
        <Notice tone="good" title="Check your email">
          If that address has an account, a reset link is on its way. It expires in{" "}
          {RESET_TOKEN_TTL_MINUTES} minutes and can be used once.
        </Notice>
      ) : null}

      {mailConfigured ? (
        <>
          <p style={{ fontSize: ".875rem", color: "var(--dim)", marginTop: 0 }}>
            Enter the address you sign in with and we will email you a link to choose a new
            password.
          </p>

          <form action={requestPasswordReset}>
            <Field label="Email" name="email" type="email" autoComplete="username" />
            <button type="submit" style={buttonStyle}>
              Email me a reset link
            </button>
          </form>
        </>
      ) : (
        /**
         * No mail configured means no way to prove ownership of the mailbox,
         * so there is no reset to offer — and saying so beats a form that
         * accepts an address and silently does nothing. The shell command is
         * the honest alternative and it is what the README documents.
         */
        <Notice tone="warn" title="No mail configured">
          This server has no mail destination set (EMAIL_FROM plus either SMTP_* or
          MAIL_CAPTURE_DIR), so it cannot send a reset link. Whoever runs it can set a
          password directly:
          <pre style={{ margin: ".6rem 0 0", color: "var(--fg2)", overflowX: "auto" }}>
            docker compose exec app node scripts/set-password.mjs you@example.com
          </pre>
        </Notice>
      )}

      <p style={{ marginTop: "1.5rem", fontSize: ".875rem" }}>
        <Link href="/signin">Back to sign in</Link>
      </p>
    </>
  );
}
