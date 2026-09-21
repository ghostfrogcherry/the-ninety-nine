# CLAUDE.md

Working notes for this repo. The README is the user-facing document and is kept
accurate — read it. This file is the things that are **not** obvious from
reading the code, and the traps that have already cost someone a session.

## What this is

A self-hosted MTG collection tracker and Commander deck builder for one
household. Next.js 16 App Router, React 19, Postgres 17, Auth.js v5 beta,
TypeScript strict, Docker Compose. Almost no client-side JavaScript —
see Conventions.

## Commands

```sh
npm test                 # 336 pure tests; 496 with TEST_DATABASE_URL set
npm run typecheck        # must be clean
npm run build            # next build --webpack; must be warning-free
node scripts/migrate.mjs [--status|--dry-run|--baseline[=VERSION]]
node scripts/seed-demo.mjs you@example.com    # clickable install, no 78 MB download
sh scripts/backup.sh [--keep=N|--no-verify|--no-mirror]
sh scripts/restore.sh --list | --file=NAME
```

Compose profiles: `migrate`, `backup`, `refresh`. The app and the one-shot jobs
share the app image; `backup`/`restore` run the **postgres** image instead,
because pg_dump must match its server and the app image has no Postgres client.

## Hard constraints that will bite you

- **`next build` must pass `--webpack`.** Next 16 defaults to Turbopack, which
  silently emits no `.next/standalone` — which is exactly what the Dockerfile
  copies, so the image builds and then fails to start. The `build` script
  already passes it. Do not remove it.
- **Auth.js v5 is beta** (`next-auth@5.0.0-beta.32`). `next-auth@latest` is v4
  with an incompatible API. Do not "upgrade".
- **Route protection is `proxy.ts`, not `middleware.ts`.** Next 16 deprecated
  the old filename and fails the build (E900) if both exist. The matcher is an
  **allow-list** of guarded paths and is the real auth boundary — widening it is
  a security change. A proxy file always runs on **Node**, so the Edge runtime
  no longer physically stops it importing `auth.ts` and its `pg`/`bcryptjs`;
  that rule now survives only as a comment in `lib/auth/config.ts`. Honour it.
- **`users.email` is unique on `LOWER(email)` but `@auth/pg-adapter` looks users
  up without `LOWER()`.** A mixed-case row is invisible to the adapter *and*
  cannot be re-registered: a permanently locked-out account. Lowercase before
  anything writes or reads `users.email`.
- **Never edit an applied migration.** The runner stores a sha256 and refuses to
  run when one changes. New schema means a new `NNNN_label.sql`.
- **Migrations run inside a transaction**, so anything that refuses one
  (`CREATE INDEX CONCURRENTLY`) needs its own path. Nothing needs it yet.
- **Collector numbers are TEXT, not integers.** Real data has `19b`, `S4`,
  `CHK-19`, `pp319sb`. `parseInt("pp319sb")` is `319`, a different card.
- **Foil is a per-line variant, not a card property.** One printing can be held
  twice at genuinely different prices. Every uniqueness constraint and every
  price lookup keys on `finish` as well as the printing. Aggregating on
  printing alone loses foils and misprices the rest.
- **`scryfall_cards` is a rebuildable cache** with deliberately no foreign keys
  pointing at it. `card_price_history` is the opposite: snapshots Scryfall does
  not keep, which nothing can reconstruct. Never treat them the same way.

## Conventions

- **Comments explain why, not what**, usually by naming the concrete failure the
  code prevents. This is the house style and it is load-bearing. Match the
  density in `app/decks/_actions.ts` and `lib/deck/index.ts`.
- **Server Components and server actions driving plain `<form>` posts.** Every
  feature works with JavaScript off, and that is a design commitment, not an
  accident: it is why deck deletion is confirmed by typing the deck's name
  rather than by `confirm()`, and why the price chart's hover layer is CSS and
  `<title>` rather than a handler. There are exactly **three** `"use client"`
  files, and adding a fourth needs a comment saying why:
  - `app/error.tsx`, `app/global-error.tsx` — React error boundaries cannot be
    server components.
  - `app/collections/[id]/_feed.tsx` — infinite scroll over a collection too
    large to ship in one payload. The page renders the first page server-side,
    so the list still works without it.
