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
| Auth.js v5 (`auth.ts`, `lib/auth/`) | Done — password, magic link and reset all verified end-to-end over HTTP |
| API routes (`app/api/collections/`) | Done |
| Collection browser | Done — filters, infinite scroll, foil and non-foil priced apart |
| Deck editing | Done — create, rename, delete, add/remove/move, paste-import |
| Public deck share links (`/d/[slug]`) | Done — rotatable slug that survives un-sharing |
| Price history (`lib/prices/`, `/collections/[id]/prices`) | Done — value chart and movers |
| Migration runner (`lib/migrate/`, `scripts/migrate.mjs`) | Done — checksummed ledger, transactional, adopts an existing database |
| Backup and restore (`scripts/backup.sh`, `scripts/restore.sh`) | Done — every dump is restored and row-checked before it is kept |
| Demo seed (`scripts/seed-demo.mjs`) | Done — a clickable install without a 78 MB download |
| Health check (`/api/health`, `lib/health/`) | Done — compose healthcheck on the app, Caddy waits for it |

344 tests pass without a database and 507 with one; `tsc --noEmit` is clean and
`next build --webpack` is warning-free. CI (`.github/workflows/ci.yml`) holds
all three to that on every push and pull request: the suite runs twice against
one Postgres 17 and fails if any database test skips, the build fails on any
warning, and the Docker image is built and every compose profile validated.

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

### Trying it before you own any of this

A brand-new install has an empty Scryfall mirror, and the importer resolves
against that mirror — so without one, every line of an import lands in
`collection_import_issues` and the collection comes out empty, which looks
exactly like a broken importer. The real fix is a refresh, but that is a 78 MB
download of 117,620 cards before any page has anything on it.

To click around first, seed the committed fixture instead:

```sh
docker compose exec app node scripts/seed-demo.mjs you@example.com
docker compose exec app node scripts/set-password.mjs you@example.com
```

That loads 17 printings into the mirror, creates the user and a collection, and
imports the example export through the same `importCollection` the CLI and the
browser upload use — 19 printings, 48 cards, $62.17. It sets no password,
because a default one is either worth attacking or ends up in shell history.

It refuses to run if the mirror already holds cards, so it cannot mix fake
printings into a real one. There is no price history and there cannot be: that
only accumulates from real refreshes a week apart.

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

`lib/prices/` is four modules behind a barrel: `series.ts` for windows, money
and the value series, `chart.ts` for plot coordinates and the movers' bar
lengths, `movers.ts` for what moved between two snapshots, and `queries.ts` for
the SQL and its loaders. Nothing in there imports anything at runtime from
outside `lib/prices`, and the files reach each other with an explicit `.ts`
extension, because `test/prices.test.ts` loads the barrel through a variable
specifier under `--experimental-strip-types`, which does no module resolution.
An extensionless specifier typechecks perfectly and then dies at runtime with
`ERR_MODULE_NOT_FOUND`.

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

A **fresh** database needs none of this. `db/migrations/zzz_record_baseline.sh`
sits in the same directory as the migrations, sorts after them, and records what
init just applied, so a new install comes up already reconciled. It is in that
directory rather than mounted on top of it because a file bind-mounted inside a
read-only directory mount fails on first boot. Its checksums are `sha256sum`
over the same bytes `lib/migrate/` hashes with `createHash`; a test pins the two
to the same known value, because if they ever disagree every fresh install
reports all its migrations as edited-since-applied. `.gitattributes` forces LF
for the same reason — a Windows checkout with CRLF would hash differently.

## Backups

```sh
docker compose --profile backup run --rm backup
```

Writes `data/backups/ninetynine-<timestamp>.dump` and keeps the newest 14.
Weekly, from the same cron as the Scryfall refresh, is the intended cadence.

**Every dump is restored before it is kept.** The script dumps to a temporary
name, restores that into a scratch database, compares row counts for the tables
holding data you would grieve, drops the scratch database, and only then renames
the file into place. A dump that will not restore is reported and deleted rather
than left sitting in the directory looking exactly like one that will — which is
the failure this whole section exists to prevent, and the reason "we have
nightly dumps" is not the same sentence as "we have backups". `--no-verify`
skips it and is worth much less.

`--keep=N` changes retention. Pruning matches only this script's own filename
pattern, so nothing you put in that directory by hand is ever deleted by it.

