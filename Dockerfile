# Next.js standalone build. Three stages so the runtime image carries neither
# the toolchain nor the full node_modules tree.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` needs a lockfile; fall back to `npm install` on the very first build
# before one has been generated.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time only. Real secrets are injected at runtime by compose; Next just
# needs these present so `next build` can statically evaluate config.
ENV AUTH_SECRET=build-time-placeholder
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The refresh/import scripts run from this same image via the compose `refresh`
# profile, so they need to be present in the runtime layer.
#
# Their `pg` dependency does NOT need copying: the standalone trace already
# emits pg and its transitive deps into ./node_modules. Verified — the
# standalone tree contains pg, pg-pool, pg-protocol, pg-types, pg-int8,
# pg-connection-string, pgpass, pg-cloudflare and postgres-*.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib

# scripts/migrate.mjs reads the .sql files at runtime rather than embedding
# them, so the migrations have to ship too.
COPY --from=builder --chown=nextjs:nodejs /app/db/migrations ./db/migrations

# scripts/seed-demo.mjs reads these two at runtime. Without them the documented
# first step on a new install — `docker compose exec app node
# scripts/seed-demo.mjs` — dies on file-not-found. Only the committed example-*
# fixtures: a real collection scan sitting in db/seed is excluded by
# .dockerignore and must never be baked into an image layer.
COPY --from=builder --chown=nextjs:nodejs /app/db/seed/example-mirror.json /app/db/seed/example-collection.txt ./db/seed/

# The Scryfall mirror mount point, created here and owned by the runtime user.
#
# This is load-bearing. Docker seeds a fresh NAMED volume from the image's
# ownership at this path, so the refresh can write as uid 1001. A bind mount
# would not: Docker creates a missing host directory as root, and the refresh
# then dies with EACCES on its first download. Hence a named volume in compose.
RUN mkdir -p /data/scryfall && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
