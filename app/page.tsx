import Link from "next/link";

import { Account } from "@/app/_account";

/**
 * Landing page. Deliberately plain — collections and decks are the real
 * surface; this exists so "/" is not a 404 and gives a way in.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: "42rem", margin: "5rem auto", padding: "0 1.5rem" }}>
      <h1 style={{ marginBottom: "0.25rem", fontSize: "1.75rem" }}>The Ninety Nine</h1>
      <p style={{ marginTop: 0, color: "var(--dim)" }}>
        Self-hosted MTG collection tracker and Commander deck builder.
      </p>

      <nav className="home-nav">
        <Link href="/collections">Collections</Link>
        <Link href="/decks">Decks</Link>
        <Link href="/drafts">Drafts</Link>
        <Account />
      </nav>
    </main>
  );
}
