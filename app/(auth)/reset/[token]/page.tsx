import Link from "next/link";

import { completePasswordResetAction } from "@/lib/auth/actions";
import { pool } from "@/lib/db";
import { MAX_PASSWORD_BYTES } from "@/lib/auth/password";
import { RESET_TOKEN_TTL_MINUTES, findResetTokenUser } from "@/lib/auth/reset";
import { resetTokenSchema } from "@/lib/auth/schemas";
import { Field, Notice, buttonStyle, firstParam, readableError } from "../../_components";

export const metadata = { title: "Choose a new password · The Ninety Nine" };

export const dynamic = "force-dynamic";

/**
 * The page the emailed link opens: check the token, then offer the form.
 *
 * The check here is a READ. It does not spend the token, because mail clients
 * and corporate link scanners follow URLs on their own — a GET that consumed
 * would routinely burn the link before the user ever saw this page, and they
 * would be told it was already used by someone who was them. Spending happens
 * in the POST, in one statement, in `completePasswordReset`.
 *
 * Nothing on this page identifies the account. Not the address, not the name.
 * Whoever holds the link already knows whose mailbox it arrived in; anyone else
 * holding it must not learn whose it is.
 */
export default async function ResetCompletePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token: rawToken } = await params;
  const query = await searchParams;
  const error = firstParam(query, "error");

  // Shape-check before touching the database: `/reset/<anything>` is a public
  // URL, and a megabyte of junk in the path should not become a megabyte of
  // SHA-256 input and a query.
  const parsed = resetTokenSchema.safeParse({ token: rawToken });
  const userId = parsed.success ? await findResetTokenUser(pool, parsed.data.token) : null;

  if (!parsed.success || userId === null) {
    // Malformed, expired, already spent, never ours: one message for all four.
    return (
      <>
        <Notice tone="bad" title="Link no longer works">
          That reset link has expired, has already been used, or was replaced by a newer
          one. Reset links last {RESET_TOKEN_TTL_MINUTES} minutes and work once.
        </Notice>
        <p style={{ fontSize: ".875rem" }}>
          <Link href="/reset">Ask for a new link</Link> · <Link href="/signin">Sign in</Link>
        </p>
      </>
    );
  }

  return (
    <>
      {error ? <Notice tone="bad">{readableError(error)}</Notice> : null}

      <p style={{ fontSize: ".875rem", color: "var(--dim)", marginTop: 0 }}>
        Choose a new password. This link stops working as soon as you do.
      </p>

      <form action={completePasswordResetAction}>
        {/* The token rides in a hidden field AND is re-checked by the action:
            a hidden input is user input, and the check above was UI. */}
        <input type="hidden" name="token" value={parsed.data.token} />
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
        />
        <Field
          label="Confirm new password"
          name="confirm"
          type="password"
          autoComplete="new-password"
        />
        <button type="submit" style={buttonStyle}>
          Set new password
        </button>
      </form>

      <p style={{ marginTop: "1rem", fontSize: ".8125rem", color: "var(--dim2)" }}>
        At least 8 characters, at most {MAX_PASSWORD_BYTES} bytes — bcrypt ignores anything
        past that, so a longer passphrase would only be partly checked.
      </p>
    </>
  );
}
