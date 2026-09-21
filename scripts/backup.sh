#!/bin/sh
# Back up the database, and prove the backup restores.
#
#   docker compose --profile backup run --rm backup
#   docker compose --profile backup run --rm backup --keep=30 --no-verify
#
# Environment:
#   DATABASE_URL   required
#   BACKUP_DIR     where dumps land (default /backups)
#
# Flags:
#   --keep=N       keep the newest N dumps, delete older ones (default 14)
#   --no-verify    skip the restore check (faster, and worth much less)
#   --no-mirror    exclude scryfall_cards, which the weekly refresh rebuilds
#   --quiet        only print the final line
#
# Exit codes: 0 on success, 1 on failure — so a cron mail arrives only when
# something actually broke.
#
# POSIX sh, not node, and it runs in the POSTGRES image rather than the app
# image: pg_dump has to match the server it dumps, and the app image is
# node:22-alpine with no Postgres client in it at all.
#
# Three decisions worth knowing:
#
# 1. **The dump is written to a temporary name and renamed only on success.**
#    A dump killed halfway — the box rebooted, the disk filled — otherwise sits
#    in the directory looking exactly like a good one, and you find out which it
#    was on the day you need it.
#
# 2. **The default is to restore it and check.** A dump nobody has ever restored
#    is a file, not a backup; the failure it hides is a dump that was never
#    readable in the first place. Verification restores into a scratch database,
#    compares row counts against the live one, and drops it again.
#
# 3. **Retention deletes by our own filename pattern**, never by globbing the
#    directory. This script must not be able to delete something a person put
#    beside its output.

set -eu

KEEP=14
VERIFY=1
MIRROR=1
QUIET=0
BACKUP_DIR="${BACKUP_DIR:-/backups}"

for arg in "$@"; do
  case "$arg" in
    --keep=*)    KEEP="${arg#--keep=}" ;;
    --no-verify) VERIFY=0 ;;
    --no-mirror) MIRROR=0 ;;
    --quiet)     QUIET=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) echo "--keep must be a whole number" >&2; exit 1 ;;
esac
[ "$KEEP" -ge 1 ] || { echo "--keep must be at least 1" >&2; exit 1; }
[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL is not set" >&2; exit 1; }

log() { [ "$QUIET" -eq 1 ] || printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
die() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PREFIX="ninetynine-"
FINAL="$BACKUP_DIR/${PREFIX}${STAMP}.dump"
PARTIAL="$FINAL.partial"

cleanup() { rm -f "$PARTIAL"; }
trap cleanup EXIT INT TERM

# --no-owner/--no-privileges so the dump restores under whatever role the target
# happens to use; a backup that only restores onto an identically-named role is
# a backup with a footnote.
set -- --format=custom --no-owner --no-privileges
if [ "$MIRROR" -eq 0 ]; then
  # scryfall_cards is a cache of a public bulk file, rebuilt weekly by the
  # refresh. Excluding it costs a refresh after restore and saves most of the
  # dump. card_price_history is NOT excluded and never should be: it is
  # snapshots that Scryfall does not keep and nothing can rebuild.
  set -- "$@" --exclude-table-data=scryfall_cards
  log "excluding scryfall_cards row data (rebuildable by the refresh)"
fi

log "dumping to $(basename "$FINAL")"
pg_dump "$@" --file="$PARTIAL" "$DATABASE_URL" || die "pg_dump failed"
[ -s "$PARTIAL" ] || die "pg_dump produced an empty file"

if [ "$VERIFY" -eq 1 ]; then
  VERIFY_DB="nn_verify_$(date -u +%s)_$$"
  # The scratch database is created on the SERVER being backed up, which is the
  # only one this script can reach. It is dropped again below, and on failure
  # the name is printed rather than silently leaked.
  ADMIN_URL=$(printf '%s' "$DATABASE_URL" | sed 's#/[^/?]*\(?.*\)\{0,1\}$#/postgres#')

  log "verifying: restoring into $VERIFY_DB"
  psql --quiet --no-psqlrc -c "CREATE DATABASE \"$VERIFY_DB\"" "$ADMIN_URL" >/dev/null \
    || die "could not create the verification database"

  VERIFY_URL=$(printf '%s' "$DATABASE_URL" | sed "s#/[^/?]*\(?.*\)\{0,1\}\$#/$VERIFY_DB#")

  # --exit-on-error: without it pg_restore reports "errors ignored on restore"
  # and still exits 0, which would let a broken dump pass verification.
  if ! pg_restore --exit-on-error --no-owner --no-privileges \
        --dbname="$VERIFY_URL" "$PARTIAL" >/dev/null 2>"$BACKUP_DIR/.verify.err"; then
    sed 's/^/    /' "$BACKUP_DIR/.verify.err" >&2 || true
    psql --quiet --no-psqlrc -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\" WITH (FORCE)" "$ADMIN_URL" >/dev/null 2>&1 || true
    rm -f "$BACKUP_DIR/.verify.err"
    die "the dump did not restore — NOT keeping it"
  fi
  rm -f "$BACKUP_DIR/.verify.err"

  # Row counts, live against restored, for the tables that hold data a person
  # would grieve. A dump that restores but arrives empty is the quiet failure
  # this catches.
  COUNT_SQL="SELECT 'users='||(SELECT count(*) FROM users)
           ||' collections='||(SELECT count(*) FROM collections)
           ||' collection_cards='||(SELECT count(*) FROM collection_cards)
           ||' decks='||(SELECT count(*) FROM decks)
           ||' deck_cards='||(SELECT count(*) FROM deck_cards)
           ||' card_price_history='||(SELECT count(*) FROM card_price_history)"
  LIVE=$(psql --quiet --no-psqlrc --tuples-only --no-align -c "$COUNT_SQL" "$DATABASE_URL")
  BACK=$(psql --quiet --no-psqlrc --tuples-only --no-align -c "$COUNT_SQL" "$VERIFY_URL")

  psql --quiet --no-psqlrc -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\" WITH (FORCE)" "$ADMIN_URL" >/dev/null

  if [ "$LIVE" != "$BACK" ]; then
    echo "  live:     $LIVE" >&2
    echo "  restored: $BACK" >&2
    die "restored row counts do not match the live database — NOT keeping this dump"
  fi
  log "verified: $LIVE"
fi

mv "$PARTIAL" "$FINAL"
trap - EXIT INT TERM
SIZE=$(wc -c < "$FINAL" | tr -d ' ')

# Retention. Our own pattern only, newest first, delete past the Nth.
DELETED=0
for old in $(ls -1 "$BACKUP_DIR" 2>/dev/null \
              | grep -E "^${PREFIX}[0-9]{8}T[0-9]{6}Z\.dump$" \
              | sort -r | tail -n +$((KEEP + 1))); do
  rm -f "$BACKUP_DIR/$old"
  DELETED=$((DELETED + 1))
  log "pruned $old"
done

KEPT=$(ls -1 "$BACKUP_DIR" 2>/dev/null | grep -cE "^${PREFIX}[0-9]{8}T[0-9]{6}Z\.dump$" || true)
printf '[%s] backup ok: %s (%s bytes), %s kept, %s pruned\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$FINAL")" "$SIZE" "$KEPT" "$DELETED"
