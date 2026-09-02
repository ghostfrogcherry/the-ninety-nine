import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isEmailProviderConfigured } from "@/auth";
import { signInWithCredentials, signInWithMagicLink } from "@/lib/auth/actions";
import { Field, Notice, buttonStyle, readableError } from "../_components";

export const metadata = { title: "Sign in · ninetynine" };

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
  const first = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const error = first("error");
  const sent = first("sent") === "1";
  const magicLinkAvailable = isEmailProviderConfigured();

  return (
    <>
      {error ? <Notice tone="error">{readableError(error)}</Notice> : null}
      {sent ? (
        <Notice tone="info">Check your email for a sign-in link. It expires in 24 hours.</Notice>
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

      {magicLinkAvailable ? (
        <>
          <hr style={{ margin: "1.5rem 0", border: 0, borderTop: "1px solid #ddd" }} />
          <form action={signInWithMagicLink}>
            <Field label="Or email me a sign-in link" name="email" type="email" />
            <button type="submit" style={{ ...buttonStyle, background: "#fff", color: "#333" }}>
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
