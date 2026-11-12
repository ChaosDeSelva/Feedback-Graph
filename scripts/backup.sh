#!/usr/bin/env bash
# Back up the store and the worker's state into ./backups/<timestamp>/, for the STORE in .env:
#   neo4j (default): a Neo4j dump. Neo4j Community can only dump a stopped database, so the stack stops for the minute this takes.
#   postgres:        pg_dump -Fc of the bundled postgres service, or of DATABASE_URL. Nothing stops.
# Restore with ./scripts/restore.sh backups/<timestamp>.
set -euo pipefail
# The Compose project is this checkout's (FG_INSTANCE and COMPOSE_FILE from its .env): a shell's own value would point
# docker compose at another install's containers.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE
umask 077
cd "$(dirname "$0")/.."
. scripts/lib/store.sh
. scripts/lib/restore-journal.sh

# A backup now would capture whatever an unfinished restore left, perhaps a store and a worker state that do not match.
case "$(restore_status)" in
  none) ;;
  # It stopped and replaced nothing: what is backed up is what the stack runs on.
  untouched) restore_interrupted untouched >&2 ;;
  running) echo "a restore (pid $(journal_get pid)) is running here; back up once it has finished" >&2; exit 1 ;;
  damaged) restore_damaged >&2; echo "  Not backing up until then." >&2; exit 1 ;;
  *) restore_interrupted "$(restore_status)" >&2; echo "  Not backing up until then." >&2; exit 1 ;;
esac

out="backups/$(date -u +%Y%m%dT%H%M%SZ)"
complete=0
cleanup_incomplete() {
  if [ "$complete" != 1 ] && [ -d "$out" ]; then
    rm -rf -- "$out"
    echo "backup failed; incomplete output removed" >&2
  fi
}
trap cleanup_incomplete EXIT
compose_json="$("${COMPOSE[@]}" config --format json)"
# The worker state: only its files and folders. A container can write state/, and a link, FIFO or socket there would
# make the backup one restore.sh refuses, so such an entry is left out, and named. The redaction key never leaves.
pack_state() {
  local odd keep=(state \( -path state/settings/redaction-archive/key -o -path state/redaction-key \) -prune -o)
  odd="$(find "${keep[@]}" ! -type f ! -type d -print | head -n 5)"
  [ -z "$odd" ] || printf 'left out of state.tgz (neither a file nor a folder; a container may have made it):\n%s\n' "$odd" >&2
  find "${keep[@]}" \( -type f -o -type d \) -print0 | tar --null --no-recursion -T - -czf "$out/state.tgz"
}

if [ "$STORE" = postgres ]; then
  pg_clear
  mkdir -p "$out"
  chmod 700 "$out"
  echo "dumping Postgres ($(pg_target)) while everything keeps running"
  if ! pg_run pg_dump --format=custom --no-owner > "$out/postgres.dump"; then
    rm -rf "$out"
    echo "pg_dump failed; no backup written" >&2
    exit 1
  fi
  pack_state
  echo postgres > "$out/STORE"
  ( cd "$out" && shasum -a 256 postgres.dump state.tgz STORE > SHA256SUMS )
else
  image="$(printf '%s' "$compose_json" | json_field services.neo4j.image)"
  neo4j_volume="$(printf '%s' "$compose_json" | json_field volumes.neo4j-data.name)"
  [ -n "$neo4j_volume" ] || neo4j_volume="${FG_PROJECT}_neo4j-data"
  mkdir -p "$out"
  chmod 700 "$out"
  running="$("${COMPOSE[@]}" ps --services --status running)"
  # One name per install: a dump container a killed backup left is removed by the next one.
  dump_container="$FG_PROJECT-backup-dump"
  docker rm -f "$dump_container" >/dev/null 2>&1 || true
  echo "stopping the stack for a consistent dump"
  "${COMPOSE[@]}" stop api worker neo4j >/dev/null
  restart_stack() {
    docker rm -f "$dump_container" >/dev/null 2>&1 || true
    echo "restarting"
    # shellcheck disable=SC2086 # one service name per word, captured from compose ps
    [ -z "$running" ] || "${COMPOSE[@]}" up -d --no-deps $running >/dev/null
    core="$(printf '%s\n' $running | grep -E '^(api|worker|neo4j|postgres)$' || true)"
    # Wait only for Feedback Graph's data/API services. An optional runner or unrelated sidecar may intentionally be
    # unhealthy and must neither mask a failed restore nor make a sound backup command fail.
    # shellcheck disable=SC2086 # one service name per word
    [ -z "$core" ] || "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 120 $core >/dev/null
  }
  trap 'restart_stack; cleanup_incomplete' EXIT
  # Do not bind the owner-only backup directory into the image: the image intentionally drops to its unprivileged
  # neo4j user, which cannot traverse a host directory created with mode 0700. Stream the archive directly instead;
  # this also avoids depending on Docker's copy semantics for a file created after the container was made.
  # Bound the offline admin JVM as well as the server. On a small Docker host the otherwise auto-sized admin heap can
  # compete with the primary test/install database and be killed without producing a dump.
  # In the Compose project (docker compose down --remove-orphans removes one a killed backup left), with both volumes
  # the image declares mounted, so it creates no anonymous volume.
  docker create --name "$dump_container" "${oneoff_labels[@]}" --label com.docker.compose.service=neo4j -e "HEAP_SIZE=${NEO4J_ADMIN_HEAP_SIZE:-256m}" -v "$neo4j_volume:/data" --mount type=tmpfs,dst=/logs "$image" \
    neo4j-admin database dump neo4j --to-stdout >/dev/null
  if ! docker start -a "$dump_container" >"$out/neo4j.dump" 2>"$out/neo4j-admin.log"; then
    cat "$out/neo4j-admin.log" >&2
    exit 1
  fi
  rm -f "$out/neo4j-admin.log"
  chmod 600 "$out/neo4j.dump"
  docker rm "$dump_container" >/dev/null
  pack_state
  echo neo4j > "$out/STORE"
  ( cd "$out" && shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS )
fi
complete=1
echo "backup written to $out ($(du -sh "$out" | cut -f1))"
