import Link from "next/link";

/**
 * Landing page. Deliberately plain — the deck builder and collection views are
 * the real surface; this exists so "/" is not a 404.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: "42rem", margin: "4rem auto", padding: "0 1.5rem", lineHeight: 1.6 }}>
      <h1 style={{ marginBottom: "0.25rem" }}>The Ninety Nine</h1>
      <p style={{ marginTop: 0, opacity: 0.7 }}>
        Self-hosted MTG collection tracker and Commander deck builder.
      </p>

      <nav style={{ display: "flex", gap: "1rem", marginTop: "2rem" }}>
        <Link href="/collections">Collections</Link>
        <Link href="/decks">Decks</Link>
        <Link href="/signin">Sign in</Link>
      </nav>
    </main>
  );
}
