import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { signUpWithCredentials } from "@/lib/auth/actions";
import { CALLBACK_PARAM, safeCallbackPath } from "@/lib/auth/callback";
import { MAX_PASSWORD_BYTES } from "@/lib/auth/password";
import { Field, Notice, buttonStyle, firstParam, readableError } from "../_components";

export const metadata = { title: "Create account · The Ninety Nine" };

export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = firstParam(params, "error");
  // Carried from the sign-in page, so a friend who follows a draft invite and
  // has to make an account first still ends up at the invite.
  const next = safeCallbackPath(firstParam(params, CALLBACK_PARAM));

  const session = await auth();
  if (session?.user) redirect(next ?? "/collections");

  return (
    <>
      {error ? <Notice tone="bad">{readableError(error)}</Notice> : null}

      <form action={signUpWithCredentials}>
        {next ? <input type="hidden" name={CALLBACK_PARAM} value={next} /> : null}
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

      <p style={{ marginTop: "1rem", fontSize: ".8125rem", color: "var(--dim)" }}>
        At least 8 characters, at most {MAX_PASSWORD_BYTES} bytes — bcrypt ignores anything
        past that, so a longer passphrase would only be partly checked.
      </p>

      <p style={{ marginTop: "1rem", fontSize: ".875rem" }}>
        Already have an account?{" "}
        <Link href={next ? `/signin?${new URLSearchParams({ [CALLBACK_PARAM]: next })}` : "/signin"}>
          Sign in
        </Link>
      </p>
    </>
  );
}
