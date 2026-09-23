import type { NextConfig } from "next";

// Relative and with its `.ts` extension, not `@/lib/...`: this file is loaded
// outside webpack, and an explicit path is what resolves under both loaders
// that read it — the SWC require hook `next build` uses, and Node's type
// stripping, which does no resolution and is how the test suite loads it.
// lib/import/form.ts imports nothing, so this pulls no app code into config.
import { MAX_ACTION_BODY_BYTES } from "./lib/import/form.ts";

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

  experimental: {
    serverActions: {
      // Imported rather than written out so the browser import cannot drift
      // from the ceiling the action enforces: a larger file has to reach the
      // action to be refused in words rather than by Next's own 500. The
      // reasoning for the size is on the constant.
      bodySizeLimit: MAX_ACTION_BODY_BYTES,
    },
  },

  images: {
    // Card art is served by Scryfall's CDN. Only image URLs are fetched live —
    // card DATA always comes from the local mirror.
    remotePatterns: [{ protocol: "https", hostname: "cards.scryfall.io" }],
  },
};

export default nextConfig;
