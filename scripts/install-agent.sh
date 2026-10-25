#!/usr/bin/env bash
# Connect your coding agents to the Feedback Graph.
#   Claude Code: the MCP server at user scope, and the feedback-graph, postmortem and test-from-feedback skills linked
#                into ~/.claude/skills. (Or install the Claude Code plugin in plugin/ instead, which adds hooks; see
#                plugin/README.md. Use one or the other, not both.)
#   Codex:       the MCP server in $CODEX_HOME/config.toml (default ~/.codex) over streamable HTTP, and the same
#                guidance in $CODEX_HOME/AGENTS.md, between markers.
#
#   ./scripts/install-agent.sh            # every agent found (claude or codex on PATH, or a Codex config or login)
#   ./scripts/install-agent.sh codex      # only Codex (or: claude)
#   ./scripts/install-agent.sh --dry-run  # print what would change, change nothing
#   ./scripts/install-agent.sh codex --codex-auto-approve   # let Codex call the tools without asking (codex exec)
#   ./scripts/install-agent.sh --help
#   FEEDBACK_GRAPH_URL=https://feedback.example.com ./scripts/install-agent.sh
#   (default http://localhost:<API_PORT>, API_PORT from .env or the environment, 8787 when unset; an API_BIND other
#   than loopback or 0.0.0.0 is used as the host)
#
# When .env (or the environment) sets API_TOKEN, the MCP server is registered with it as a Bearer header.
# Safe to re-run: a server already registered is left alone, the guidance block is only rewritten when it changed, and
# a Codex file is copied to <file>.bak.<time> before it is changed. The skills are symlinks into this folder, so a
# git pull updates them; after moving or deleting this folder, re-run the script (or remove the links).
set -euo pipefail

usage() {
  cat <<'EOF'
usage: ./scripts/install-agent.sh [--dry-run] [--codex-auto-approve] [claude|codex]

Connect Claude Code and Codex to the Feedback Graph's MCP server.

  (no agent)   every agent found: Claude Code when `claude` is on PATH; Codex when `codex` is on PATH or
               $CODEX_HOME (default ~/.codex) has config.toml or auth.json
  claude       Claude Code only: `claude mcp add --transport http --scope user feedback-graph <url>/mcp`, and the
               feedback-graph, postmortem and test-from-feedback skills linked into ~/.claude/skills (links into this folder)
  codex        Codex only: [mcp_servers.feedback-graph] in $CODEX_HOME/config.toml, and the guidance in
               $CODEX_HOME/AGENTS.md between BEGIN/END feedback-graph markers
  --dry-run    print what would change and change nothing (no files, no links, no claude mcp add)
  --codex-auto-approve
               let Codex call the Feedback Graph tools without asking: default_tools_approval_mode = "approve" in
               [mcp_servers.feedback-graph]. `codex exec` (approval policy never) refuses MCP tool calls without it.
               In a terminal you are asked instead (default no).
  -h, --help   this text

The URL is FEEDBACK_GRAPH_URL, else http://localhost:<API_PORT> (API_PORT from the environment or .env, 8787 when
unset). With API_TOKEN set, the server is registered with it as a Bearer header (never printed). Re-running is safe.
EOF
}

dry=0
auto_approve=0
args=()
for a in "$@"; do
  case "$a" in
    -h | --help) usage; exit 0 ;;
    -n | --dry-run) dry=1 ;;
    --codex-auto-approve) auto_approve=1 ;;
    -*) echo "unknown option: $a" >&2; usage >&2; exit 1 ;;
    *) args+=("$a") ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"
# In a dry run, say what would happen instead of doing it.
would() { echo "would: $*"; }
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
# The CLI, or a config or login Codex itself wrote. Not the folder alone: setup.sh creates ~/.codex/sessions so Docker
# does not create it as root, and that says nothing about Codex being installed.
has_codex() { command -v codex >/dev/null 2>&1 || [ -f "$codex_home/config.toml" ] || [ -f "$codex_home/auth.json" ]; }

