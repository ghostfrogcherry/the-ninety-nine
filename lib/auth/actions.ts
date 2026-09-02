"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

import { signIn, signOut } from "@/auth";
import { isEmailProviderConfigured } from "@/lib/auth/email-provider";
import { credentialsSchema, firstIssue, magicLinkSchema, signUpSchema } from "@/lib/auth/schemas";
import { createCredentialsUser } from "@/lib/auth/users";

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

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
