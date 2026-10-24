#!/usr/bin/env bash
# The containers work for a host uid other than 1000 (Linux: HOST_UID/HOST_GID in .env, passed as `user:`), tested in
# Docker rather than assumed:
#   1. docker-compose.yml runs worker, api and codex-runner as HOST_UID:HOST_GID (and 1000:1000 without them): the
#      runner's token and the worker's mirrors are readable only by their owner, so worker and runner share a uid;
#   2. the worker image run as uid 1234, against a state folder owned by 1234 with mode 700, writes worker.sqlite (the
#      worker's own FileState), its HOME, CODEX_HOME and the codex-runner scratch volume;
#   3. the same folder refuses uid 1000, so step 2 proves something: ownership is really enforced there.
# On Linux the state folder is a bind-mounted host folder. Docker Desktop (macOS, Windows) does not enforce ownership on
# folders shared from the host, so there it is a volume on the Docker VM's Linux filesystem instead.
# Everything it creates (image tag, volumes, folders) is removed on exit, pass or fail.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="fg-uid-check:$$"
STATE_VOL="fg-uid-check-state-$$"
CODEX_VOL="fg-uid-check-codex-$$"
SCRATCH_VOL="fg-uid-check-scratch-$$"
WORK="$(mktemp -d)"
UID_=1234
GID_=1234

cleanup() {
  # Files owned by uid 1234 in a bind-mounted folder: removed from inside, as root, before the folder itself.
  if [ -d "$WORK/state" ] && docker image inspect "$TAG" >/dev/null 2>&1; then
    docker run --rm --user 0 -v "$WORK/state:/state" "$TAG" sh -c 'rm -rf /state/* /state/.[!.]*' >/dev/null 2>&1 || true
  fi
  docker volume rm -f "$STATE_VOL" "$CODEX_VOL" "$SCRATCH_VOL" >/dev/null 2>&1 || true
  docker image rm -f "$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "uid check failed: $*" >&2; exit 1; }

echo "1. docker-compose.yml: worker, api and codex-runner run as HOST_UID:HOST_GID"
printf 'NEO4J_PASSWORD=x\nHOST_UID=%s\nHOST_GID=%s\n' "$UID_" 4321 > "$WORK/with.env"
printf 'NEO4J_PASSWORD=x\nHOST_UID=\nHOST_GID=\n' > "$WORK/without.env"
users() { docker compose --env-file "$1" -f docker-compose.yml --profile codex config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).services;console.log(`${c.worker.user} ${c.api.user} ${c["codex-runner"].user}`)})'; }
[ "$(users "$WORK/with.env")" = "$UID_:4321 $UID_:4321 $UID_:4321" ] || fail "compose does not pass HOST_UID/HOST_GID as user (got: $(users "$WORK/with.env"))"
[ "$(users "$WORK/without.env")" = "1000:1000 1000:1000 1000:1000" ] || fail "compose without HOST_UID is not 1000:1000 (got: $(users "$WORK/without.env"))"

echo "building the worker image"
docker build -q --target worker -t "$TAG" . >/dev/null

if [ "$(uname -s)" = Linux ]; then
  mkdir "$WORK/state"
  STATE="$WORK/state"
  echo "state folder: $STATE (bind mount)"
else
  docker volume create "$STATE_VOL" >/dev/null
  STATE="$STATE_VOL"
  echo "state folder: volume $STATE_VOL (Docker Desktop does not enforce ownership on host folders)"
fi
docker run --rm --user 0 -v "$STATE:/state" "$TAG" sh -c "chown $UID_:$GID_ /state && chmod 700 /state"

echo "2. uid $UID_ writes worker.sqlite, its HOME, CODEX_HOME and the codex-runner scratch"
# The worker's environment as docker-compose.yml gives it (STATE_DB, CODEX_HOME on its named volume).
out="$(docker run --rm --user "$UID_:$GID_" -e STATE_DB=/state/worker.sqlite -e CODEX_HOME=/codex \
  -v "$STATE:/state" -v "$CODEX_VOL:/codex" -v "$SCRATCH_VOL:/scratch" "$TAG" sh -c '
    set -e
    node -e "
      const { FileState } = await import(\"/app/packages/worker/src/state.ts\");
      const s = new FileState(process.env.STATE_DB);
      s.setSetting(\"uid-check\", \"ok\");
      s.close();
      const again = new FileState(process.env.STATE_DB);
      console.log(\"state:\", again.getSetting(\"uid-check\"));
      again.close();
    "
    stat -c "owner: %u" /state/worker.sqlite
    mkdir -p "$HOME/.claude" && touch "$HOME/.claude.json" && echo "home: $HOME"
    touch "$CODEX_HOME/probe" && echo "codex home: $CODEX_HOME"
    touch /scratch/probe && echo "scratch: /scratch"
  ')" || fail "uid $UID_ could not write: $out"
echo "$out" | sed 's/^/   /'
grep -qx 'state: ok' <<<"$out" || fail "worker.sqlite was not written and read back"
grep -qx "owner: $UID_" <<<"$out" || fail "worker.sqlite is not owned by uid $UID_"
grep -qx 'home: /home/fg' <<<"$out" || fail "HOME is not the writable /home/fg"
grep -qx 'scratch: /scratch' <<<"$out" || fail "the codex-runner scratch volume is not writable by uid $UID_"

echo "3. uid 1000 cannot write the same folder (so step 2 means something)"
if docker run --rm --user 1000:1000 -v "$STATE:/state" "$TAG" sh -c 'touch /state/intruder' 2>/dev/null; then
  fail "uid 1000 could write a folder owned by $UID_ with mode 700: ownership is not enforced here, so this check proves nothing"
fi
echo "uid check passed"
