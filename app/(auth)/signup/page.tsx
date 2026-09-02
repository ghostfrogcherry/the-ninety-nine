import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { signUpWithCredentials } from "@/lib/auth/actions";
import { MAX_PASSWORD_BYTES } from "@/lib/auth/password";
import { Field, Notice, buttonStyle, readableError } from "../_components";

export const metadata = { title: "Create account · ninetynine" };

export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (session?.user) redirect("/collections");

  const params = await searchParams;
  const raw = params.error;
  const error = Array.isArray(raw) ? raw[0] : raw;

  return (
    <>
      {error ? <Notice tone="error">{readableError(error)}</Notice> : null}

      <form action={signUpWithCredentials}>
        <Field label="Name (optional)" name="name" required={false} autoComplete="name" />
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
        />
        <Field
          label="Confirm password"
          name="confirm"
          type="password"
          autoComplete="new-password"
        />
        <button type="submit" style={buttonStyle}>
          Create account
        </button>
      </form>

      <p style={{ marginTop: "1rem", fontSize: ".8125rem", color: "#555" }}>
        At least 8 characters, at most {MAX_PASSWORD_BYTES} bytes — bcrypt ignores anything
        past that, so a longer passphrase would only be partly checked.
      </p>

      <p style={{ marginTop: "1rem", fontSize: ".875rem" }}>
        Already have an account? <Link href="/signin">Sign in</Link>
      </p>
    </>
  );
}
