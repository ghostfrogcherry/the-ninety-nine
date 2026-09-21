#!/bin/sh
# Restore a dump made by scripts/backup.sh.
#
#   docker compose --profile backup run --rm restore --file=ninetynine-20260918T031500Z.dump
#   docker compose --profile backup run --rm restore --list
#
# Environment:
#   DATABASE_URL   required — the database to restore INTO
#   BACKUP_DIR     where dumps live (default /backups)
#
# Flags:
#   --file=NAME    the dump to restore, relative to BACKUP_DIR (or an absolute path)
#   --list         list available dumps and exit
#   --force        restore even though the target already holds data
#
# Stop the app first. Restoring under a running app means requests reading
# half-restored tables, and Postgres will not let the database be dropped while
# it holds connections:
#
#   docker compose stop app
#   docker compose --profile backup run --rm restore --file=…
#   docker compose start app
#
# This script deliberately does NOT drop and recreate the database. Dropping is
# the one irreversible step in the whole story, and a script that does it on
# your behalf is a script that eventually does it on the wrong box. If the
# target is not empty it refuses and prints the command, so the destructive act
# stays a thing a person typed.

set -eu

FILE=""
LIST=0
FORCE=0
BACKUP_DIR="${BACKUP_DIR:-/backups}"

for arg in "$@"; do
  case "$arg" in
    --file=*) FILE="${arg#--file=}" ;;
    --list)   LIST=1 ;;
    --force)  FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
die() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2; exit 1; }

if [ "$LIST" -eq 1 ]; then
  ls -1sh "$BACKUP_DIR" 2>/dev/null | grep -E "ninetynine-[0-9]{8}T[0-9]{6}Z\.dump$" \
    || echo "no dumps in $BACKUP_DIR"
  exit 0
fi

[ -n "$FILE" ] || die "pass --file=NAME (or --list to see what is there)"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"

case "$FILE" in
  /*) DUMP="$FILE" ;;
   *) DUMP="$BACKUP_DIR/$FILE" ;;
esac
[ -f "$DUMP" ] || die "no such dump: $DUMP"

# Refuse to restore over live data unless told twice. `users` is migration
# 0001's first table, the same probe the migration runner uses for "is this
# database ours and already built".
#
# Two queries, not one CASE. Postgres resolves every relation named in a
# statement when it plans it, so a single
# `CASE WHEN to_regclass(...) IS NULL THEN 'empty' ELSE (SELECT count(*) FROM users) END`
# fails outright on the empty database it was written to detect — the branch
# never runs, but the name still has to resolve.
PRESENT=$(psql --quiet --no-psqlrc --tuples-only --no-align \
  -c "SELECT to_regclass('public.users') IS NOT NULL" "$DATABASE_URL" 2>/dev/null || echo "unreachable")

if [ "$PRESENT" = "unreachable" ]; then
  die "cannot reach the target database"
fi

if [ "$PRESENT" = "t" ]; then
  EXISTING=$(psql --quiet --no-psqlrc --tuples-only --no-align \
    -c "SELECT count(*) FROM users" "$DATABASE_URL")
else
  EXISTING="empty"
fi

if [ "$EXISTING" != "empty" ] && [ "$FORCE" -eq 0 ]; then
  echo "The target already has this app's schema ($EXISTING users)." >&2
  echo "" >&2
  echo "Restoring on top of it will conflict on every existing object. Either" >&2
  echo "point DATABASE_URL at an empty database, or drop and recreate this one" >&2
  echo "yourself — with the app stopped:" >&2
  echo "" >&2
  echo "  docker compose stop app" >&2
  echo "  docker compose exec db psql -U \$POSTGRES_USER -d postgres \\" >&2
  echo "    -c 'DROP DATABASE \$POSTGRES_DB WITH (FORCE)' -c 'CREATE DATABASE \$POSTGRES_DB'" >&2
  echo "" >&2
  echo "Then run this again. Pass --force to skip this check." >&2
  exit 1
fi

log "restoring $(basename "$DUMP")"
# --exit-on-error so a partial restore fails loudly rather than leaving a
# database that is most of your collection and silently missing a table.
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="$DATABASE_URL" "$DUMP" || die "pg_restore failed — the target is now partial, do not start the app against it"

COUNTS=$(psql --quiet --no-psqlrc --tuples-only --no-align -c \
  "SELECT 'users='||(SELECT count(*) FROM users)
        ||' collections='||(SELECT count(*) FROM collections)
        ||' collection_cards='||(SELECT count(*) FROM collection_cards)
        ||' decks='||(SELECT count(*) FROM decks)
        ||' deck_cards='||(SELECT count(*) FROM deck_cards)
        ||' card_price_history='||(SELECT count(*) FROM card_price_history)
        ||' scryfall_cards='||(SELECT count(*) FROM scryfall_cards)" "$DATABASE_URL")

log "restored: $COUNTS"

MIRROR=$(printf '%s' "$COUNTS" | sed -n 's/.*scryfall_cards=\([0-9]*\).*/\1/p')
if [ "${MIRROR:-0}" -eq 0 ]; then
  log "the Scryfall mirror is empty — this dump was made with --no-mirror."
  log "run the refresh before the collection will resolve card names:"
  log "  docker compose --profile refresh run --rm scryfall-refresh"
fi

log "done — start the app: docker compose start app"
