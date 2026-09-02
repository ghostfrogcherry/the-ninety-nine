import type { CSSProperties, ReactNode } from "react";

/**
 * Shared bits for the two auth pages. Underscore prefix keeps Next from
 * treating this folder as a route.
 */

export const fieldStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: ".5rem",
  marginTop: ".25rem",
  marginBottom: ".75rem",
  border: "1px solid #999",
  borderRadius: "4px",
  font: "inherit",
  boxSizing: "border-box",
};

export const buttonStyle: CSSProperties = {
  width: "100%",
  padding: ".55rem",
  border: "1px solid #333",
  borderRadius: "4px",
  background: "#333",
  color: "#fff",
  font: "inherit",
  cursor: "pointer",
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
 * Error banner. The message comes from `?error=` in the URL, which the server
 * actions set, so it is always one of our own strings — but it is rendered as
 * text, never as HTML, because the query string is still user-controllable.
 */
export function Notice({ children, tone }: { children: ReactNode; tone: "error" | "info" }) {
  if (!children) return null;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      style={{
        padding: ".5rem .75rem",
        marginBottom: "1rem",
        borderRadius: "4px",
        fontSize: ".875rem",
        border: `1px solid ${tone === "error" ? "#c33" : "#39c"}`,
        background: tone === "error" ? "#fee" : "#eef6fc",
        color: "#222",
      }}
    >
      {children}
    </p>
  );
}

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
      return "Could not send the sign-in email. Check the SMTP settings.";
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
