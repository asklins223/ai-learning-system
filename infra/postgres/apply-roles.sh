#!/bin/sh
set -eu

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${MIGRATOR_PASSWORD:?MIGRATOR_PASSWORD is required}"
: "${API_PASSWORD:?API_PASSWORD is required}"
: "${WORKER_PASSWORD:?WORKER_PASSWORD is required}"
: "${REQUIRE_RLS_DISABLED:=false}"

# Keep passwords out of the SQL file.  psql's :'variable' quoting handles
# spaces, quotes, and URL-like punctuation without shell interpolation.
export PGPASSWORD="$POSTGRES_PASSWORD"
exec psql \
  --host "$POSTGRES_HOST" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=migrator_password="$MIGRATOR_PASSWORD" \
  --set=api_password="$API_PASSWORD" \
  --set=worker_password="$WORKER_PASSWORD" \
  --set=require_rls_disabled="$REQUIRE_RLS_DISABLED" \
  --file=/opt/ailearn/roles.sql
