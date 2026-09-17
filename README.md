# The Ninety Nine

Self-hosted MTG collection tracker and Commander deck builder — a Moxfield-lite
for one household.

Named for the ninety-nine cards that sit behind a commander.

## Status

Feature-complete for one household's use. Collections and decks can both be
built, edited and shared from a browser; nothing routine needs a terminal any
more.

| Piece | State |
|---|---|
| Postgres schema (`db/migrations/`) | Done — applies clean, constraints verified |
| Docker Compose + Dockerfile | Done — image builds, stack runs, migrations auto-apply |
| Collection import (`lib/import/`, `scripts/import-collection.mjs`) | Done — 18 tests |
| Collection import in the browser (`app/collections/`) | Done — upload or paste, dry-run preview |
| Scryfall bulk mirror (`lib/scryfall/`, `scripts/refresh-scryfall.mjs`) | Done — 26 tests |
| Commander validation (`lib/commander/`) | Done — 32 tests, mutation-checked |
| Auth.js v5 (`auth.ts`, `lib/auth/`) | Done — sign-in verified end-to-end over HTTP |
| API routes (`app/api/collections/`) | Done |
| Collection browser | Done — filters, infinite scroll, foil and non-foil priced apart |
| Deck editing | Done — create, rename, delete, add/remove/move, paste-import |
| Public deck share links (`/d/[slug]`) | Done — rotatable slug that survives un-sharing |
| Price history (`lib/prices/`, `/collections/[id]/prices`) | Done — value chart and movers |
| Migration runner (`lib/migrate/`, `scripts/migrate.mjs`) | Done — checksummed ledger, transactional, adopts an existing database |

316 tests pass without a database and 460 with one; `tsc --noEmit` is clean and
`next build --webpack` is warning-free.

The suite runs its files **serially** (`--test-concurrency=1` in the `test`
script) and that flag is load-bearing, not taste. Node runs test files in
parallel processes by default, and every database-backed file seeds the same
shared fixture into the same tables, so in parallel they delete each other's
rows mid-assertion — about fifteen failures, in whichever files lose that run's
race.

## Stack

Next.js 16.3.4 · React 19 · Postgres 17 · Auth.js v5 · Docker Compose · optional Caddy.

Three version facts that will bite if you change them casually:

