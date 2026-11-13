# shellcheck shell=bash
# Sourced by the scripts (from the repo root). Values from .env are never printed: some carry passwords.

# KEY's value: the environment's when set, else the last KEY= line of .env, surrounding quotes removed.
envval() {
  local v
  v="$(printenv "$1" 2>/dev/null || true)"
  if [ -z "$v" ] && [ -f .env ]; then
    v="$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//")"
  fi
  printf '%s' "$v"
}

# This checkout's Compose project: FG_INSTANCE in .env, else feedback-graph. docker compose calls name it (-p), so the
# project they address is always the one the scripts checked and printed. The environment's FG_INSTANCE names an install
# only before it has a .env (setup.sh's first run writes it there); after that .env decides (check_instance_env).
fg_instance() {
  local v
  if [ -f .env ]; then v="$(grep -E '^FG_INSTANCE=' .env | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//")"
  else v="${FG_INSTANCE:-}"; fi
  printf '%s' "${v:-feedback-graph}"
}
# Stops the script when the environment's FG_INSTANCE is not the install this checkout's .env names: it would point
# docker compose at another install's containers and data.
check_instance_env() {
  local own
  [ -n "${FG_INSTANCE:-}" ] && [ -f .env ] || return 0
  own="$(fg_instance)"
  [ "$FG_INSTANCE" = "$own" ] && return 0
  echo "FG_INSTANCE=$FG_INSTANCE in your environment is not this checkout's install ($own, from $PWD/.env): unset it, or set FG_INSTANCE in that .env" >&2
  exit 1
}
# The folder the install under Compose name $1 was started from: the working_dir label of its service containers, else
# nothing. One-off containers (backup.sh's and restore.sh's) are left out, and so is an empty label: one a killed backup
# or restore of an older version left carries none, and would hide the folder the install runs from.
instance_dir() {
  docker ps -a --filter "label=com.docker.compose.project=$1" --filter label=com.docker.compose.oneoff=False \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | awk 'NF { print; exit }' || true
}
physical_dir() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
# The folder the install under Compose name $1 was started from when it is not $2 (default the current directory), else
# nothing.
foreign_install_dir() {
  local d
  d="$(instance_dir "$1")"
  [ -z "$d" ] || [ "$(physical_dir "$d")" = "$(physical_dir "${2:-.}")" ] || printf '%s' "$d"
}

# Set KEY=VALUE in .env: its KEY= line replaced in place (later duplicates dropped), else appended. Every other line is
# kept as it was, the value is never printed, and the file stays readable by you only.
setenv() {
  local tmp=".env.tmp.$$"
  KEY="$1" VAL="$2" awk '
    BEGIN { k = ENVIRON["KEY"] "="; v = ENVIRON["VAL"] }
    index($0, k) == 1 { if (!done) print k v; done = 1; next }
    { print }
    END { if (!done) print k v }
  ' .env >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
}

# Read only the database container's cgroup counters; no Docker socket enters the API.
database_memory() {
  "$@" exec -T neo4j sh -c '
    base=/sys/fs/cgroup
    if [ -r "$base/memory.current" ]; then
      for name in memory.current memory.max memory.swap.current memory.swap.max; do
        printf "%s=" "$name"; cat "$base/$name" 2>/dev/null || echo unknown
      done
      awk '"'"'$1 == "anon" { print "memory.anon=" $2 }'"'"' "$base/memory.stat" 2>/dev/null || true
    elif [ -r "$base/memory/memory.usage_in_bytes" ]; then
      for name in memory.usage_in_bytes memory.limit_in_bytes memory.memsw.usage_in_bytes memory.memsw.limit_in_bytes; do
        printf "%s=" "$name"; cat "$base/memory/$name" 2>/dev/null || echo unknown
      done
    fi' 2>/dev/null | awk -F= '
      $1=="memory.current" || $1=="memory.usage_in_bytes" { used=$2 }
      $1=="memory.anon" { anon=$2 }
      $1=="memory.max" || $1=="memory.limit_in_bytes" { limit=$2 }
      $1=="memory.swap.current" { swap=$2 }
      $1=="memory.swap.max" { swaplimit=$2 }
      $1=="memory.memsw.limit_in_bytes" { combinedlimit=$2 }
      $1=="memory.memsw.usage_in_bytes" { combined=$2 }
      END { if (used ~ /^[0-9]+$/ && limit ~ /^[0-9]+$/ && limit>0) {
        if (anon ~ /^[0-9]+$/) used=anon
        if (swap=="") swap=(combined>used ? combined-used : 0)
        if (swaplimit=="" && combinedlimit>limit) swaplimit=combinedlimit-limit
        swaphead=(swaplimit ~ /^[0-9]+$/ ? sprintf("%.0f",swaplimit-swap) : "null")
        swaplimit=(swaplimit ~ /^[0-9]+$/ ? sprintf("%.0f",swaplimit) : "null")
        printf "{\"usedBytes\":%.0f,\"limitBytes\":%.0f,\"headroomBytes\":%.0f,\"swapBytes\":%.0f,\"swapLimitBytes\":%s,\"swapHeadroomBytes\":%s}", used,limit,limit-used,swap,swaplimit,swaphead
      }}'
}

# The settings that pick a model for a worker job; codex-cli in any of them uses the Codex login. (CHECK_LLM, the api's
# judge, takes no CLI.)
CODEX_JOB_SETTINGS='CLASSIFY_LLM POSTMORTEM_LLM SCAN_LLM DOCS_LLM CHAT_LLM SUMMARY_LLM LOOP_LLM INTAKE_LLM CONFLICT_LLM'
# Succeeds when one of those jobs is set to codex-cli.
codex_job_configured() {
  local job
  for job in $CODEX_JOB_SETTINGS; do
    case "$(envval "$job")" in codex-cli | codex-cli:*) return 0 ;; esac
  done
  return 1
}
