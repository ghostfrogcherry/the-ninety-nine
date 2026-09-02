import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "The Ninety Nine",
  description: "Self-hosted MTG collection tracker and Commander deck builder",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
