"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

import { signIn, signOut } from "@/auth";
import { pool } from "@/lib/db";
import { isEmailProviderConfigured } from "@/lib/auth/email-provider";
import { appBaseUrl, isMailConfigured, sendMail } from "@/lib/auth/mail";
import { passwordResetEmail } from "@/lib/auth/messages";
import { hashPassword } from "@/lib/auth/password";
import {
  RESET_REQUEST_FLOOR_MS,
  RESET_TOKEN_TTL_MINUTES,
  completePasswordReset,
  issueResetToken,
  takeAtLeast,
} from "@/lib/auth/reset";
import {
  credentialsSchema,
  firstIssue,
  magicLinkSchema,
  resetCompleteSchema,
  resetRequestSchema,
  resetTokenSchema,
  signUpSchema,
} from "@/lib/auth/schemas";
import { createCredentialsUser, findUserByEmail } from "@/lib/auth/users";

/**
 * Server actions behind the sign-in / sign-up forms.
 *
 * These are plain `<form action={...}>` targets, so the pages stay server
 * components and the app ships no client-side auth JavaScript at all.
 *
 * One rule runs through every function here: `signIn()` and `redirect()` BOTH
 * signal success by throwing (`NEXT_REDIRECT`). A bare `catch` around them
 * swallows the redirect and the form silently does nothing. So each catch
 * re-throws anything that is not an `AuthError`.
 */

const DEFAULT_REDIRECT = "/collections";

function backToSignIn(message: string): never {
  redirect(`/signin?error=${encodeURIComponent(message)}`);
}

function backToSignUp(message: string): never {
  redirect(`/signup?error=${encodeURIComponent(message)}`);
}

function backToReset(message: string): never {
  redirect(`/reset?error=${encodeURIComponent(message)}`);
}

/** Back to the "choose a new password" form, token intact, with the reason. */
function backToResetForm(token: string, message: string): never {
  redirect(`/reset/${encodeURIComponent(token)}?error=${encodeURIComponent(message)}`);
}

export async function signInWithCredentials(formData: FormData): Promise<void> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) backToSignIn(firstIssue(parsed.error));

  try {
    await signIn("credentials", {
      email: parsed.data.email, // normalised by the schema
      password: parsed.data.password,
      redirectTo: DEFAULT_REDIRECT,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // Never distinguish "no such user" from "wrong password" to the client.
      backToSignIn("Incorrect email or password.");
    }
    throw error; // NEXT_REDIRECT and genuine faults pass through
  }
}

export async function signInWithMagicLink(formData: FormData): Promise<void> {
  if (!isEmailProviderConfigured()) {
    backToSignIn("Magic-link sign-in is not configured on this server.");
  }

  const parsed = magicLinkSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) backToSignIn(firstIssue(parsed.error));

  try {
    await signIn("nodemailer", {
      email: parsed.data.email,
      redirectTo: DEFAULT_REDIRECT,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      backToSignIn("Could not send the sign-in email. Check the SMTP settings.");
    }
    throw error;
  }
}

export async function signUpWithCredentials(formData: FormData): Promise<void> {
  const parsed = signUpSchema.safeParse({
    name: formData.get("name") ?? undefined,
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) backToSignUp(firstIssue(parsed.error));

  const confirm = formData.get("confirm");
  if (typeof confirm === "string" && confirm !== parsed.data.password) {
    backToSignUp("Passwords do not match.");
  }

  const created = await createCredentialsUser(parsed.data);
  if (!created.ok) {
    // Covers the case where the address already exists under DIFFERENT casing:
    // LOWER(email) is unique, so `Bob@x.com` collides with `bob@x.com`.
    //
    // Note this deliberately refuses to attach a password to an existing
    // magic-link-only account (password_hash IS NULL). Letting a stranger set
    // the password on someone else's row by "signing up" would be a takeover.
    backToSignUp("That email is already registered. Sign in instead.");
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: DEFAULT_REDIRECT,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      backToSignIn("Account created. Please sign in.");
    }
    throw error;
  }
}

