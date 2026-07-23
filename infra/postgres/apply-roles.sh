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

# During first-time PostgreSQL initialization, the temporary bootstrap server
# can become healthy immediately before the entrypoint stops it and starts the
# final server.  psql reports that connection-only window with exit status 2.
# Retry only that status: exit 1 (psql/client failure) and exit 3
# (ON_ERROR_STOP SQL failure) must remain fail-fast and must never be hidden.
attempt=1
max_connect_attempts=30
retry_delay_seconds=1

while :; do
  if psql \
    --host "$POSTGRES_HOST" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=ON_ERROR_STOP=1 \
    --set=migrator_password="$MIGRATOR_PASSWORD" \
    --set=api_password="$API_PASSWORD" \
    --set=worker_password="$WORKER_PASSWORD" \
    --set=require_rls_disabled="$REQUIRE_RLS_DISABLED" \
    --file=/opt/ailearn/roles.sql
  then
    exit 0
  else
    status=$?
  fi

  if [ "$status" -ne 2 ]; then
    exit "$status"
  fi
  if [ "$attempt" -ge "$max_connect_attempts" ]; then
    echo >&2 "psql connection failed after $attempt attempts"
    exit 2
  fi

  echo >&2 "psql connection unavailable; retrying in ${retry_delay_seconds}s ($attempt/$max_connect_attempts)"
  attempt=$((attempt + 1))
  sleep "$retry_delay_seconds"
done