`--no-mirror` excludes `scryfall_cards` row data, which the weekly refresh
rebuilds from a public bulk file. It makes the dump far smaller at the cost of
one refresh after a restore. `card_price_history` is never excluded and never
should be: those are snapshots Scryfall does not keep and nothing can rebuild.

### Restoring

```sh
docker compose stop app
docker compose --profile backup run --rm restore --list
docker compose --profile backup run --rm restore --file=ninetynine-<timestamp>.dump
docker compose start app
```

Stop the app first, or requests read half-restored tables.

The restore refuses if the target already holds this app's schema, and prints
the drop-and-recreate command rather than running it. Dropping a database is the
one irreversible step in the story, and a script that does it for you is a
script that eventually does it on the wrong box. `--force` skips the check.

A dump carries `schema_migrations` with it, so a restored database is already
reconciled and `migrate` reports it up to date rather than trying to reapply
anything.

**Verified end to end, not just written:** a 500-card mirror with 400 collection
rows, a 99-card deck and 1600 price snapshots dumped, restored into an empty
database, and compared table by table — identical, ledger included. A dump with
a corrupted byte fails `pg_restore --exit-on-error` and is refused. Retention
pruned 3 of 5 dumps while leaving an unrelated file and a hand-renamed dump
untouched.

## Health

`GET /api/health` answers `200 {"ok":true}` when the app can run `SELECT 1`
through its own connection pool within two seconds, and `503 {"ok":false}` when
it cannot. The `app` service's compose healthcheck polls it every 30 seconds, so
`docker compose ps` shows `healthy` or `unhealthy` rather than just `Up`:

```sh
docker compose ps app
docker inspect --format '{{json .State.Health}}' ninetynine-app
```

The check goes through the pool on purpose. The ways this app goes wrong
without exiting — every pooled connection stuck, an event loop pinned, the
database gone from under a server that is still listening — all still accept
TCP, so a check that only asked "is the port open" would pass every one of them.

The endpoint is unauthenticated, because Docker's probe has no session. It is
outside the `proxy.ts` matcher rather than exempted from it, so the auth
boundary did not move. For the same reason the body is a boolean and nothing
else: why a check failed goes to the app's log as
`health: database check failed (timeout|error)`, never into the response.

The probe is `node -e` with `fetch`, because the runtime image has no curl or
wget. It lives in `docker-compose.yml` and deliberately **not** in the
Dockerfile: the same image runs the `migrate` and `scryfall-refresh` one-shots,
which never start a server and would all be marked unhealthy.

With the Caddy override, Caddy waits for the app to be **healthy**, not merely
started, so it does not come up serving 502s in front of an app that is still
booting or has no database.

**What it does not do: restart anything.** Plain Docker records a container as
unhealthy and leaves it running; only Swarm acts on health. `restart:
unless-stopped` still restarts on exit alone. Automatic recovery from a wedged
app needs something that watches health status and restarts on it, such as an
autoheal container with access to the Docker socket, which this stack does not
ship — handing a container the Docker socket is root on the host.

Because the check depends on the database, a Postgres outage marks the app
unhealthy too. That is accurate — every page needs the database — but it means
`unhealthy` on the app is a reason to look at `db` first.

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
- Backup and restore, against Postgres with real-shaped data: a dump restored
  into an empty database matches the original table by table including
  `schema_migrations`; a dump with one corrupted byte is refused by
  `pg_restore --exit-on-error`; retention pruned 3 of 5 dumps and left an
  unrelated file and a hand-renamed dump alone.
- Password reset, over HTTP against a running stack: a mixed-case address
  reaches the lowercase row; a request for an unknown address returns the same
  redirect in about the same time (707ms vs 718ms, padded by a floor); the
  emailed link sets a new password, the old one stops working, and re-opening
  the link reports it spent.
- **Magic-link sign-in, exercised for the first time in this project's life**,
  against a capture directory rather than a mail server: the provider appears in
  `/api/auth/providers`, the mail is captured, the callback sets a session,
  `/collections` serves 200, and a second use of the link fails with
  `Verification`. Completing that flow found a real bug — `pages.verifyRequest`
  was concatenated with Auth.js's own query string into `/signin?sent=1?provider=…`,
  so the "check your email" notice never rendered. Fixed. TLS, SMTP AUTH and
  deliverability remain unexercised; the SMTP wire path itself is covered by a
  fake SMTP server in `test/reset.test.ts`.
