#!/bin/sh
# Build-time reference from the pinned PostgreSQL/Goose binaries and SQL bytes.
set -eu
cd /migrations
base=$(mktemp -d)
trap 'pg_ctl -D "$base/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$base"' EXIT
initdb -A trust --no-locale -E UTF8 -D "$base/data" >/dev/null
pg_ctl -D "$base/data" -o "-k $base -c listen_addresses=''" -w start >/dev/null
export PGHOST="$base"
for owner in auth problem submission; do
    PGDATABASE="${owner}_db"
    createdb "$PGDATABASE"
    export PGDATABASE
    target=$(cat "$owner.version")
    version=0
    while [ "$version" -le "$target" ]; do
        if [ "$version" -gt 0 ]; then
            goose -dir "$owner" postgres "dbname=$PGDATABASE" up-to "$version"
        fi
        psql -XqAtv ON_ERROR_STOP=1 -f /platform/catalog.sql > "$owner.$version.catalog"
        version=$((version + 1))
    done
done
