#!/usr/bin/env bash
# Restore a backup made by backup.sh. This REPLACES the current store (Neo4j or Postgres, as STORE in .env says) and
# the worker state.
#   ./scripts/restore.sh backups/20261022T120000Z      (FORCE=1 skips the question)
#   ./scripts/restore.sh --abandon                     after a restore interrupted before it replaced anything: remove
#                                                      what it left and start the stack again
# A restore keeps a journal (scripts/lib/restore-journal.sh) until the store and the worker state are both replaced, so
# one killed part-way is reported by the next restore, backup or doctor run, and another restore finishes it.
set -euo pipefail
# The Compose project is this checkout's (FG_INSTANCE and COMPOSE_FILE from its .env): a shell's own value would point
# docker compose at another install's containers.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE
cd "$(dirname "$0")/.."
src="${1:?usage: restore.sh backups/<timestamp> | --abandon}"
. scripts/lib/store.sh
. scripts/lib/restore-journal.sh
. scripts/lib/state-fs.sh

load_container="$FG_PROJECT-restore-load"
swap_container="$FG_PROJECT-restore-swap"
if [ "$STORE" = neo4j ]; then
  compose_json="$("${COMPOSE[@]}" config --format json)"
  image="$(printf '%s' "$compose_json" | json_field services.neo4j.image)"
  neo4j_volume="$(printf '%s' "$compose_json" | json_field volumes.neo4j-data.name)"
  [ -n "$neo4j_volume" ] || neo4j_volume="${FG_PROJECT}_neo4j-data"
fi
# The containers a restore runs belong to the Compose project (docker compose down --remove-orphans removes one a
# killed restore left) and mount both volumes the Neo4j image declares, so they create no anonymous volume.
neo4j_run=("${oneoff_labels[@]}" --label com.docker.compose.service=neo4j
  -v "${neo4j_volume:-}:/data" --mount type=tmpfs,dst=/logs)
# A load still running is stopped (it replaces nothing); a swap still running is waited for.
clear_containers() {
  docker wait "$swap_container" >/dev/null 2>&1 || true
  docker rm -f "$swap_container" "$load_container" >/dev/null 2>&1 || true
  pg_clear
}
# The loaded database waits in /data/.restore, inside the live volume, until the swap moves it into place.
drop_loaded() { [ "$STORE" != neo4j ] || docker run --rm "${neo4j_run[@]}" --entrypoint rm "$image" -rf /data/.restore >/dev/null 2>&1 || true; }
# The service names given, each once, on one line.
services() { printf '%s\n' "$@" | awk 'NF && !seen[$0]++' | paste -sd ' ' -; }
start_again() {
  local names=()
  read -r -a names <<<"$1"
  [ ${#names[@]} = 0 ] || "${COMPOSE[@]}" up -d --no-deps "${names[@]}" >/dev/null 2>&1 || true
}

previous="$(restore_status)"
[ "$previous" != running ] || { echo "another restore (pid $(journal_get pid), from $(journal_get src)) is running here; wait for it to finish" >&2; exit 1; }
[ "$previous" != damaged ] || { restore_damaged >&2; exit 1; }
if [ "$src" = --abandon ]; then
  case "$previous" in
    none) echo "no interrupted restore here; nothing to do"; exit 0 ;;
    replacing) restore_interrupted replacing >&2; echo "  --abandon cannot undo that: the previous store may be gone already." >&2; exit 1 ;;
  esac
  src="$(journal_get src)" running="$(journal_get running)"
  clear_containers
  drop_loaded
  rm -rf "$restore_dir"
  state_rm "$restore_marker"
  start_again "$running"
  echo "removed what the interrupted restore from $src left; the store and the worker state are as they were${running:+, and the stack was started again}"
  exit 0
fi

if [ -f "$src/postgres.dump" ]; then kind=postgres
elif [ -f "$src/neo4j.dump" ]; then kind=neo4j
else echo "no neo4j.dump or postgres.dump in $src" >&2; exit 1
fi
[ "$kind" = "$STORE" ] || { echo "$src is a $kind backup but .env has STORE=$STORE; restore it into a $kind install (or change STORE)" >&2; exit 1; }
[ -f "$src/state.tgz" ] || { echo "no state.tgz in $src" >&2; exit 1; }
( cd "$src" && shasum -a 256 -c SHA256SUMS >/dev/null ) || { echo "checksum mismatch in $src; not restoring" >&2; exit 1; }

