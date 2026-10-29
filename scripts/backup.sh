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
  mkdir -p "$out"
  chmod 700 "$out"
  running="$(docker compose ps --services --status running)"
  echo "stopping the stack for a consistent dump"
  docker compose stop api worker neo4j >/dev/null
  trap 'echo "restarting"; [ -n "$running" ] && docker compose up -d >/dev/null' EXIT
  docker run --rm -v "${project}_neo4j-data:/data" -v "$PWD/$out:/backups" "$image" \
    neo4j-admin database dump neo4j --to-path=/backups >/dev/null
  tar --exclude='state/settings/redaction-archive/key' --exclude='state/redaction-key' -czf "$out/state.tgz" state
  echo neo4j > "$out/STORE"
  ( cd "$out" && shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS )
fi
echo "backup written to $out ($(du -sh "$out" | cut -f1))"
