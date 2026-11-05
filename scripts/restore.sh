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
else
  project="$(docker compose config --format json | json_field name)"
  image="$(docker compose config --format json | json_field services.neo4j.image)"
  running="$(docker compose ps --services --status running)"
  docker compose stop api worker neo4j >/dev/null
  docker run --rm -v "${project}_neo4j-data:/data" -v "$PWD/$src:/backups:ro" "$image" \
    neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true >/dev/null
  rm -rf state && tar -xzf "$src/state.tgz"
  restore_runner_disabled
  # shellcheck disable=SC2086 # one service name per word
  [ -z "$running" ] || docker compose up -d $running >/dev/null
fi
echo "restored from $src"
