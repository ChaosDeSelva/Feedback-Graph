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
