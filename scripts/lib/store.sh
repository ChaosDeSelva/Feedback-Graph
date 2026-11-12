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

check_instance_env
COMPOSE=(docker compose -p "$(fg_instance)")

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

# This install's Compose project: the containers backup.sh and restore.sh run carry its label.
FG_PROJECT="$(fg_instance)"
# Containers under this name that another folder started are that folder's install: a backup here would stop and dump
# it (and start it again with this folder's mounts), a restore would load this folder's backup into it.
foreign="$(foreign_install_dir "$FG_PROJECT")"
if [ -n "$foreign" ]; then
  echo "the containers named $FG_PROJECT were started from $foreign, not this folder ($PWD): $(basename "$0") here would act on that install and its data." >&2
  echo "  Run it from $foreign, or give this folder its own FG_INSTANCE and ports in .env (./scripts/setup.sh --help)." >&2
  exit 1
fi

# The labels of the one-off containers backup.sh and restore.sh run: in this install's Compose project, from this folder,
# as docker compose run labels its own, so a leftover one says whose it is.
oneoff_labels=(--label "com.docker.compose.project=$FG_PROJECT" --label "com.docker.compose.project.working_dir=$PWD" --label com.docker.compose.oneoff=True)

pg_target() { if [ -n "$PG_BUNDLED" ]; then echo "the bundled postgres service"; else echo "DATABASE_URL"; fi; }

PG_IMAGE="pgvector/pgvector:0.8.7-pg17"

# Throwaway Postgres-image containers: in the Compose project, and the image's data volume a tmpfs, not an anonymous one.
# Each has one name per install, so one a killed backup or restore left (created, never started) is removed by
# pg_clear at the next run.
pg_tool=(--rm -i "${oneoff_labels[@]}" --label com.docker.compose.service=postgres --mount type=tmpfs,dst=/var/lib/postgresql/data)
pg_clear() { docker rm -f "$FG_PROJECT-pg-script" "$FG_PROJECT-pg-run" >/dev/null 2>&1 || true; }

# pg_script: a custom-format dump on stdin as a plain SQL script on stdout (no database involved).
pg_script() {
  docker run "${pg_tool[@]}" --name "$FG_PROJECT-pg-script" --entrypoint pg_restore "$PG_IMAGE" --no-owner -f -
}

# pg_df: df -Pk of the bundled postgres service's data folder (started if it is not running).
pg_df() {
  local up
  up="$("${COMPOSE[@]}" --profile postgres up -d --wait postgres 2>&1)" || { printf '%s\n' "$up" >&2; echo "could not start the bundled postgres service" >&2; return 1; }
  "${COMPOSE[@]}" --profile postgres exec -T postgres df -Pk /var/lib/postgresql/data
}

# pg_run <pg_dump|psql> [args...]: runs the tool against the configured database; stdin and stdout pass through.
pg_run() {
  local tool="$1"
  shift
  if [ -n "$PG_BUNDLED" ]; then
    local up
    up="$("${COMPOSE[@]}" --profile postgres up -d --wait postgres 2>&1)" || { printf '%s\n' "$up" >&2; echo "could not start the bundled postgres service" >&2; return 1; }
    "${COMPOSE[@]}" --profile postgres exec -T postgres "$tool" -U fg -d feedback "$@"
  else
    # From the stack's network when it exists, so DATABASE_URL resolves as it does for the api and the worker.
    local net=()
    docker network inspect "${FG_PROJECT}_default" >/dev/null 2>&1 && net=(--network "${FG_PROJECT}_default")
    # The URL goes in through the environment, never on a command line.
    PGURL="$PG_URL" docker run "${pg_tool[@]}" --name "$FG_PROJECT-pg-run" -e PGURL ${net[@]+"${net[@]}"} --add-host host.docker.internal:host-gateway \
      --entrypoint sh "$PG_IMAGE" -c 'exec "$0" -d "$PGURL" "$@"' "$tool" "$@"
  fi
}