if [ "${FORCE:-}" != "1" ]; then
  [ -t 0 ] || { echo "not restoring: there is no terminal to ask whether to replace the current $STORE store and worker state; run FORCE=1 ./scripts/restore.sh $src" >&2; exit 1; }
  read -r -p "Replace the current $STORE store and worker state with $src? Type 'restore' to continue: " ok || ok=""
  [ "$ok" = "restore" ] || { echo "cancelled"; exit 1; }
fi

# The services an interrupted restore stopped are started again by this one. One that may have left the store and the
# worker state from different backups stays unsettled (the worker stays stopped) until this one has replaced both.
running="$(journal_get running)" unsettled=""
if [ "$previous" != none ]; then
  note="$(restore_interrupted "$previous")"
  echo "${note%%$'\n'*}"
  echo "  This restore replaces the store and the worker state, which settles it."
  if [ "$previous" = replacing ]; then
    unsettled="$(journal_get unsettled)"
    case "$(journal_get step)" in replacing | state) unsettled="$(journal_get src)" ;; esac
  fi
fi
# Containers an earlier restore left, even one whose own clean-up a Ctrl-C raced.
clear_containers
rm -rf "$restore_dir"
mkdir -m 700 "$restore_dir"
journal_set pid "$$"
journal_set started "$(proc_start $$)"
journal_set src "$src"
journal_set store "$STORE"
journal_set running "$running"
[ -z "$unsettled" ] || journal_set unsettled "$unsettled"
journal_set step unpacking

# Ctrl-C or a TERM is acted on between steps, never while the store and the worker state are being replaced.
interrupted=0 ints=0
trap 'interrupted=1 ints=$((ints + 1))' INT TERM
stop_if_interrupted() { [ "$interrupted" = 0 ] || exit 130; }
on_exit() {
  local status=$? how=failed phase
  [ "$status" != 0 ] || return 0
  # A second Ctrl-C must not cut this short (nor kill the subshells it reads the journal in).
  trap '' INT TERM
  [ "$interrupted" = 0 ] && [ "$status" != 130 ] || how=interrupted
  phase="$(restore_phase)"
  case "$phase" in
    untouched | before)
      docker rm -f "$load_container" "$swap_container" >/dev/null 2>&1 || true
      drop_loaded
      rm -rf "$restore_dir"
      start_again "$running"
      # Once more: a docker run cut short by Ctrl-C can leave the daemon finishing its create after the first removal.
      docker rm -f "$load_container" "$swap_container" >/dev/null 2>&1 || true
      pg_clear
      echo "restore $how; nothing was replaced: the $STORE store and worker state are as they were${running:+, and the stack was started again}." >&2
      echo "  Next: check the backup ($src) or fix what is said above, then run ./scripts/restore.sh again; ./scripts/doctor.sh checks the stack." >&2 ;;
    replacing)
      docker rm -f "$load_container" >/dev/null 2>&1 || true
      echo "restore $how." >&2
      restore_interrupted replacing >&2 ;;
    *)
      if [ "$how" = interrupted ]; then
        echo "restore interrupted after the $STORE store and worker state were restored from $src; the stack was not started again." >&2
        echo "  Next: docker compose up -d" >&2
      else
        echo "the $STORE store and worker state were restored from $src, but the stack did not come back healthy." >&2
        echo "  Next: docker compose logs api worker; ./scripts/doctor.sh checks the rest." >&2
      fi ;;
  esac
  [ "$how" != interrupted ] || exit 130
}
trap on_exit EXIT