# The blank line(s) that separate appended text from a file's existing content, then an "x" so $(...) keeps them.
separator() { if [ -s "$1" ]; then [ -n "$(tail -c1 "$1")" ] && echo; echo; fi; echo x; }

backup() {
  [ -f "$1" ] || return 0
  if [ "$dry" = 1 ]; then would "copy $1 to $1.bak.<time>"; return 0; fi
  cp -p "$1" "$1.bak.$(date +%Y%m%d%H%M%S)" && echo "backed up $1"
}

install_claude() {
  # The plugin (plugin/) brings the same MCP server and skills, plus hooks: registering them again would double the tools.
  if claude plugin list 2>/dev/null | grep -q 'feedback-graph@'; then
    echo "Claude Code: the feedback-graph plugin is installed and already provides the MCP server and skills; nothing to do"
    return
  fi
  for s in feedback-graph postmortem test-from-feedback; do
    local link="$HOME/.claude/skills/$s"
    if [ "$(readlink "$link" 2>/dev/null || true)" = "$here/plugin/skills/$s" ]; then
      echo "skill already linked: ~/.claude/skills/$s"
    elif [ "$dry" = 1 ]; then
      if [ -e "$link" ] || [ -L "$link" ]; then would "replace ~/.claude/skills/$s with a link to $here/plugin/skills/$s"
      else would "link ~/.claude/skills/$s -> $here/plugin/skills/$s"; fi
    else
      mkdir -p "$HOME/.claude/skills"
      ln -sfn "$here/plugin/skills/$s" "$link"
      echo "linked skill: ~/.claude/skills/$s"
    fi
  done
  if claude mcp get feedback-graph >/dev/null 2>&1; then
    echo "Claude Code: MCP server feedback-graph already registered (remove it with: claude mcp remove feedback-graph --scope user, then re-run)"
  elif [ "$dry" = 1 ]; then
    would "claude mcp add --transport http --scope user feedback-graph $url/mcp${token:+ --header 'Authorization: Bearer <API_TOKEN>'}"
  elif [ -n "$token" ]; then
    claude mcp add --transport http --scope user feedback-graph "$url/mcp" --header "Authorization: Bearer $token"
    echo "Claude Code: registered $url/mcp with your API_TOKEN"
  else
    claude mcp add --transport http --scope user feedback-graph "$url/mcp"
    echo "Claude Code: registered $url/mcp"
  fi
}

# Questions only in a terminal (FEEDBACK_INSTALL_INTERACTIVE=1 asks them anyway, reading answers from stdin).
interactive() { [ -t 0 ] || [ "${FEEDBACK_INSTALL_INTERACTIVE:-}" = 1 ]; }

