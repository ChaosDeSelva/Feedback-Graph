# shellcheck shell=bash
# Shared by backup.sh and restore.sh (sourced from the repo root, not run): which store .env configures, and how to
# reach Postgres. Values from .env are never printed: DATABASE_URL carries a password.

. scripts/lib/env.sh
. scripts/lib/json.sh

[ -f .env ] || { echo "no .env here: run ./scripts/setup.sh first" >&2; exit 1; }
STORE="$(envval STORE | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
STORE="${STORE:-neo4j}"
case "$STORE" in
  neo4j | postgres) ;;
  *) echo "STORE=$STORE in .env is neither neo4j nor postgres; fix .env first" >&2; exit 1 ;;
esac

PG_URL=""
PG_BUNDLED=""
if [ "$STORE" = postgres ]; then
  PG_URL="$(envval DATABASE_URL)"
  if [ -z "$PG_URL" ]; then
    [ -n "$(envval POSTGRES_PASSWORD)" ] || {
      echo "STORE=postgres, but .env sets neither DATABASE_URL (your own server) nor POSTGRES_PASSWORD (the bundled postgres service); nothing to connect to" >&2
      exit 1
    }
    PG_BUNDLED=1
  fi
fi

pg_target() { if [ -n "$PG_BUNDLED" ]; then echo "the bundled postgres service"; else echo "DATABASE_URL"; fi; }

PG_IMAGE="pgvector/pgvector:0.8.7-pg17"

# pg_script: a custom-format dump on stdin as a plain SQL script on stdout (no database involved).
pg_script() {
  docker run --rm -i --entrypoint pg_restore "$PG_IMAGE" --no-owner -f -
}

# pg_run <pg_dump|psql> [args...]: runs the tool against the configured database; stdin and stdout pass through.
pg_run() {
  local tool="$1"
  shift
  if [ -n "$PG_BUNDLED" ]; then
    local up
    up="$(docker compose --profile postgres up -d --wait postgres 2>&1)" || { printf '%s\n' "$up" >&2; echo "could not start the bundled postgres service" >&2; return 1; }
    docker compose --profile postgres exec -T postgres "$tool" -U fg -d feedback "$@"
  else
    # From the stack's network when it exists, so DATABASE_URL resolves as it does for the api and the worker.
    local name net=()
    name="$(docker compose config --format json | json_field name)"
    docker network inspect "${name}_default" >/dev/null 2>&1 && net=(--network "${name}_default")
    # The URL goes in through the environment, never on a command line.
    PGURL="$PG_URL" docker run --rm -i -e PGURL ${net[@]+"${net[@]}"} --add-host host.docker.internal:host-gateway \
      --entrypoint sh "$PG_IMAGE" -c 'exec "$0" -d "$PGURL" "$@"' "$tool" "$@"
  fi
}
