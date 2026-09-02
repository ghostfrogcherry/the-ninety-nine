# The Ninety Nine

Self-hosted MTG collection tracker and Commander deck builder — a Moxfield-lite
for one household. Runs alongside an existing arr stack.

Named for the ninety-nine cards that sit behind a commander.

## Status

Backend is built and tested, with read-only views on top. Deck building in the
browser is the main thing still missing.

| Piece | State |
|---|---|
| Postgres schema (`db/migrations/`) | Done — applies clean, constraints verified |
| Docker Compose + Dockerfile | Done — image builds, stack runs, migrations auto-apply |
| Collection import (`lib/import/`, `scripts/import-collection.mjs`) | Done — 18 tests |
| Scryfall bulk mirror (`lib/scryfall/`, `scripts/refresh-scryfall.mjs`) | Done — 26 tests |
| Commander validation (`lib/commander/`) | Done — 32 tests, mutation-checked |
| Auth.js v5 (`auth.ts`, `lib/auth/`) | Done — sign-in verified end-to-end over HTTP |
| API routes (`app/api/collections/`) | Done |
| Collection + deck UI | Done — read-only views, verified against a running stack |
| **Deck editing** | **Not built** — decks can be read and validated, not built in the UI |
| **Public deck share links** (`/d/[slug]`) | **Not built** — schema supports it (`decks.public_slug`) |

92 tests pass; `tsc --noEmit` is clean.

## Stack

Next.js 16.3.4 · React 19 · Postgres 17 · Auth.js v5 · Docker Compose · optional Caddy.

Three version facts that will bite if you change them casually:

