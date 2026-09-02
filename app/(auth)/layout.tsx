import type { ReactNode } from "react";

/**
 * Layout for the (auth) route group. The parentheses mean the folder does not
 * appear in the URL: `app/(auth)/signin` serves `/signin`.
 *
 * Function over polish — inline styles, no design system, no CSS dependency to
 * conflict with whatever the rest of the app settles on.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        maxWidth: "22rem",
        margin: "4rem auto",
        padding: "0 1rem",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: "1.25rem", marginBottom: "1.5rem" }}>ninetynine</h1>
      {children}
    </main>
  );
}