# Unpack the worker state beside the live one first: a damaged archive fails here, before anything is replaced.
# A backup is only files and folders under state/. A link in it (or an absolute or ../ path) would make the writes below,
# or the worker later, write through to a host file the archive names, so such an archive is refused before extraction.
# GNU tar lists a hard link as "h..." ("link to"), bsdtar as "-..." with " link to ": both are caught.
# Bounded, so a crafted archive cannot fill the disk: what it unpacks to (counted from the gzip stream, so a gzip bomb
# is cut off at the limit, and again once unpacked, which a sparse file passes as small) and how many entries it has.
# FG_RESTORE_MAX_STATE_MB and FG_RESTORE_MAX_STATE_FILES raise the limits for a larger worker state.
max_mb="${FG_RESTORE_MAX_STATE_MB:-8192}" max_files="${FG_RESTORE_MAX_STATE_FILES:-200000}"
case "$max_mb:$max_files" in *[!0-9:]* | :* | *:) echo "FG_RESTORE_MAX_STATE_MB and FG_RESTORE_MAX_STATE_FILES must be whole numbers" >&2; exit 1 ;; esac
too_big() { echo "state.tgz in $src unpacks to more than $max_mb MB (FG_RESTORE_MAX_STATE_MB); not restoring" >&2; exit 1; }
state_bytes="$(set +o pipefail; gzip -dc <"$src/state.tgz" 2>/dev/null | head -c $((max_mb * 1048576 + 1)) | wc -c | tr -d ' ')"
[ "$state_bytes" -le $((max_mb * 1048576)) ] || too_big
entries="$(set +o pipefail; tar -tzf "$src/state.tgz" | head -n $((max_files + 1)) | wc -l | tr -d ' ')"
[ "$entries" -le "$max_files" ] || { echo "state.tgz in $src holds more than $max_files files and folders (FG_RESTORE_MAX_STATE_FILES); not restoring" >&2; exit 1; }
free_kb="$(df -Pk "$restore_dir" | awk 'NR == 2 { print $4 }')"
[ $((state_bytes / 1024)) -lt "$free_kb" ] || { echo "$restore_dir has $((free_kb / 1024)) MB free, less than the $((state_bytes / 1048576)) MB state.tgz in $src unpacks to; free some space and restore again" >&2; exit 1; }
unsafe="$(tar -tzf "$src/state.tgz" | awk '!/^state(\/|$)/ || /(^|\/)\.\.(\/|$)/' | head -n 3)"
unsafe="$unsafe$(tar -tvzf "$src/state.tgz" | awk '!/^[-d]/ || / link to /' | head -n 3)"
[ -z "$unsafe" ] || { printf 'state.tgz in %s holds links or paths outside state/; not restoring:\n%s\n' "$src" "$unsafe" >&2; exit 1; }
mkdir "$restore_dir/new"
tar -xzf "$src/state.tgz" -C "$restore_dir/new"
[ -d "$restore_dir/new/state" ] || { echo "state.tgz in $src holds no state/ folder; not restoring" >&2; exit 1; }
[ -z "$(find "$restore_dir/new" ! -type f ! -type d -print -quit)" ] || { echo "state.tgz in $src holds something other than files and folders; not restoring" >&2; exit 1; }
[ "$(find "$restore_dir/new" -type f -exec ls -ln {} + | awk '$5 ~ /^[0-9]+$/ { s += $5 } END { printf "%.0f", s }')" -le $((max_mb * 1048576)) ] || too_big
stop_if_interrupted

