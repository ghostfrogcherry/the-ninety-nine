import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isEmailProviderConfigured } from "@/auth";
import { signInWithCredentials, signInWithMagicLink } from "@/lib/auth/actions";
import {
  Field,
  Notice,
  buttonStyle,
  firstParam,
  readableError,
  secondaryButtonStyle,
} from "../_components";

export const metadata = { title: "Sign in · The Ninety Nine" };

/**
 * The pool is opened on import, so this page must not be prerendered at build
 * time — the Dockerfile builds with a placeholder DATABASE_URL pointing at
 * nothing.
 */
export const dynamic = "force-dynamic";

/** Next 15+ hands `searchParams` to server components as a Promise. */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (session?.user) redirect("/collections");

  const params = await searchParams;

  const error = firstParam(params, "error");
  // Auth.js bounces here after mailing a sign-in link (pages.verifyRequest),
  // with `?provider=…&type=email` of its own making — see lib/auth/config.ts
  // for why that, rather than a `sent=1` we choose, is what says "it went".
  // `?sent=1` is still honoured for anything linking here by hand.
  const sent = firstParam(params, "sent") === "1" || firstParam(params, "type") === "email";
  const reset = firstParam(params, "reset") === "done";
  const magicLinkAvailable = isEmailProviderConfigured();

  return (
    <>
      {error ? <Notice tone="bad">{readableError(error)}</Notice> : null}
      {sent ? (
        <Notice tone="good" title="Check your email">
          A sign-in link is on its way. It expires in 24 hours.
        </Notice>
      ) : null}
      {reset ? (
        /* Set by completePasswordResetAction. Says only that it worked — the
           reset flow never confirms which address it belonged to. */
        <Notice tone="good" title="Password updated">
          Sign in with your new password.
        </Notice>
      ) : null}

      <form action={signInWithCredentials}>
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <button type="submit" style={buttonStyle}>
          Sign in
        </button>
      </form>

      <p style={{ marginTop: ".75rem", fontSize: ".8125rem" }}>
        <Link href="/reset">Forgot your password?</Link>
      </p>

      {magicLinkAvailable ? (
        <>
          <hr style={{ margin: "1.5rem 0", border: 0, borderTop: "1px solid var(--border)" }} />
          <form action={signInWithMagicLink}>
            <Field label="Or email me a sign-in link" name="email" type="email" />
            <button type="submit" style={secondaryButtonStyle}>
              Send link
            </button>
          </form>
        </>
      ) : null}

      <p style={{ marginTop: "1.5rem", fontSize: ".875rem" }}>
        No account? <Link href="/signup">Create one</Link>
      </p>
    </>
  );
}
