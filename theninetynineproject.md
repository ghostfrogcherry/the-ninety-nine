# The Ninety Nine — project notes

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
npm test                 # 347 pure tests; 510 with TEST_DATABASE_URL set
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

  Count them with `grep -rlE '^"use client"' app`, not a bare grep:
  `prices/_chart.tsx` mentions the directive in a comment.
- **Signed-in pages pass `account={<Account />}` to `Shell`** (`app/_account.tsx`):
  the email and a sign-out **form**, a POST, never a link. It is a slot, not
  something `Shell` renders itself, because `app/error.tsx` is a client
  component that renders `Shell`.
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

`npm test` runs `node --experimental-strip-types --test test/*.test.ts`.

- **Every database test file gets its own throwaway database** from
  `test/_db.ts`: `createTestDatabase(label)` creates `nn_test_<label>_<pid>_<hex>`,
  migrates it with the real runner, and `drop()` removes it `WITH (FORCE)`. That
  is why the files run in parallel and why the old rule — every test deletes
  the rows it wrote, or a *different* file goes red on the next run — is gone.
  New database test files use `createTestDatabase` and
  `describe(..., { skip: SKIP_WITHOUT_DATABASE })`. Isolation is per **file**,
  not per test: tests inside one file share its database and run in order.
- **Database tests are opt-in** behind `TEST_DATABASE_URL`, never
  `DATABASE_URL`, so they cannot touch a real instance by inheriting the app's
  environment. They must skip cleanly when it is unset. The URL is now only the
  connection used to create and drop databases: it can name any database that
  exists (`/postgres`), needs no migration, and its role needs `CREATEDB`.
  `test/health.test.ts` is the one file that queries it directly, read-only.
- **Before claiming green:** the suite passes with and without
  `TEST_DATABASE_URL`, and afterwards
  `SELECT datname FROM pg_database WHERE datname LIKE 'nn\_test\_%'` returns
  nothing. A file that forgets its `after` hook still passes; the leak shows
  up only there. CI checks both.
- **Do not assert table counts.** Two tests have already broken when a migration
  added a table. Assert by name.
- `test/prices.test.ts` loads its module through a dynamic import of a
  **variable specifier** ending in `.ts`, which does no module resolution — so
  every re-export in `lib/prices/index.ts` and every import between those files
  needs an explicit `.ts` extension. Drop one and it typechecks, then dies at
  runtime with `ERR_MODULE_NOT_FOUND`. `next.config.ts` imports
  `./lib/import/form.ts` with the extension for the same kind of reason.

## CI

`.github/workflows/ci.yml`, on every push and pull request. Two jobs:

- **check**: typecheck; the suite against `postgres:17-alpine`, failing on any
  `# SKIP` (a skipped `describe` does not show in Node's `# skipped N`) and on
  any leftover `nn_test_*` database; `npm run build`, failing on any `⚠` line
  except "No build cache found", because `next build` exits 0 with warnings.
- **image**: `docker build`, `docker compose config` for every file/profile
  combination against `.env.example`, then a real `docker compose up --wait`
  smoke test: health, sign-in and proxy-redirect status codes, the demo seed
  and `migrate --status` run inside the image.

The image had never built before CI: the runner stage copies `public/`, which
this repo has never had, so the builder now `mkdir -p public`. Do not remove it.

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

Inside a subagent's git worktree, `su` and `runuser` are refused by the
isolation guard. Prefix the same binaries with
`setpriv --reuid=postgres --regid=postgres --init-groups`, or use Debian's
`pg_createcluster 16 NAME -d $PGDATA -p PORT` and `pg_ctlcluster`.

## State, as of the last commit on this branch

Roadmap complete except deployment. 347 pure tests, 510 against Postgres, clean
typecheck, warning-free build, CI green including a real `docker compose up`.

Built and exercised: collection import (CLI, HTTP and browser, 2 MB both ways),
Scryfall mirror, Commander validation, deck editing with rename and delete,
public share links, price history, password reset, magic-link sign-in,
migration runner, verified backups, app health check.

**Never done: deployed.** The stack has come up healthy in CI on the demo seed,
but has never met a real collection, a real 78 MB mirror, or real hardware.

- **The app healthcheck reports; it does not restart.** Plain Docker only marks
  a container `unhealthy`; `restart: unless-stopped` still acts on exits alone.
  Caddy waits on `service_healthy`. Auto-restart would need something like an
  autoheal container with the Docker socket, deliberately not added.
- **The server-action body limit is 4 MB** (`MAX_ACTION_BODY_BYTES`, twice
  `MAX_IMPORT_BYTES`) and applies to every action. Next rejects an oversized
  body before the action runs, as a 500; the headroom is what lets a 2–4 MB
  file get the friendly "over 2 MB" message instead.
- The shared pool in `lib/db` has an `error` listener. Without it a Postgres
  restart logged every idle client as an `uncaughtException` with its
  connection details.

### What is genuinely next

1. Deploy. Populate the mirror for real, import a collection, wait a fortnight
   so the price chart has two refreshes to draw.
2. The import report counts lines after duplicates merge, so a file of many
   repeated lines reports "19 lines parsed" next to 131,759 cards. Correct but
   confusing; the HTTP route does the same.

## Git

Each session develops on the branch it was given. Pull requests from earlier
branches (`claude/project-continuation-4d8xol`) have already merged into
`main`, so check whether yours has merged before stacking: if it has, restart
the branch from `main` rather than building on merged history.
