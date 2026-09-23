import Link from "next/link";
import type { ReactNode } from "react";

/** Page chrome shared by every view. */
export function Shell({ title, subtitle, actions, children }: {
  title: string;
  subtitle?: ReactNode;
  /** Optional controls rendered on the title row, right-aligned. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main style={{ maxWidth: "76rem", margin: "0 auto", padding: "1.75rem 1.5rem 4rem" }}>
      <nav className="topnav">
        <Link href="/" className="brand">the·ninety·nine</Link>
        <Link href="/collections">collections</Link>
        <Link href="/decks">decks</Link>
      </nav>

      <header style={{ display: "flex", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
        <h1 className="prompt" style={{ margin: "0 0 0.25rem", fontSize: "1.4rem" }}>{title}</h1>
        {actions ? <span style={{ marginLeft: "auto" }}>{actions}</span> : null}
      </header>

      {subtitle
        ? <p style={{ margin: "0 0 1.5rem", color: "var(--dim)" }}>{subtitle}</p>
        : <div style={{ height: "1.5rem" }} />}

      {children}
    </main>
  );
}

/** Shown instead of content when a query comes back empty. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

const COLORS: Record<string, string> = {
  W: "#f8f4d8", U: "var(--blue)", B: "var(--purple)",
  R: "var(--red)", G: "var(--green)",
};

/** WUBRG pips. Colourless renders as a dash rather than as nothing at all. */
export function Identity({ identity }: { identity: string[] }) {
  if (!identity.length) return <span style={{ color: "var(--dim2)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {identity.map((c) => (
        <span
          key={c}
          title={c}
          style={{
            width: 14, height: 14, borderRadius: "50%", fontSize: 9,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: COLORS[c] ?? "var(--dim)", color: "#1d2021", fontWeight: 700,
          }}
        >
          {c}
        </span>
      ))}
    </span>
  );
}

/**
 * A panel with a coloured left rule, for an outcome the page has to report:
 * a deletion that happened, an import that landed, a destructive action asking
 * to be confirmed.
 *
 * `title` is optional because two of the three uses are a single line — the
 * "Deleted X" note on /decks does not want a heading shouting DELETED above it.
 */
export function Notice({ tone = "good", title, children }: {
  tone?: "good" | "bad" | "warn";
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`panel notice ${tone}`}
      // A failure has to interrupt a screen reader; "your link is on its way"
      // should wait its turn.
      role={tone === "bad" ? "alert" : "status"}
    >
      {title ? <h2>{title}</h2> : null}
      {children}
    </div>
  );
}

export function Badge({ tone = "dim", children }: {
  tone?: "dim" | "good" | "bad" | "warn";
  children: ReactNode;
}) {
  const fg = { dim: "var(--dim)", good: "var(--green)", bad: "var(--red)", warn: "var(--yellow)" }[tone];
  return (
    <span style={{
      color: fg, border: `1px solid ${fg}`, borderRadius: 3,
      padding: "0.05rem 0.4rem", fontSize: 11, whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

/**
 * Money arrives from `pg` as a string because the columns are NUMERIC. Format
 * for display only — never parse to float and store the result back.
 */
export function usd(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}