# Codex's per-server tool approval (a key of the server's table; values auto, prompt, writes, approve). With "approve",
# Codex calls this server's tools without asking, which `codex exec` needs: its approval policy is never, so otherwise
# every MCP tool call is refused. The tools only read the graph and file reports for you to decide on.
APPROVE_LINE='default_tools_approval_mode = "approve"'
# Whether the feedback-graph table in $1 already sets the approval mode.
table_has_approval() {
  awk '
    /^[[:space:]]*\[/ { on = ($0 ~ /^[[:space:]]*\[mcp_servers\.("feedback-graph"|feedback-graph)\][[:space:]]*$/); next }
    on && /^[[:space:]]*default_tools_approval_mode[[:space:]]*=/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1" 2>/dev/null
}
# --codex-auto-approve says yes, a terminal asks (default no), otherwise no.
want_approval() {
  [ "$auto_approve" = 1 ] && return 0
  interactive || return 1
  local a=""
  read -r -p "Let Codex call the Feedback Graph tools without asking ($APPROVE_LINE; codex exec needs it)? [y/N] " a || true
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
approval_hint() {
  echo "Codex: each tool call waits for your approval (codex exec refuses them); to allow them, re-run with --codex-auto-approve"
  echo "  or add $APPROVE_LINE under [mcp_servers.feedback-graph] in $1"
}

BEGIN_MARK='<!-- BEGIN feedback-graph (managed by scripts/install-agent.sh in the Feedback Graph folder; re-run it to update) -->'
END_MARK='<!-- END feedback-graph -->'

install_codex() {
  local cfg="$codex_home/config.toml" md="$codex_home/AGENTS.md"
  [ "$dry" = 1 ] || mkdir -p "$codex_home"

  # Codex config keys for a streamable HTTP MCP server: url, static http_headers for the token, and (when you allow it)
  # default_tools_approval_mode.
  local approve=0
  if grep -Eq '^[[:space:]]*\[mcp_servers\.("feedback-graph"|feedback-graph)\][[:space:]]*$' "$cfg" 2>/dev/null; then
    echo "Codex: MCP server feedback-graph already in $cfg (delete its [mcp_servers.feedback-graph] table, then re-run, to change it)"
    if table_has_approval "$cfg"; then
      echo "Codex: the approval mode for feedback-graph is already set in $cfg"
    elif want_approval; then
      backup "$cfg"
      if [ "$dry" = 1 ]; then
        would "add $APPROVE_LINE to [mcp_servers.feedback-graph] in $cfg"
      else
        # In place (cp keeps the file's mode: it may hold the token), right under the table's header.
        local tmp="$cfg.tmp.$$"
        cp -p "$cfg" "$tmp"
        LINE="$APPROVE_LINE" awk '
          { print }
          !done && /^[[:space:]]*\[mcp_servers\.("feedback-graph"|feedback-graph)\][[:space:]]*$/ { print ENVIRON["LINE"]; done = 1 }
        ' "$cfg" >"$tmp"
        mv "$tmp" "$cfg"
        echo "Codex: feedback-graph tools now run without asking ($APPROVE_LINE in $cfg)"
      fi
    else
      approval_hint "$cfg"
    fi
  else
    want_approval && approve=1
    if [ "$dry" = 1 ]; then
      backup "$cfg"
      would "add [mcp_servers.feedback-graph] with url = \"$url/mcp\"${token:+ and the API_TOKEN as a Bearer header (then make it readable by you only)} to $cfg"
      if [ "$approve" = 1 ]; then would "add $APPROVE_LINE to it"; fi
    else
      backup "$cfg"
      local sep
      sep="$(separator "$cfg")"
      {
        printf '%s' "${sep%x}"
        echo '[mcp_servers.feedback-graph]'
        echo "url = \"$url/mcp\""
        if [ "$approve" = 1 ]; then echo "$APPROVE_LINE"; fi
        if [ -n "$token" ]; then echo "http_headers = { \"Authorization\" = \"Bearer $token\" }"; fi
      } >>"$cfg"
      if [ -n "$token" ]; then
        chmod 600 "$cfg" # it now holds the token
        echo "Codex: registered $url/mcp with your API_TOKEN in $cfg (made readable by you only)"
      else
        echo "Codex: registered $url/mcp in $cfg"
      fi
      if [ "$approve" = 1 ]; then echo "Codex: feedback-graph tools run without asking ($APPROVE_LINE)"; else approval_hint "$cfg"; fi
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
    if [ "$dry" = 1 ]; then would "update the Feedback Graph guidance between its markers in $md"; return; fi
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
    if [ "$dry" = 1 ]; then would "add the Feedback Graph guidance to $md"; return; fi
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
      echo "neither Claude Code nor Codex found (no claude or codex on PATH, no $codex_home/config.toml or auth.json); install one, or name it: $0 claude|codex" >&2
      exit 1
    fi
    ;;
  claude) has_claude || { echo "claude not found on PATH" >&2; exit 1; }; install_claude ;;
  codex) install_codex ;;
  *) usage >&2; exit 1 ;;
esac
[ "$dry" = 0 ] || echo "dry run: nothing was changed"