- **`next build` must run with `--webpack`.** Next 16 defaults to Turbopack,
  which silently produces **no** `.next/standalone` output — the Dockerfile
  copies exactly that, so the image would build and then fail to start. The
  `build` script already passes the flag. Turbopack standalone also drops
  `serverExternalPackages` (our `pg`); see
  [vercel/next.js#88844](https://github.com/vercel/next.js/issues/88844).
- **Auth.js v5 is still beta** (`next-auth@5.0.0-beta.32`). `next-auth@latest`
  is v4 with an incompatible API. Do not "upgrade" to latest.
- **Lucia is not an option.** It was deprecated in March 2025 and is now a guide
  for hand-rolling sessions, not a library.

Nodemailer is pinned to 8.x, not the current 9.x, because that is what Auth.js
peer-accepts.

## Quick start

```sh
cp .env.example .env
# set POSTGRES_PASSWORD and AUTH_SECRET (openssl rand -base64 32)
docker compose up -d
```

The app listens on **3010**, chosen to miss the ports a typical arr stack
already uses (3000, 5055, 6767, 7878, 8080, 8096, 8686, 8989, 9696). Postgres is
not published at all.

Migrations in `db/migrations/` run via `/docker-entrypoint-initdb.d` on **first
init only**. Once `data/db` exists they are ignored — later changes need a real
migration runner.

Weekly Scryfall refresh (cron):

```sh
docker compose --profile refresh run --rm scryfall-refresh
```

Real numbers from a first run: 78 MB gzipped download, 117,620 cards upserted
in about ten seconds. A second run the same day downloads nothing and logs no
row — it compares Scryfall's `updated_at` against the last **successful**
import, so a previously failed run does not suppress a retry.

The mirror lives in a **named volume**, not a bind mount. Docker creates a
missing bind-mount directory as root while the container runs as uid 1001, so
the refresh dies with `EACCES` on its first download. A named volume inherits
ownership from the image and works out of the box.

### Prices

Prices come from Scryfall's `usd` / `usd_foil`, which is TCGplayer **market**
price. Retailer exports often use a price ladder with a bulk floor instead — a
1457-card collection valued at $1,639.67 by such an export came to $1,139.26 at
Scryfall market. Neither is wrong; they measure different things. Every price in
this app is Scryfall market, consistently.

## Collection data

Real collections are personal data and live **outside this repo**. The committed
fixture is synthetic — public card names, invented ownership, deterministic fake
UUIDs. Regenerate with:

```sh
node scripts/make-example-fixture.mjs
```

It is small (19 lines / 48 cards) but deliberately covers every case that breaks
importers. See `scripts/make-example-fixture.mjs` — each row is commented with
what it exercises.

### Export format

The importer reads the Moxfield/MTGO plain-text format, **not** ManaBox CSV:

```
1 Growing Ranks (C19) 193
2 Makindi Stampede // Makindi Mesas (ZNR) 26
1 Reflections of Littjara (KHM) 400 *F*
```

Three properties of real exports that a naive parser gets wrong:

1. **Collector numbers are not integers.** Real data contains `19b`, `33a`,
   `278s`, `S4`, `CHK-19`, `DDE-48`, `SHM-237`, `et45sb`, `pp319sb`. They are
   `TEXT` everywhere. `parseInt("pp319sb")` yields `319` — a different card.

2. **Names contain ` // `** (split cards and modal DFCs). The set code is matched
   from the right so a greedy pattern cannot eat the name.

3. **Foil is a per-line variant, not a card property.** A printing can appear
   twice, once plain and once `*F*`, and the two carry *different prices*. Every
   uniqueness constraint and every price row therefore keys on `finish` as well
   as the printing. Deduplicating on printing alone loses foils and misprices
   the rest.

## Schema notes

`collection_cards.scryfall_id` and `deck_cards.scryfall_id` are deliberately
**not** foreign keys to `scryfall_cards`. That table is a cache rebuilt from the
weekly bulk download; a FK would either block the refresh or cascade-delete real
user data when Scryfall reshuffles a printing. Unresolved rows are recorded in
`collection_import_issues` rather than dropped.

Commander legality is enforced in the app, not by CHECK constraints — banned
lists change, and a row that was legal when written must not become
un-updatable later.

**The `sessions` table stays empty.** Setting an adapter would flip Auth.js to
database sessions, which it refuses to persist for credentials sign-in, so the
strategy is forced to JWT. The table is not dead schema, but do not debug a
login by looking there.

**`users.email` is unique on `LOWER(email)`, but `@auth/pg-adapter` looks users
up with `select * from users where email = $1` — no `LOWER()`.** A mixed-case
row would therefore fail lookup, fall through to `createUser`, and die on a
duplicate key, permanently locking that account out. Everything that writes
`users.email` must lowercase first. `lib/auth/` does.

## Verification performed

- All migrations apply clean to `postgres:17-alpine`.
- Constraints: foil + non-foil of one printing both store; a true duplicate is
  rejected; `quantity = 0` is rejected; email uniqueness is case-insensitive.
- Docker image builds; `docker compose up` brings the stack to healthy with all
  13 tables and the `collection_values` view auto-created.
- HTTP, against the running stack: `/` 200, `/signin` 200, `/collections` 307
  when signed out and past middleware when signed in, `/api/auth/providers` 200
  listing only `credentials` (magic link correctly absent without SMTP).
- Real sign-in over HTTP: correct password sets a session cookie; wrong password
  redirects with `CredentialsSignin` and sets none; a mixed-case email
  authenticates against a lowercase-stored row.
- Commander rules are mutation-tested — the library was deliberately broken 12
  ways to confirm the suite catches each one.
- UI, against the running stack with the fixture loaded: `/collections` lists
  19 printings / 48 cards / $62.17, matching the `collection_values` view to the
  cent, and the collection view renders foil and non-foil of one printing as two
  rows at genuinely different prices ($0.35 / $0.49).
- **Against live Scryfall, not a fixture:** the refresh pulled the real
  `default_cards` bulk file (78 MB gzipped, 117,620 cards) and a real 1457-line
  collection then imported at **1457 printings / 1705 cards / 71 foils / 1441
  distinct ids — 100% resolved by (set, collector), zero fallbacks, zero
  issues.** Exactly one card in the whole collection has no Scryfall price.

## Next

1. Deck editing in the UI.
2. Public deck share links at `/d/[slug]` (schema is ready).
3. First real Scryfall mirror population, then import a collection.

## Known gaps

- The UI is read-only. There is no way to create or edit a deck in the browser
  yet; decks must be inserted directly, and are then rendered and validated.
- `middleware.ts` uses a convention Next 16 deprecates in favour of `proxy.ts`.
  It works and is warned about on every build. Codemod:
  `npx @next/codemod@canary middleware-to-proxy .`
- Magic-link sign-in has never been exercised — no SMTP configured.
- `card_price_history` only starts filling on the **second** refresh, because
  the first has no outgoing prices to preserve. `collection_values` falls back
  to current mirror prices until then (migration 0006), so nothing reads as
  $0.00, but price *charts* have no data for the first week.
