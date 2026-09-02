import { z } from "zod";

import { MAX_PASSWORD_BYTES, passwordByteLength } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/auth/normalize";

/**
 * Zod schemas for credential input.
 *
 * Auth.js performs NO validation on what reaches `authorize()` — the object is
 * whatever was posted. Everything below runs before a single database query.
 *
 * Emails are lowercased by the schema itself (via `transform`) so callers
 * cannot forget: the parsed output is always index-comparable.
 */

const emailField = z
  .string()
  .trim()
  .min(3, "Email is required")
  .max(255, "Email is too long") // users.email is VARCHAR(255)
  .email("Enter a valid email address")
  .transform(normalizeEmail);

/** Sign-in: length-bounded only. Never tell a sign-in form a password is weak. */
const signInPasswordField = z
  .string()
  .min(1, "Password is required")
  .refine(
    (value) => passwordByteLength(value) <= MAX_PASSWORD_BYTES,
    `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
  );

/**
 * Sign-up: a real minimum, plus the hard bcrypt ceiling.
 *
 * The 72-byte cap is not a policy choice — bcrypt silently ignores input past
 * 72 bytes, so accepting a 90-character passphrase would mean the last 18
 * characters do nothing. Rejecting is honest; truncating is not.
 */
const signUpPasswordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine(
    (value) => passwordByteLength(value) <= MAX_PASSWORD_BYTES,
    `Password must be at most ${MAX_PASSWORD_BYTES} bytes (bcrypt ignores anything longer)`,
  );

export const credentialsSchema = z.object({
  email: emailField,
  password: signInPasswordField,
});

export const signUpSchema = z.object({
  name: z
    .string()
    .trim()
    .max(255) // users.name is VARCHAR(255)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  email: emailField,
  password: signUpPasswordField,
});

export const magicLinkSchema = z.object({ email: emailField });

export type Credentials = z.infer<typeof credentialsSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;

/** First error message from a failed parse, for display in the minimal forms. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input";
}