# From here until the restored state/ takes its place, the store may be the backup's while state/ is not: the marker in
# the live state/ keeps the worker from starting on that pair. Written before the journal says so: a marker that cannot be
# written (state_write says why) stops the restore while nothing is replaced yet.
begin_replacing() {
  mkdir -p state # gone when a restore was killed between setting it aside and moving the restored one in
  printf 'a restore from %s did not finish: run ./scripts/restore.sh %s\n' "$src" "$src" | state_write "$restore_marker" || exit 1
  journal_set step replacing
}
# Sign-outs saved after the backup are not in its older revocation file, and FG_OWNER_TOKEN, which signs the cookies,
# is in .env, which a restore keeps: those sessions would work again. So a restore refuses every owner browser session
# issued before it (the api is stopped by now); the owner signs in again. A runner-disabled flag (a safety decision,
# perhaps made after the backup) is carried over: only a plain file (a container can write state/, and a link there
# would copy the host file it names into the restored state/), and only 4 KiB of its printable text. The old state/ is
# set aside before the new one is moved in; a restore killed in between finds both and puts the new one in place when
# run again. A marker the archive carries is dropped: the restored state/ is the finished one.
swap_state() {
  local new="$restore_dir/new/state" flag reasons
  journal_set step state
  # Each written to a new file and moved over the archive's, never through it.
  mkdir -p "$new/api-settings"
  ( umask 077 && printf '{"notBefore":%s,"revoked":{}}\n' "$(date +%s)999" >"$new/api-settings/.revocations.$$" )
  mv -f "$new/api-settings/.revocations.$$" "$new/api-settings/owner-session-revocations.json"
  for flag in state/runner-control/codex-runner-disabled state/settings/codex-runner-disabled; do
    reasons="$(state_read "$flag" 4096 | LC_ALL=C tr -cd '[:print:]\n')" || continue
    mkdir -p "$new/runner-control"
    rm -rf "$new/runner-control/codex-runner-disabled"
    ( umask 077 && printf '%s\n' "$reasons" >"$new/runner-control/.flag.$$" )
    mv -f "$new/runner-control/.flag.$$" "$new/runner-control/codex-runner-disabled"
    break
  done
  rm -f "$new/.restore-incomplete"
  rm -rf state.previous
  [ ! -e state ] || mv state state.previous
  mv "$new" state
  rm -rf state.previous "$restore_dir"
}

# Runs "$@" with Ctrl-C and TERM ignored by every command it runs (they inherit that from its subshell): a Ctrl-C reaches
# the whole process group, and would otherwise stop it part-way. This script still records one, and stops after.
uninterrupted() { ( trap '' INT TERM; "$@" ); }

# enough_space <df -Pk output> <where>: stops the restore, before anything is stopped, when the dump is larger than the
# space free there.
enough_space() {
  local free dump
  free="$(printf '%s\n' "$1" | awk 'NR == 2 { print $4 }')" dump="$(wc -c <"$src/$kind.dump" | tr -d ' ')"
  case "$free" in '' | *[!0-9]*) echo "could not tell how much space $2 has free (df said: ${1:-nothing}); not restoring" >&2; exit 1 ;; esac
  [ $((dump / 1024)) -le "$free" ] ||
    { echo "$2 has $((free / 1024)) MB free, less than the $((dump / 1048576)) MB dump in $src; free some space (docker system df) and restore again" >&2; exit 1; }
}

if [ "$kind" = postgres ]; then
  # Nothing may write while the tables are replaced; the database itself keeps running.
  # The restored tables are at least as big as the dump, and are written before the old ones go (one transaction).
  [ -z "$PG_BUNDLED" ] || enough_space "$(pg_df)" "the bundled postgres service's volume"
  running="$(services $running $("${COMPOSE[@]}" ps --services --status running | grep -E '^(api|worker)$' || true))"
  journal_set running "$running"
  journal_set step stopping
  "${COMPOSE[@]}" stop api worker >/dev/null
  stop_if_interrupted
  echo "restoring Postgres ($(pg_target))"
  begin_replacing
  # The schema as it was, exactly: tables a later migration added go too (else that migration would not run again).
  # One transaction, committed by the last line only: a failure, or input cut short, leaves the database as it was.
  if ! { printf 'SET client_min_messages = warning;\nBEGIN;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n'; pg_script <"$src/postgres.dump" && printf 'COMMIT;\n'; } |
    pg_run psql -X -q -v ON_ERROR_STOP=1 >/dev/null; then
    journal_set step loading
    [ -n "$unsettled" ] || state_rm "$restore_marker"
    exit 1
  fi
  uninterrupted swap_state
  core="$(printf '%s\n' $running | grep -E '^(api|worker|postgres)$' || true)"
