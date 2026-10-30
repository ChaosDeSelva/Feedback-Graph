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
    elif [ -r "$base/memory/memory.usage_in_bytes" ]; then
      for name in memory.usage_in_bytes memory.limit_in_bytes memory.memsw.usage_in_bytes memory.memsw.limit_in_bytes; do
        printf "%s=" "$name"; cat "$base/memory/$name" 2>/dev/null || echo unknown
      done
    fi' 2>/dev/null | awk -F= '
      $1=="memory.current" || $1=="memory.usage_in_bytes" { used=$2 }
      $1=="memory.max" || $1=="memory.limit_in_bytes" { limit=$2 }
      $1=="memory.swap.current" { swap=$2 }
      $1=="memory.swap.max" { swaplimit=$2 }
      $1=="memory.memsw.limit_in_bytes" { combinedlimit=$2 }
      $1=="memory.memsw.usage_in_bytes" { combined=$2 }
      END { if (used ~ /^[0-9]+$/ && limit ~ /^[0-9]+$/ && limit>0) {
        if (swap=="") swap=(combined>used ? combined-used : 0)
        if (swaplimit=="" && combinedlimit>limit) swaplimit=combinedlimit-limit
        swaphead=(swaplimit ~ /^[0-9]+$/ ? sprintf("%.0f",swaplimit-swap) : "null")
        swaplimit=(swaplimit ~ /^[0-9]+$/ ? sprintf("%.0f",swaplimit) : "null")
        printf "{\"usedBytes\":%.0f,\"limitBytes\":%.0f,\"headroomBytes\":%.0f,\"swapBytes\":%.0f,\"swapLimitBytes\":%s,\"swapHeadroomBytes\":%s}", used,limit,limit-used,swap,swaplimit,swaphead
      }}'
}