- **`next build` must run with `--webpack`.** Next 16 defaults to Turbopack,
  which silently produces **no** `.next/standalone` output — the Dockerfile
  copies exactly that, so the image would build and then fail to start. The
  `build` script already passes the flag. Turbopack standalone also drops
  `serverExternalPackages` (our `pg`); see
  [vercel/next.js#88844](https://github.com/vercel/next.js/issues/88844).
- **Route protection lives in `proxy.ts`, not `middleware.ts`.** Next 16
  deprecated the `middleware` filename and warns on every build; with both files
  present the build fails outright (E900). The rename is nearly all of it — the
  matcher is parsed by the same code either way, and ours compiles to
  byte-identical regexps — but a proxy file **always runs on the Node runtime**,
  and a `runtime` segment config inside one is itself a build error (E1031).
  That matters more than it sounds: the Edge runtime used to be what physically
  stopped that file importing `auth.ts` and its `pg`/`bcryptjs`, because neither
  would load there. On Node that import compiles quietly and puts a Postgres
  pool in front of every guarded request, so the rule now survives only as a
  comment. The matchers also moved in the build output, from
  `middleware-manifest.json` to `functions-config-manifest.json`. The official
  codemod is a no-op here: it renames a function literally named `middleware`,
  and this file does `export default auth`.

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
init only**. Once `data/db` exists that directory is ignored, so every later
change goes through the runner:

```sh
docker compose --profile migrate run --rm migrate
docker compose --profile migrate run --rm migrate --status
```

See [Migrations](#migrations) for what it does about the database you already
have.

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

Price history is read at `/collections/[id]/prices`: collection value over time,
plus the biggest movers each way over 30 days, 90 days, a year, or everything
recorded. The chart is inline SVG generated from pure functions in `lib/prices/`
— no charting library, no client component, and the hover layer is CSS and
`<title>`.

Two rules make the numbers reconcile. Every price lookup keys on `finish` as
well as the printing, because foil and non-foil of one printing are separate
rows at separate prices. And every lookup takes the most recent row **at or
before** the date being valued, so a card the weekly refresh had nothing new to
say about keeps its last observed price instead of dropping out of the total.
Movers rank by the money the collection actually gained or lost — quantity times
the per-card move — with percent shown alongside, because twelve basics up three
cents matter more than one card doubling from $0.02. Cards with no Scryfall
price are counted and shown, never silently summed as zero.

One wrinkle worth knowing: `/collections` reports the latest *history* price via
`collection_values`, while a collection's card list totals the *live mirror*.
Once history exists the two can differ by up to a week. The price page shows
both, labelled.

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

### Importing in the browser

`/collections` creates a collection; the collection page takes an export either
as a file upload or pasted into a textarea. Pasting is the common case — the
format is plain text and it usually arrives on a clipboard.

Tick **dry run** to see what an import would do without writing anything: lines
parsed, lines resolved, printings written, physical cards matched, and every row
that did not resolve. A real run reports the same numbers and lists unresolved
rows out of `collection_import_issues`, with near-miss candidates for ambiguous
lines. Nothing is ever silently dropped — a collection that quietly ends up
smaller than the file it was built from is the failure this report exists to
prevent.

The default conflict mode is **set**, so re-uploading the same file is a no-op
rather than doubling every quantity. Choose **add** only when the file really is
a batch of newly-acquired cards.

Browser uploads are capped at 960 KB, below the 2 MB the HTTP route accepts.
Next rejects a Server Action body over 1 MB inside its own handler, before any
of our code runs, so the cap sits under that in order to fail with a sentence
instead of an error page. 960 KB is still about 21x the largest real export
seen. Raising it means setting `experimental.serverActions.bodySizeLimit` in
`next.config.ts`; until then a larger file goes through
`scripts/import-collection.mjs`.

`POST /api/collections/[id]/import` is unchanged and still the path for curl and
scripts. Both front doors call the same `importCollection`, and both read the
same `MAX_IMPORT_BYTES`.

## Migrations

`db/migrations/NNNN_label.sql`, applied in filename order and recorded in a
`schema_migrations` table with a sha256 of each file.

Four properties worth knowing:

- **A migration and the row recording it commit together.** Postgres has
  transactional DDL, so a migration that fails halfway leaves neither
  half-applied schema nor a ledger that lies about it. There is no "dirty"
  state to repair by hand. The one thing this rules out is a statement that
  refuses to run in a transaction — `CREATE INDEX CONCURRENTLY`, most likely —
  which would need its own path.
- **An applied migration is immutable.** Edit one after it has run and the next
  run refuses, naming the file. The failure that guards against is someone
  "fixing" 0003, watching it work on their empty database, and shipping schema
  the deployed box will never have.
- **Out-of-order migrations are refused.** Two branches each adding an `0007`
  merge cleanly in git and then apply in whichever order the filenames happen
  to sort, running the loser against schema its author never saw.
  `--allow-out-of-order` exists for when you have looked and it is fine.
- **One runner at a time**, via a Postgres advisory lock. Two would otherwise
  read the same pending list and both try to apply it.

`--status` lists what is applied and what is pending. `--dry-run` names what
would run without running it.

### The database you already have

A box built before this existed has all six migrations applied by
`/docker-entrypoint-initdb.d` and no ledger at all. The runner cannot tell that
apart from a database six migrations behind, so it refuses and says so rather
than guessing — applying them would fail on the first `CREATE TABLE`, and
adopting them silently could skip a migration that box genuinely never ran.

Adopt what it actually has, then run normally:

```sh
docker compose --profile migrate run --rm migrate --baseline=0006
docker compose --profile migrate run --rm migrate
```

Pass the last version that box received, not necessarily the last on disk —
`--baseline` with no version adopts everything, which is wrong if you upgraded
and added `0007` in the same step.

A **fresh** database needs none of this. `db/init/zzz_record_baseline.sh` is
mounted alongside the migrations, sorts after them, and records what init just
applied, so a new install comes up already reconciled. Its checksums are
`sha256sum` over the same bytes `lib/migrate/` hashes with `createHash`; a test
pins the two to the same known value, because if they ever disagree every fresh
install reports all six migrations as edited-since-applied.

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
  when signed out and past the proxy when signed in, `/api/auth/providers` 200
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
- The proxy rename preserves the auth boundary exactly: the four compiled
  matchers are byte-identical before and after, and against `.next/standalone`
  each of `/collections`, `/collections/1`, `/decks`, `/decks/1` still 307s to
  `/signin` when signed out while `/`, `/signin`, `/signup`, `/d/<slug>` and
  `/api/auth/*` are never entered.
- The migration runner was exercised against Postgres 16 on every path that
  matters: the real migrations applied to an empty database and produced all 13
  tables plus the ledger; a second run applied nothing; a migration that fails
  mid-file rolled its schema back and recorded nothing, leaving the one before
  it committed; an edited migration was refused and the pending one behind it
  did not slip through; a dry run created no tables. The initdb hook and the
  runner were then run against the same database and agreed on all six
  checksums, with the runner reporting the box up to date rather than changed.
- The whole suite runs green against one Postgres 16: **460/460**, and it is
  repeatable — three consecutive runs against the same database all pass, and
  leave `scryfall_cards`, `card_price_history`, `scryfall_bulk_imports` and
  `users` back at zero. Every file also passes alone on a fresh database. Getting
  there took serializing the files and making `import.test.ts`,
  `scryfall.test.ts` and `prices.test.ts` each clean up the mirror, price and
  bulk-import rows that hang off no user and so cascade away with nothing.

## Next

The original roadmap is done. What is left is operational or known debt:

1. First real Scryfall mirror population on the live box, then import a
   collection and leave it a fortnight — two refreshes is the point at which the
   price chart has anything to draw.
2. A password-reset flow, and an SMTP config so magic-link sign-in is exercised
   at least once.
3. `lib/prices/index.ts` is 840 lines and wants splitting along the section
   banners already in it — series, chart geometry, queries — behind a barrel.
   The constraint is that `test/prices.test.ts` loads one variable specifier
   under `--experimental-strip-types`, which does no module resolution, so the
   re-exports need explicit `.ts` extensions.

### Setting a password

There is no password-reset flow yet, and a magic-link-only user has
`password_hash` NULL by design, so a fresh account gets its first password here:

```sh
docker compose exec app node scripts/set-password.mjs you@example.com
```

Reads from a hidden prompt rather than argv, so the password does not land in
shell history or in `ps`. `--clear` removes it again. Piping also works
(`printf 'pw\n' | docker compose exec -T app node scripts/…`) but exposes it to
history.

## Known gaps

- Deleting a deck is permanent: no soft delete, no trash, no undo. That is why
  it is gated behind typing the deck's name — the app ships no client
  JavaScript, so `confirm()` is not available and the confirmation has to be a
  real page state. `deck_cards` goes with the deck via `ON DELETE CASCADE`
  (0004), and a shared deck stops resolving at `/d/<slug>` the moment the row
  goes.
- A deck's format can be changed after creation. It only selects which rules the
  validator applies and rewrites no cards; a format the select cannot represent
  (reachable only by a direct INSERT) survives a rename untouched.
- Magic-link sign-in has never been exercised — no SMTP configured.
- `card_price_history` only starts filling on the **second** refresh, because
  the first has no outgoing prices to preserve. `collection_values` falls back
  to current mirror prices until then (migration 0006), so nothing reads as
  $0.00, and `/collections/[id]/prices` says plainly that a chart has no data
  for the first week rather than drawing a flat line at zero.
- The price series does `dates x holdings` lateral lookups. Measured at the
  real shape — 1457 holdings, 52 weekly snapshots, 78,000 price rows — that is
  about 2.5s cold and 270ms warm, against 12ms for the movers list. Acceptable
  for a page nobody lands on first, and the first load after a refresh is the
  slow one.

  A composite `(scryfall_id, finish, recorded_on DESC)` index was proposed for
  this and is **not** worth adding: `card_price_history_pkey` is already
  `(scryfall_id, finish, recorded_on)`, and Postgres serves the lookup from it
  with a backward index scan, all three conditions as index conditions, in four
  buffer hits. Adding the composite measured slightly slower on the full series
  and cost 3.8 MB. Measure before adding the next one too.
- The rendered pages for browser import and price history have been verified by
  test and by build, not by eye against a running stack with real data.