- **Every mutation re-checks ownership server-side.** See `ownedDeckOr404`. A
  hidden form field is user input, not a permission.
- **Not-yours and not-real both `notFound()`**, in pages *and* in actions, so
  ids cannot be enumerated. `app/not-found.tsx` deliberately does not name the
  resource.
- **Raw `FormData` is never trusted.** Parse through small `parse*` helpers that
  return `null`. Any id reaching an int4 column or `ORDER BY` must be range
  checked with `MAX_INT4`; an out-of-range id used to 500.
- **Styling** is gruvbox dark via CSS custom properties in `app/globals.css`.
  Reuse `app/_ui.tsx`: `Shell`, `Empty`, `Badge`, `Notice`, `Identity`, `usd`.
- **Scripts are thin wrappers.** Logic lives in `lib/`, the script in
  `scripts/`, with its own `pg` client. `.mjs` scripts run under bare `node` and
  cannot statically import `.ts` — use the dynamic-import guard from
  `scripts/import-collection.mjs`.

## Testing

`npm test` runs `node --experimental-strip-types --test --test-concurrency=1`.

- **`--test-concurrency=1` is load-bearing.** Node runs test *files* in parallel
  processes and they share one database. Without it about fifteen fail, in
  whichever files lose that run's race.
- **Database tests are opt-in** behind `TEST_DATABASE_URL`, never
  `DATABASE_URL`, so they cannot touch a real instance by inheriting the app's
  environment. They must skip cleanly when it is unset.
- **Every database test must delete the rows it wrote**, scoped to ids it
  inserted rather than `TRUNCATE`. Rows that hang off no user reach no cascade.
  Three files have had to be fixed for forgetting; the suite must pass twice in
  a row against the same database. **Check that before you claim green.**
- **Do not assert table counts.** Two tests have already broken when a migration
  added a table. Assert by name.
- `test/prices.test.ts` loads its module through a dynamic import of a
  **variable specifier** ending in `.ts`, which does no module resolution — so
  every re-export in `lib/prices/index.ts` and every import between those files
  needs an explicit `.ts` extension. Drop one and it typechecks, then dies at
  runtime with `ERR_MODULE_NOT_FOUND`.

### Getting a Postgres in a sandbox with no Docker

```sh
PGDATA=/var/lib/postgresql/scratch     # NOT a scratchpad dir — see below
rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA -U ninetynine --auth=trust -E UTF8 --locale=C.UTF-8"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -o '-p 55440 -c listen_addresses=127.0.0.1' -l $PGDATA/pg.log start"
```

Put `PGDATA` under `/var/lib/postgresql/`. An agent scratchpad directory gets
its permissions reset underneath a running server and the checkpointer aborts
mid-run, which looks exactly like test failures.

## State, as of the last commit on this branch

Roadmap complete except deployment. 336 pure tests, 496 against Postgres, clean
typecheck, warning-free build, suite verified repeatable.

Built and exercised: collection import (CLI, HTTP and browser), Scryfall mirror,
Commander validation, deck editing with rename and delete, public share links,
price history, password reset, magic-link sign-in, migration runner, verified
backups.

**Never done: deployed.** The import and price pages have been driven over HTTP
against a real Postgres with the fixture, but never seen against a real
collection on real hardware. Docker itself is unexercised — there is no daemon
in the sandbox — so `docker compose up` is validated by config check and image
contents only.

### What is genuinely next

1. Deploy. Populate the mirror for real, import a collection, wait a fortnight
   so the price chart has two refreshes to draw.
2. No CI. Nothing runs the 496 tests automatically.
3. Only the `db` service has a healthcheck, so `restart: unless-stopped` cannot
   tell a wedged app from a running one.
4. Test isolation is the author's responsibility rather than the setup's. A
   database per file, or a transaction rolled back per test, would make it
   structural.
5. `app/decks/[id]/page.tsx` is ~560 lines and holds a page plus eight
   components. It is the next `lib/prices` if nobody touches it.
6. Browser uploads cap at 960 KB against the route's 2 MB, pending
   `experimental.serverActions.bodySizeLimit` in `next.config.ts`.

## Git

Develop on `claude/project-continuation-4d8xol`. A pull request from this branch
was already merged into `main` once, so check whether yours has merged before
stacking: if it has, restart the branch from `main` rather than building on
merged history.
