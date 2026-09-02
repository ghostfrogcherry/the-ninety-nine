import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required by the Dockerfile: emits .next/standalone with a self-contained
  // server.js and only the actually-imported node_modules.
  output: "standalone",

  // `pg` uses dynamic requires that the bundler cannot statically resolve.
  // Without this, server components that touch the pool fail at runtime.
  serverExternalPackages: ["pg"],

  images: {
    // Card art is served by Scryfall's CDN. Only image URLs are fetched live —
    // card DATA always comes from the local mirror.
    remotePatterns: [{ protocol: "https", hostname: "cards.scryfall.io" }],
  },
};

export default nextConfig;
