import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required by the Dockerfile: emits .next/standalone with a self-contained
  // server.js and only the actually-imported node_modules.
  output: "standalone",

  // `pg` uses dynamic requires that the bundler cannot statically resolve.
  // Without this, server components that touch the pool fail at runtime.
  //
  // `bcryptjs` does not need this for the app itself — webpack bundles it into
  // the server output happily. But being external is what puts a real copy in
  // `.next/standalone/node_modules`, and the maintenance scripts shipped in the
  // same image (scripts/set-password.mjs) import it directly. Bundled, it is
  // unreachable from them and they die with ERR_MODULE_NOT_FOUND.
  serverExternalPackages: ["pg", "bcryptjs"],

  images: {
    // Card art is served by Scryfall's CDN. Only image URLs are fetched live —
    // card DATA always comes from the local mirror.
    remotePatterns: [{ protocol: "https", hostname: "cards.scryfall.io" }],
  },
};

export default nextConfig;
