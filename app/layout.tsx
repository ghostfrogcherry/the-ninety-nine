import type { ReactNode } from "react";

export const metadata = {
  title: "ninetynine",
  description: "Self-hosted MTG collection and deck builder",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