/**
 * "Email me a reset link."
 *
 * The whole function is written around one requirement: an outsider must not be
 * able to learn from it whether an address has an account here. That costs
 * three things, and each of them is deliberate.
 *
 *  1. One redirect, always — `/reset?sent=1` — whether a user was found, no
 *     user was found, the mail bounced, or the SMTP host refused the
 *     connection. The page then says "if that address has an account", which
 *     is the literal truth.
 *  2. One duration, always. `takeAtLeast` pads both paths to the same floor;
 *     without it, "no such user" returns in a few milliseconds while a real
 *     send takes as long as the mail server does, and the form becomes a
 *     membership oracle you can poll.
 *  3. Errors are logged, never surfaced. A dead mail server is the operator's
 *     problem to find in the logs, and reporting it here would tell the caller
 *     that their address got as far as the send.
 *
 * A magic-link-only user (password_hash IS NULL) is deliberately allowed
 * through: proving control of the mailbox is exactly the proof magic-link
 * sign-in already accepts, so a reset gives them nothing they could not get by
 * signing in, and gaining a password does not take their magic link away.
 */
export async function requestPasswordReset(formData: FormData): Promise<void> {
  if (!isMailConfigured()) {
    backToReset("Password reset by email is not configured on this server.");
  }

  const parsed = resetRequestSchema.safeParse({ email: formData.get("email") });
  // A malformed address is a fact about the input, not about the account list,
  // so this one is allowed to answer immediately.
  if (!parsed.success) backToReset(firstIssue(parsed.error));
  const email = parsed.data.email; // already lowercased by the schema

  await takeAtLeast(RESET_REQUEST_FLOOR_MS, async () => {
    try {
      const user = await findUserByEmail(email);
      if (!user) return; // Unknown address: nothing written, nothing sent.

      const base = appBaseUrl();
      if (!base) {
        // No AUTH_URL means no trustworthy origin to put in the link, and the
        // Host header is not an acceptable substitute — see lib/auth/mail.ts.
        console.error("[reset] AUTH_URL is not set; refusing to build a reset link");
        return;
      }

      const { token } = await issueResetToken(pool, user.id);
      await sendMail(
        passwordResetEmail(user.email ?? email, `${base}/reset/${token}`, RESET_TOKEN_TTL_MINUTES),
      );
    } catch (error) {
      // Includes a token that was issued and then failed to send. The row is
      // harmless — it is a hash of something nobody received, and the next
      // request replaces it.
      console.error("[reset] could not send a reset link:", error);
    }
  });

  redirect("/reset?sent=1");
}

/**
 * "Here is my new password" — the POST from `/reset/<token>`.
 *
 * The token is re-validated here rather than trusted from the page that
 * rendered the form: the hidden field is user input, and the GET's check was
 * UI, not permission. Expiry, single use and the password write all happen in
 * the one statement inside `completePasswordReset`, so there is no window in
 * which a link is spent but the password is unchanged, or vice versa.
 *
 * Deliberately does NOT sign the user in afterwards. Typing the new password
 * once at the sign-in form proves it survived the round trip, and it keeps a
 * link out of the business of minting sessions.
 */
export async function completePasswordResetAction(formData: FormData): Promise<void> {
  const rawToken = formData.get("token");
  const parsed = resetCompleteSchema.safeParse({
    token: rawToken,
    password: formData.get("password"),
  });

  if (!parsed.success) {
    // Split the two failures: a bad password should land back on the form with
    // the link still live, a bad token has no form to go back to.
    const tokenOnly = resetTokenSchema.safeParse({ token: rawToken });
    if (!tokenOnly.success) redirect("/reset?expired=1");
    backToResetForm(tokenOnly.data.token, firstIssue(parsed.error));
  }

  const confirm = formData.get("confirm");
  if (typeof confirm === "string" && confirm !== parsed.data.password) {
    backToResetForm(parsed.data.token, "Passwords do not match.");
  }

  // Hashed BEFORE the token is claimed, on purpose: bcrypt at cost 12 is the
  // expensive part of this request, so paying it whether or not the link turns
  // out to be live keeps "already used" from being the fast answer. It also
  // keeps a ~250ms CPU burn out of the statement that holds the row lock.
  const passwordHash = await hashPassword(parsed.data.password);

  const userId = await completePasswordReset(pool, parsed.data.token, passwordHash);
  // Expired, already spent, or never issued here — one answer for all three.
  if (userId === null) redirect("/reset?expired=1");

  // Note what this does NOT do: sessions are JWTs (see lib/auth/config.ts), so
  // a cookie issued before the reset stays valid until it expires. Revoking
  // them would mean a per-user epoch checked on every request, which is a
  // database read in `proxy.ts` — precisely what the JWT strategy exists to
  // avoid. Worth knowing before treating a reset as "kicked everyone out".
  redirect("/signin?reset=done");
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
