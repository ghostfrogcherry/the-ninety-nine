"use client";

/**
 * The boundary of last resort: a failure in the ROOT LAYOUT itself.
 *
 * app/error.tsx renders inside that layout, so it cannot catch a layout that
 * threw — by the time this file is reached there is no `<html>`, no `<body>`
 * and no stylesheet, which is why it carries its own and why it cannot use
 * `Shell` or anything else from app/_ui.tsx.
 *
 * Realistically this fires when the layout's own imports fail, so the styling
 * is inline and the markup deliberately trivial: whatever is broken, this page
 * must not need anything from the app to render. Same rule as app/error.tsx
 * about `error.message` — the digest is quotable, the message is not.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en">
      <body style={{
        margin: 0,
        minHeight: "100vh",
        background: "#1d2021",
        color: "#ebdbb2",
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        padding: "2rem 1.5rem",
      }}>
        <main style={{ maxWidth: "40rem", margin: "0 auto" }}>
          <h1 style={{ fontSize: "1.2rem", color: "#fb4934", margin: "0 0 0.75rem" }}>
            the·ninety·nine failed to start a page
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5 }}>
            This is the fallback shown when the application shell itself cannot
            render, so there is nothing useful to do in the browser. Check the
            container: <code>docker compose logs app</code>.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 13, color: "#a89984" }}>
              Reference <code>{error.digest}</code>.
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
