#!/usr/bin/env bash
# Connect your coding agents to the Feedback Graph.
#   Claude Code: the MCP server at user scope, and the feedback-graph and postmortem skills in ~/.claude/skills.
#   Codex:       the MCP server in $CODEX_HOME/config.toml (default ~/.codex) over streamable HTTP, and the same
#                guidance in $CODEX_HOME/AGENTS.md, between markers.
#
#   ./scripts/install-agent.sh            # every agent found (claude on PATH; codex on PATH or ~/.codex present)
#   ./scripts/install-agent.sh codex      # only Codex (or: claude)
#   FEEDBACK_GRAPH_URL=https://feedback.example.com ./scripts/install-agent.sh
#   (default http://localhost:<API_PORT>, API_PORT from .env or the environment, 8787 when unset; an API_BIND other
#   than loopback or 0.0.0.0 is used as the host)
#
# When .env (or the environment) sets API_TOKEN, the MCP server is registered with it as a Bearer header.
# Safe to re-run: a server already registered is left alone, the guidance block is only rewritten when it changed, and
# a Codex file is copied to <file>.bak.<time> before it is changed.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${FEEDBACK_GRAPH_ENV:-$here/.env}"
# KEY's value: the environment's when set, else the last KEY= line of the env file, surrounding quotes removed.
setting() {
  local v
  v="$(printenv "$1" 2>/dev/null || true)"
  if [ -z "$v" ] && [ -f "$env_file" ]; then
    v="$(grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" || true)"
  fi
  printf '%s' "$v"
}
token="$(setting API_TOKEN)"
if [ -n "${FEEDBACK_GRAPH_URL:-}" ]; then
  url="$FEEDBACK_GRAPH_URL"
else
  # The address docker compose publishes the API on (docker-compose.yml: API_BIND:API_PORT).
  port="$(setting API_PORT)"
  port="${port:-8787}"
  case "$port" in *[!0-9]*) echo "API_PORT must be a port number (got something else)" >&2; exit 1 ;; esac
  bind="$(setting API_BIND)"
  case "$bind" in
    '' | 127.* | 0.0.0.0 | localhost | ::1 | '::' | '[::1]' | '[::]') host=localhost ;;
    *:*) host="[${bind#[}"; host="${host%]}]" ;;
    *) host="$bind" ;;
  esac
  url="http://$host:$port"
fi
url="${url%/}"
codex_home="${CODEX_HOME:-$HOME/.codex}"

# Both end up inside TOML strings; refuse anything that would need escaping rather than write a broken config.
case "$url" in *[\"\\[:space:]]*) echo "FEEDBACK_GRAPH_URL must not contain quotes, backslashes or spaces" >&2; exit 1 ;; esac
case "$token" in *[!A-Za-z0-9._~+/=-]*) echo "API_TOKEN has characters other than letters, digits and ._~+/=-; use e.g. openssl rand -hex 24" >&2; exit 1 ;; esac

has_claude() { command -v claude >/dev/null 2>&1; }
has_codex() { command -v codex >/dev/null 2>&1 || [ -d "$codex_home" ]; }

# The blank line(s) that separate appended text from a file's existing content, then an "x" so $(...) keeps them.
separator() { if [ -s "$1" ]; then [ -n "$(tail -c1 "$1")" ] && echo; echo; fi; echo x; }

backup() { [ -f "$1" ] && cp -p "$1" "$1.bak.$(date +%Y%m%d%H%M%S)" && echo "backed up $1"; return 0; }

install_claude() {
  mkdir -p "$HOME/.claude/skills"
  for s in feedback-graph postmortem; do
    ln -sfn "$here/skill/$s" "$HOME/.claude/skills/$s"
    echo "linked skill: ~/.claude/skills/$s"
  done
  if claude mcp get feedback-graph >/dev/null 2>&1; then
    echo "Claude Code: MCP server feedback-graph already registered (remove it with: claude mcp remove feedback-graph --scope user, then re-run)"
  elif [ -n "$token" ]; then
    claude mcp add --transport http --scope user feedback-graph "$url/mcp" --header "Authorization: Bearer $token"
    echo "Claude Code: registered $url/mcp with your API_TOKEN"
  else
    claude mcp add --transport http --scope user feedback-graph "$url/mcp"
    echo "Claude Code: registered $url/mcp"
  fi
}

BEGIN_MARK='<!-- BEGIN feedback-graph (managed by scripts/install-agent.sh in the Feedback Graph folder; re-run it to update) -->'
END_MARK='<!-- END feedback-graph -->'

install_codex() {
  local cfg="$codex_home/config.toml" md="$codex_home/AGENTS.md"
  mkdir -p "$codex_home"

  # Codex config keys for a streamable HTTP MCP server: url, and static http_headers for the token.
  if grep -Eq '^[[:space:]]*\[mcp_servers\.("feedback-graph"|feedback-graph)\][[:space:]]*$' "$cfg" 2>/dev/null; then
    echo "Codex: MCP server feedback-graph already in $cfg (delete its [mcp_servers.feedback-graph] table, then re-run, to change it)"
  else
    backup "$cfg"
    local sep
    sep="$(separator "$cfg")"
    {
      printf '%s' "${sep%x}"
      echo '[mcp_servers.feedback-graph]'
      echo "url = \"$url/mcp\""
      if [ -n "$token" ]; then echo "http_headers = { \"Authorization\" = \"Bearer $token\" }"; fi
    } >>"$cfg"
    if [ -n "$token" ]; then
      chmod 600 "$cfg" # it now holds the token
      echo "Codex: registered $url/mcp with your API_TOKEN in $cfg (made readable by you only)"
    else
      echo "Codex: registered $url/mcp in $cfg"
    fi
  fi

  local block
  block="$(printf '%s\n%s\n%s' "$BEGIN_MARK" "$(cat "$here/skill/codex/AGENTS.md")" "$END_MARK")"
  if [ -f "$md" ] && grep -q '^<!-- BEGIN feedback-graph' "$md"; then
    local current
    current="$(awk '/^<!-- BEGIN feedback-graph/{on=1} on{print} /^<!-- END feedback-graph -->/{on=0}' "$md")"
    if [ "$current" = "$block" ]; then
      echo "Codex: guidance already up to date in $md"
      return
    fi
    backup "$md"
    local tmp="$md.tmp.$$"
    BLOCK="$block" awk '
      /^<!-- BEGIN feedback-graph/ { if (!done) print ENVIRON["BLOCK"]; done = 1; skip = 1; next }
      skip && /^<!-- END feedback-graph -->/ { skip = 0; next }
      !skip { print }
    ' "$md" >"$tmp"
    mv "$tmp" "$md"
    echo "Codex: updated the Feedback Graph guidance in $md"
  else
    backup "$md"
    local sep
    sep="$(separator "$md")"
    printf '%s%s\n' "${sep%x}" "$block" >>"$md"
    echo "Codex: added the Feedback Graph guidance to $md"
  fi
}

want="${1:-all}"
case "$want" in
  all)
    found=0
    if has_claude; then install_claude; found=1; fi
    if has_codex; then install_codex; found=1; fi
    if [ "$found" = 0 ]; then
      echo "neither Claude Code nor Codex found (no claude or codex on PATH, no $codex_home); install one, or name it: $0 claude|codex" >&2
      exit 1
    fi
    ;;
  claude) has_claude || { echo "claude not found on PATH" >&2; exit 1; }; install_claude ;;
  codex) install_codex ;;
  *) echo "usage: $0 [claude|codex]" >&2; exit 1 ;;
esac
