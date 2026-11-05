#!/usr/bin/env bash
# Restore a backup made by backup.sh. This REPLACES the current store (Neo4j or Postgres, as STORE in .env says) and
# the worker state.
#   ./scripts/restore.sh backups/20261022T120000Z      (FORCE=1 skips the question)
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:?usage: restore.sh backups/<timestamp>}"
. scripts/lib/store.sh

# A safety decision made after the backup must survive restoring older worker state. Keep it outside the archive while
# state is replaced, then put it back with owner-only permissions.
runner_disabled=""
runner_disabled_path="state/runner-control/codex-runner-disabled"
if [ -f "$runner_disabled_path" ]; then
  runner_disabled="$(mktemp)"
  cp "$runner_disabled_path" "$runner_disabled"
  chmod 600 "$runner_disabled"
elif [ -f state/settings/codex-runner-disabled ]; then
  runner_disabled="$(mktemp)"
  cp state/settings/codex-runner-disabled "$runner_disabled"
  chmod 600 "$runner_disabled"
fi
restore_runner_disabled() {
  [ -n "$runner_disabled" ] || return 0
  mkdir -p state/runner-control
  cp "$runner_disabled" "$runner_disabled_path"
  chmod 600 "$runner_disabled_path"
  rm -f "$runner_disabled"
  runner_disabled=""
}
trap restore_runner_disabled EXIT

if [ -f "$src/postgres.dump" ]; then kind=postgres
elif [ -f "$src/neo4j.dump" ]; then kind=neo4j
else echo "no neo4j.dump or postgres.dump in $src" >&2; exit 1
fi
[ "$kind" = "$STORE" ] || { echo "$src is a $kind backup but .env has STORE=$STORE; restore it into a $kind install (or change STORE)" >&2; exit 1; }
[ -f "$src/state.tgz" ] || { echo "no state.tgz in $src" >&2; exit 1; }
( cd "$src" && shasum -a 256 -c SHA256SUMS >/dev/null ) || { echo "checksum mismatch in $src; not restoring" >&2; exit 1; }

if [ "${FORCE:-}" != "1" ]; then
  read -r -p "Replace the current $STORE store and worker state with $src? Type 'restore' to continue: " ok
  [ "$ok" = "restore" ] || { echo "cancelled"; exit 1; }
fi

if [ "$kind" = postgres ]; then
  # Nothing may write while the tables are replaced; the database itself keeps running.
  running="$(docker compose ps --services --status running | grep -E '^(api|worker)$' || true)"
  docker compose stop api worker >/dev/null
  echo "restoring Postgres ($(pg_target))"
  # The schema as it was, exactly: tables a later migration added go too (else that migration would not run again).
  # One transaction: if any of it fails, the database is left as it was.
  { printf 'SET client_min_messages = warning;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n'; pg_script < "$src/postgres.dump"; } |
    pg_run psql -X -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null
  rm -rf state && tar -xzf "$src/state.tgz"
  restore_runner_disabled
  # shellcheck disable=SC2086 # one service name per word
  [ -z "$running" ] || docker compose up -d $running >/dev/null
  core="$(printf '%s\n' $running | grep -E '^(api|worker|postgres)$' || true)"
  # shellcheck disable=SC2086 # one service name per word
  [ -z "$core" ] || docker compose up -d --no-deps --wait --wait-timeout 120 $core >/dev/null
else
  compose_json="$(docker compose config --format json)"
  project="$(printf '%s' "$compose_json" | json_field name)"
  image="$(printf '%s' "$compose_json" | json_field services.neo4j.image)"
  neo4j_volume="$(printf '%s' "$compose_json" | json_field volumes.neo4j-data.name)"
  [ -n "$neo4j_volume" ] || neo4j_volume="${project}_neo4j-data"
  # docker create would otherwise make an unlabeled named volume when restoring a fresh install. Compose then warns
  # that the volume is foreign on every subsequent `up`; create it with the ownership labels Compose itself uses.
  if ! docker volume inspect "$neo4j_volume" >/dev/null 2>&1; then
    docker volume create --label "com.docker.compose.project=$project" --label 'com.docker.compose.volume=neo4j-data' "$neo4j_volume" >/dev/null
  fi
  running="$(docker compose ps --services --status running)"
  docker compose stop api worker neo4j >/dev/null
  load_container="${project}_neo4j-restore-$$"
  load_log="$(mktemp)"
  cleanup_load_container() {
    docker rm -f "$load_container" >/dev/null 2>&1 || true
    rm -f "$load_log"
  }
  trap 'cleanup_load_container; restore_runner_disabled' EXIT
  # The backup folder is owner-only. Copy the archive through the Docker daemon instead of bind-mounting it into the
  # unprivileged Neo4j image; this also works when the caller supplies an absolute backup path.
  # Bound the offline admin JVM as well as the server. Auto-sizing can overcommit a small Docker host when another
  # project is running Neo4j, causing a silent restore failure.
  docker create --name "$load_container" -e "HEAP_SIZE=${NEO4J_ADMIN_HEAP_SIZE:-256m}" -v "$neo4j_volume:/data" "$image" \
    neo4j-admin database load neo4j --from-path=/tmp --overwrite-destination=true >/dev/null
  docker cp "$src/neo4j.dump" "$load_container:/tmp/neo4j.dump"
  if ! docker start -a "$load_container" >"$load_log" 2>&1; then
    cat "$load_log" >&2
    exit 1
  fi
  docker rm "$load_container" >/dev/null
  rm -f "$load_log"
  rm -rf state && tar -xzf "$src/state.tgz"
  restore_runner_disabled
  # shellcheck disable=SC2086 # one service name per word
  [ -z "$running" ] || docker compose up -d --no-deps $running >/dev/null
  core="$(printf '%s\n' $running | grep -E '^(api|worker|neo4j)$' || true)"
  # shellcheck disable=SC2086 # one service name per word
  [ -z "$core" ] || docker compose up -d --no-deps --wait --wait-timeout 120 $core >/dev/null
fi
echo "restored from $src"