else
  # docker run would otherwise make an unlabeled named volume when restoring a fresh install. Compose then warns that
  # the volume is foreign on every subsequent `up`; create it with the ownership labels Compose itself uses.
  if ! docker volume inspect "$neo4j_volume" >/dev/null 2>&1; then
    docker volume create --label "com.docker.compose.project=$FG_PROJECT" --label 'com.docker.compose.volume=neo4j-data' "$neo4j_volume" >/dev/null
  fi
  # The loaded database is at least as big as its dump, and is written beside the current one.
  enough_space "$(docker run --rm "${neo4j_run[@]}" --entrypoint df "$image" -Pk /data)" "the $neo4j_volume volume"
  running="$(services $running $("${COMPOSE[@]}" ps --services --status running))"
  journal_set running "$running"
  journal_set step stopping
  "${COMPOSE[@]}" stop api worker neo4j >/dev/null
  stop_if_interrupted
  journal_set step loading
  # Load beside the live database, never over it: a dump that fails part-way (truncated, or the admin JVM killed) leaves
  # the current database exactly as it was. Only a complete load is moved into place.
  # The backup folder is owner-only. Stream the archive through stdin instead of bind-mounting it into the
  # unprivileged Neo4j image; this also works when the caller supplies an absolute backup path.
  # Bound the offline admin JVM as well as the server. Auto-sizing can overcommit a small Docker host when another
  # project is running Neo4j, causing a silent restore failure.
  echo "loading $src beside the current database"
  load_log="$restore_dir/load.log"
  if ! docker run --rm -i --name "$load_container" "${neo4j_run[@]}" -e "HEAP_SIZE=${NEO4J_ADMIN_HEAP_SIZE:-256m}" \
    -e NEO4J_server_directories_data=/data/.restore --entrypoint sh "$image" \
    -c 'rm -rf /data/.restore && exec tini -g -- /startup/docker-entrypoint.sh "$@"' sh \
    neo4j-admin database load neo4j --from-stdin --overwrite-destination=true <"$src/neo4j.dump" >"$load_log" 2>&1; then
    stop_if_interrupted
    cat "$load_log" >&2
    exit 1
  fi
  stop_if_interrupted
  echo "replacing the database with the loaded one"
  # Renames inside the volume. The current files are set aside in .pre-restore first (then .restore-swapping says so);
  # the loaded ones are moved in, and only then is .pre-restore dropped. A swap cut short is finished by the next
  # restore, which loads afresh: once the old files are set aside, anything beside them is a partial earlier swap.
  docker create --name "$swap_container" "${neo4j_run[@]}" --entrypoint sh "$image" -euc '
    cd /data
    if [ ! -e .restore-swapping ]; then
      mkdir -p .pre-restore
      find . -mindepth 1 -maxdepth 1 ! -name .restore ! -name .pre-restore -exec mv {} .pre-restore/ \;
      touch .restore-swapping
    else
      find . -mindepth 1 -maxdepth 1 ! -name .restore ! -name .pre-restore ! -name .restore-swapping -exec rm -rf {} +
    fi
    find .restore -mindepth 1 -maxdepth 1 -exec mv {} . \;
    rmdir .restore
    rm -rf .pre-restore
    rm .restore-swapping' >/dev/null
  stop_if_interrupted
  begin_replacing
  # Started detached and waited for, so a Ctrl-C (which reaches every docker command in the foreground) cannot leave the
  # swap half-done or unstarted: a start or wait it cut short is done again.
  until docker start "$swap_container" >/dev/null; do [ "$(docker inspect -f '{{.State.Status}}' "$swap_container")" = created ] || break; done
  waits=$ints
  until swapped="$(docker wait "$swap_container")"; do [ "$ints" != "$waits" ] || exit 1; waits=$ints; done
  uninterrupted docker rm "$swap_container" >/dev/null
  [ "$swapped" = 0 ] || { echo "the swap container failed (exit $swapped)" >&2; exit 1; }
  uninterrupted swap_state
  core="$(printf '%s\n' $running | grep -E '^(api|worker|neo4j)$' || true)"
fi
stop_if_interrupted
# shellcheck disable=SC2086 # one service name per word
[ -z "$running" ] || "${COMPOSE[@]}" up -d --no-deps $running >/dev/null
# Wait only for Feedback Graph's data/API services, not an optional sidecar that may be unhealthy on purpose.
# shellcheck disable=SC2086 # one service name per word
[ -z "$core" ] || "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 120 $core >/dev/null
echo "restored from $src"
