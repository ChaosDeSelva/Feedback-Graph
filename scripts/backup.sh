#!/usr/bin/env bash
# Back up the store and the worker's state into ./backups/<timestamp>/, for the STORE in .env:
#   neo4j (default): a Neo4j dump. Neo4j Community can only dump a stopped database, so the stack stops for the minute this takes.
#   postgres:        pg_dump -Fc of the bundled postgres service, or of DATABASE_URL. Nothing stops.
# Restore with ./scripts/restore.sh backups/<timestamp>.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
. scripts/lib/store.sh

out="backups/$(date -u +%Y%m%dT%H%M%SZ)"
complete=0
cleanup_incomplete() {
  if [ "$complete" != 1 ] && [ -d "$out" ]; then
    rm -rf -- "$out"
    echo "backup failed; incomplete output removed" >&2
  fi
}
trap cleanup_incomplete EXIT
compose_json="$(docker compose config --format json)"
project="$(printf '%s' "$compose_json" | json_field name)"

if [ "$STORE" = postgres ]; then
  mkdir -p "$out"
  chmod 700 "$out"
  echo "dumping Postgres ($(pg_target)) while everything keeps running"
  if ! pg_run pg_dump --format=custom --no-owner > "$out/postgres.dump"; then
    rm -rf "$out"
    echo "pg_dump failed; no backup written" >&2
    exit 1
  fi
  tar --exclude='state/settings/redaction-archive/key' --exclude='state/redaction-key' -czf "$out/state.tgz" state
  echo postgres > "$out/STORE"
  ( cd "$out" && shasum -a 256 postgres.dump state.tgz STORE > SHA256SUMS )
else
  image="$(printf '%s' "$compose_json" | json_field services.neo4j.image)"
  neo4j_volume="$(printf '%s' "$compose_json" | json_field volumes.neo4j-data.name)"
  [ -n "$neo4j_volume" ] || neo4j_volume="${project}_neo4j-data"
  mkdir -p "$out"
  chmod 700 "$out"
  running="$(docker compose ps --services --status running)"
  dump_container="${project}_neo4j-backup-$$"
  echo "stopping the stack for a consistent dump"
  docker compose stop api worker neo4j >/dev/null
  restart_stack() {
    docker rm -f "$dump_container" >/dev/null 2>&1 || true
    echo "restarting"
    # shellcheck disable=SC2086 # one service name per word, captured from compose ps
    [ -z "$running" ] || docker compose up -d --wait --wait-timeout 120 $running >/dev/null
  }
  trap 'restart_stack; cleanup_incomplete' EXIT
  # Do not bind the owner-only backup directory into the image: the image intentionally drops to its unprivileged
  # neo4j user, which cannot traverse a host directory created with mode 0700. Keep the dump in the short-lived
  # container and let the Docker daemon copy the completed file to the host instead.
  docker create --name "$dump_container" -v "$neo4j_volume:/data" "$image" \
    neo4j-admin database dump neo4j --to-path=/tmp >/dev/null
  docker start -a "$dump_container" >/dev/null
  docker cp "$dump_container:/tmp/neo4j.dump" "$out/neo4j.dump"
  docker rm "$dump_container" >/dev/null
  tar --exclude='state/settings/redaction-archive/key' --exclude='state/redaction-key' -czf "$out/state.tgz" state
  echo neo4j > "$out/STORE"
  ( cd "$out" && shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS )
fi
complete=1
echo "backup written to $out ($(du -sh "$out" | cut -f1))"
