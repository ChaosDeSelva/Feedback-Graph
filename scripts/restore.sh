#!/usr/bin/env bash
# Restore a backup made by backup.sh. This REPLACES the current store (Neo4j or Postgres, as STORE in .env says) and
# the worker state.
#   ./scripts/restore.sh backups/20261022T120000Z      (FORCE=1 skips the question)
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:?usage: restore.sh backups/<timestamp>}"
. scripts/lib/store.sh

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
  # shellcheck disable=SC2086 # one service name per word
  [ -z "$running" ] || docker compose up -d $running >/dev/null
else
  project="$(docker compose config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).name))')"
  image="$(docker compose config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).services.neo4j.image))')"
  docker compose stop api worker neo4j >/dev/null
  docker run --rm -v "${project}_neo4j-data:/data" -v "$PWD/$src:/backups:ro" "$image" \
    neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true >/dev/null
  rm -rf state && tar -xzf "$src/state.tgz"
  docker compose up -d >/dev/null
fi
echo "restored from $src"
