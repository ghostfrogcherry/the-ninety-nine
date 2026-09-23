import type { CSSProperties, ReactNode } from "react";

/**
 * Shared bits for the auth pages. Underscore prefix keeps Next from treating
 * this folder as a route.
 */

export const fieldStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: ".5rem",
  marginTop: ".25rem",
  marginBottom: ".75rem",
  // Colours come from globals.css so this matches the rest of the app;
  // hardcoding a light border here is what made the form render white.
  font: "inherit",
  boxSizing: "border-box",
};

/**
 * Deliberately colourless. `globals.css` already paints every bare <button>
 * gruvbox — the previous `#333` background and `#fff` text here overrode that
 * and put a light-mode button on a near-black page, which is the same bug the
 * comment on `fieldStyle` describes. All this adds is the full-width shape the
 * narrow auth column wants.
 */
export const buttonStyle: CSSProperties = {
  width: "100%",
  padding: ".55rem",
  cursor: "pointer",
};

/** The quieter of two buttons on one page — magic link next to sign-in. */
export const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--bg2)",
  borderColor: "var(--border)",
  color: "var(--fg2)",
};

export function Field({
  label,
  name,
  type = "text",
  required = true,
  autoComplete,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string;
}) {
  return (
    <label style={{ display: "block", fontSize: ".875rem" }}>
      {label}
      <input
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        style={fieldStyle}
      />
    </label>
  );
}

/**
 * Re-exported so these pages keep importing their chrome from one place.
 *
 * The auth pages used to carry their own copy, with the same props, because
 * there was no notice class in `globals.css` to lean on. There is now, and two
 * components with one name and one shape is how they drift apart.
 *
 * Messages arrive from `?error=` in the URL, which our own server actions set,
 * but the query string is user-controllable regardless — so every one is
 * rendered as text by React, never as HTML.
 */
export { Notice } from "@/app/_ui";

/**
 * Auth.js redirects here with its own opaque error codes (`CredentialsSignin`,
 * `Configuration`, ...) when something fails outside our server actions.
 * Translate the ones a household user might actually hit; pass our own
 * human-readable messages through untouched.
 */
export function readableError(raw: string): string {
  switch (raw) {
    case "CredentialsSignin":
      return "Incorrect email or password.";
    case "EmailSignInError":
    case "EmailCreateAccount":
      return "Could not send the sign-in email. Check the mail settings.";
    case "Verification":
      return "That sign-in link has expired or was already used.";
    case "AccessDenied":
      return "That account is not allowed to sign in.";
    case "Configuration":
      return "Auth is misconfigured on the server. Check AUTH_SECRET and DATABASE_URL.";
    default:
      return raw;
  }
}

/**
 * `searchParams` reader for the auth pages.
 *
 * Next hands a repeated query parameter over as an array, so `?error=a&error=b`
 * makes `params.error` a `string[]` — rendering that straight into a Notice
 * prints `a,b`. Take the first and be done with it.
 */
export function firstParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}
