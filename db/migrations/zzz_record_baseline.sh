#!/bin/sh
# Record the migrations /docker-entrypoint-initdb.d just ran.
#
# Postgres applies everything in that directory in filename order, on first
# init only, and keeps no record of having done so. Without this, a brand-new
# database comes up with all six migrations applied and an empty ledger — and
# `scripts/migrate.mjs` meeting that box has to refuse, because it cannot tell
# a fresh install apart from one that is genuinely six migrations behind.
#
# The `zzz_` prefix is load-bearing: this must sort after every `NNNN_*.sql`
# beside it, or it records migrations that have not run yet.
#
# It lives in db/migrations/ beside the files it records, rather than being
# mounted on top of that directory — see the comment on the mount in
# docker-compose.yml for why nesting fails. The runner ignores it: its name does
# not match NNNN_label.sql.
#
# The checksum must match what lib/migrate/index.mjs computes, or the very next
# `migrate` run reports all six as edited-since-applied. Both are sha256 over
# the file's bytes, hex — `sha256sum` here, `createHash("sha256")` there.

# `-e` only, not `-eu`. The postgres entrypoint EXECUTES an init script that is
# executable and SOURCES one that is not — and a checkout that lost its exec bit
# gets sourced. Sourced, `set -u` would leak into the entrypoint's own shell and
# can abort it later on a variable it deliberately leaves unset.
set -e

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/docker-entrypoint-initdb.d}"

# Same DDL as MIGRATIONS_TABLE_SQL in lib/migrate/index.mjs. Duplicated because
# this runs inside the postgres image with no access to the app's code; if one
# changes, change both.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  label       TEXT        NOT NULL,
  checksum    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER     NOT NULL
);
SQL

recorded=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$file" ] || continue
  base=$(basename "$file")

  # Mirror of MIGRATION_FILENAME: NNNN_label.sql, lowercase label. Anything
  # else in the directory is not a migration and is not recorded as one.
  version=$(printf '%s' "$base" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)_[a-z0-9][a-z0-9_]*\.sql$/\1/p')
  label=$(printf '%s' "$base" | sed -n 's/^[0-9][0-9][0-9][0-9]_\([a-z0-9][a-z0-9_]*\)\.sql$/\1/p')
  [ -n "$version" ] || continue

  sum=$(sha256sum "$file" | cut -d' ' -f1)

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v version="$version" -v label="$label" -v checksum="$sum" <<'SQL'
INSERT INTO schema_migrations (version, label, checksum, duration_ms)
VALUES (:'version', :'label', :'checksum', 0)
ON CONFLICT (version) DO NOTHING;
SQL

  recorded=$((recorded + 1))
done

echo "recorded $recorded migration(s) in schema_migrations"
