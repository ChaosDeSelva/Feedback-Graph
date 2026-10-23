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
