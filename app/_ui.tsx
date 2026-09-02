import Link from "next/link";
import type { ReactNode } from "react";

/** Page chrome shared by every signed-in view. */
export function Shell({ title, subtitle, children }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main style={{ maxWidth: "62rem", margin: "0 auto", padding: "2.5rem 1.5rem 4rem" }}>
      <nav style={{ display: "flex", gap: "1.25rem", marginBottom: "2rem", fontSize: 12 }}>
        <Link href="/">home</Link>
        <Link href="/collections">collections</Link>
        <Link href="/decks">decks</Link>
      </nav>
      <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem" }}>{title}</h1>
      {subtitle ? (
        <p style={{ margin: "0 0 2rem", color: "var(--dim)" }}>{subtitle}</p>
      ) : (
        <div style={{ height: "2rem" }} />
      )}
      {children}
    </main>
  );
}

/** Shown instead of a table when a query comes back empty. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        color: "var(--dim2)",
        border: "1px dashed var(--border)",
        borderRadius: 4,
        padding: "1.5rem",
        textAlign: "center",
      }}
    >
      {children}
    </p>
  );
}

const COLORS: Record<string, string> = {
  W: "#f8f4d8", U: "var(--blue)", B: "var(--purple)",
  R: "var(--red)", G: "var(--green)",
};

/** WUBRG pips. Colourless renders as a dash rather than nothing. */
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

/** Money is stored NUMERIC and arrives from pg as a string. Never parse to float for display. */
export function usd(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}