- The migration runner was exercised against Postgres 16 on every path that
  matters: the real migrations applied to an empty database and produced all 13
  tables plus the ledger; a second run applied nothing; a migration that fails
  mid-file rolled its schema back and recorded nothing, leaving the one before
  it committed; an edited migration was refused and the pending one behind it
  did not slip through; a dry run created no tables. The initdb hook and the
  runner were then run against the same database and agreed on all six
  checksums, with the runner reporting the box up to date rather than changed.
- The whole suite runs green against one Postgres 16: **496/496**, and it is
  repeatable — three consecutive runs against the same database all pass, and
  leave `scryfall_cards`, `card_price_history`, `scryfall_bulk_imports` and
  `users` back at zero. Every file also passes alone on a fresh database. Getting
  there took serializing the files and making `import.test.ts`,
  `scryfall.test.ts` and `prices.test.ts` each clean up the mirror, price and
  bulk-import rows that hang off no user and so cascade away with nothing.
  With the health check's tests added it is 507/507, twice in a row.
- The health check, against `.next/standalone` and a migrated Postgres 16, with
  the healthcheck's argv taken verbatim from `docker-compose.yml`: database up,
  200 and exit 0; every Postgres process frozen with `SIGSTOP`, 503 and exit 1
  in 2.1s, the route's timeout rather than the probe's; Postgres stopped, 503
  and exit 1 in about 100ms; Postgres started again, 200 with no app restart.
  The 503 body is `{"ok":false}` and nothing more, and the compiled proxy
  matchers do not match `/api/health`.

## Next

The original roadmap is done. What is left is operational or known debt:

1. First real Scryfall mirror population on the live box, then import a
   collection and leave it a fortnight — two refreshes is the point at which the
   price chart has anything to draw. This is also the only way to see the import
   and price pages rendered against real data, which nothing has done yet.

### Email

Magic-link sign-in and password reset share one mail setting and appear
together. Both stay off unless `EMAIL_FROM` is set **and** there is somewhere to
send:

- `SMTP_URL=smtp://user:pass@host:587`, or the separate `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS` and `SMTP_SECURE`.
- `MAIL_CAPTURE_DIR=/data/mail` — no SMTP server at all. Every message is written
  there as an `.eml` file and nothing is dialled; the app logs the file path,
  never the link, because container logs get read by people the mail was not
  sent to. This is how to exercise either flow on a box with no mail server,
  which is most of them. SMTP wins if both are set.

Links in mail are built from `AUTH_URL`, **never** from the request's `Host`
header. A request carrying someone else's `Host` would otherwise mail a real
user a link pointing at an attacker's server, which is the classic way this
feature leaks accounts. With `AUTH_URL` unset, nothing is sent.

### Forgotten passwords

"Forgot your password?" on the sign-in page mails a single-use link that expires
in an hour. It needs mail configured; with none, the page says so and points at
the command below instead.

Requesting a reset issues one link per account, so asking again kills the
previous one, and completing a reset invalidates every outstanding link for that
user. Only a SHA-256 of the token is stored, so a database dump yields no
working link. Sessions are JWTs, so a reset does **not** sign other devices out;
they expire on their own. Revoking them would mean a database read on every
guarded request, which is the thing the JWT strategy exists to avoid.

### Setting a password

A magic-link-only user has `password_hash` NULL by design, and an account
created outside the sign-up form has no password at all, so both get their first
one here:

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
  test and by build, not by eye against a running stack with real data. The auth
  and reset pages are the exception: those were driven over HTTP.
- A wedged app is now **reported** — the `app` healthcheck marks it
  `unhealthy` — but not restarted. Plain Docker does not act on health, and
  `restart: unless-stopped` still only sees exits. See [Health](#health).
- The healthcheck itself has been run against the standalone server, not inside
  a container: there has been no Docker daemon to run `docker compose up` with
  it.
- The database tests share one database, must run serially, and each file has to
  delete the rows it wrote. Three files have had to be fixed for forgetting.
  Correctness there is the test author's job rather than a property of the
  setup; a database per file, or a transaction rolled back per test, would make
  it structural.
