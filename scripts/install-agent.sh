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
# The server is named feedback-graph, or feedback-graph-<name> for an install with its own FG_INSTANCE (setup.sh gives a
# second checkout on the same machine one, and its own API_PORT), so two installs on one machine each keep a server.
# Such a second install never repoints the skill links the first one made; the Codex guidance block names the server
# of the install that wrote it, and only that install rewrites it.
# Safe to re-run: this install's server registration is refreshed with its current URL/token, the guidance block is only rewritten when it changed, and
# a Codex file is copied to <file>.bak.<time> (once a run, the original) before it is changed. A config.toml that
# declares this install's server in a form other than a [mcp_servers.<name>] table, or an AGENTS.md block missing its
# END marker, is refused (exit 1) and left as it is. An edit of config.toml must parse with python3's tomllib (3.11+);
# without one, a config.toml with multi-line values is refused, and an edit of one without is made and said unchecked. The skills are symlinks into this folder, so a
# git pull updates them; after moving or deleting this folder, re-run the script (or remove the links).
set -euo pipefail
# The Compose project is this checkout's (FG_INSTANCE and COMPOSE_FILE from its .env): a shell's own value would point
# docker compose at another install's containers.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE

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
An install with its own FG_INSTANCE (a second one on this machine) is registered as feedback-graph-<name> instead,
and leaves skill links and a Codex guidance block another install made as they are (it adds them only where none is);
the guidance block names the server of the install that wrote it, which keeps it up to date.
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
# Before setup there is no install here to connect: agents would be registered at the default port 8787 (another
# checkout's install, or none, replacing the registration that install made) and the skills linked into this folder.
if [ ! -f "$env_file" ] && [ -z "${FEEDBACK_GRAPH_URL:-}" ]; then
  echo "this checkout is not set up (missing $env_file): run ./scripts/setup.sh first, or set FEEDBACK_GRAPH_URL to connect your agents to an install elsewhere" >&2
  exit 1
fi
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
# The MCP server's name: feedback-graph for the default install, feedback-graph-<suffix> for another FG_INSTANCE (the
# name setup.sh gives it, feedback-graph-<folder>, is used as it is), so a second install never takes over the first's.
# The env file decides the install once it exists: a different FG_INSTANCE in the environment would register another
# install's name for this one's address.
instance="$(setting FG_INSTANCE)"
if [ -f "$env_file" ]; then
  own="$(grep -E '^FG_INSTANCE=' "$env_file" | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" || true)"
  if [ "${instance:-feedback-graph}" != "${own:-feedback-graph}" ]; then
    echo "FG_INSTANCE=$instance in your environment is not this checkout's install (${own:-feedback-graph}, from $env_file): unset it, or set FG_INSTANCE in that file" >&2
    exit 1
  fi
fi
case "$instance" in
  '' | feedback-graph) name=feedback-graph ;;
  *[!a-z0-9_-]* | [!a-z0-9]*) echo "FG_INSTANCE must be lowercase letters, digits, - and _ (starting with a letter or digit)" >&2; exit 1 ;;
  feedback-graph-*) name="$instance" ;;
  *) name="feedback-graph-$instance" ;;
esac
# Containers under this install's Compose name that another folder started are that folder's install: registering here
# would give its server name this checkout's address and token and repoint the skills at this folder.
if command -v docker >/dev/null 2>&1; then
  . "$here/scripts/lib/env.sh"
  started_in="$(foreign_install_dir "${instance:-feedback-graph}" "$here")"
  if [ -n "$started_in" ]; then
    echo "the containers named ${instance:-feedback-graph} were started from $started_in, not this folder ($here): connecting agents here would repoint that install's server and skills." >&2
    echo "  Run ./scripts/install-agent.sh from $started_in, or give this folder its own FG_INSTANCE and ports in .env (./scripts/setup.sh --help)." >&2
    exit 1
  fi
fi
if [ -n "${FEEDBACK_GRAPH_URL:-}" ]; then
  url="$FEEDBACK_GRAPH_URL"
  expected_url="http://localhost:$(setting API_PORT)"; expected_url="${expected_url%:}"
  [ "$expected_url" != http://localhost ] || expected_url=http://localhost:8787
  if [ "${url%/}" != "$expected_url" ] && [ "${url%/}" != "${expected_url/localhost/127.0.0.1}" ]; then
    if [ -f "$env_file" ] && grep -q '^API_TOKEN=' "$env_file"; then
      echo "refusing to send this install's API_TOKEN to FEEDBACK_GRAPH_URL=$url (this checkout is $expected_url); unset FEEDBACK_GRAPH_URL or configure the URL in this install" >&2
      exit 1
    fi
    echo "WARNING: FEEDBACK_GRAPH_URL overrides this checkout's $expected_url; registration will target that explicit override. Unset it for this install." >&2
  fi
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

# A copy of $1 (a link's target) at $1.bak.<time>, or .bak.<time>-<n> when a copy made in the same second is there.
backup() {
  [ -f "$1" ] || return 0
  if [ "$dry" = 1 ]; then would "copy $1 to $1.bak.<time>"; return 0; fi
  local base copy n=1
  base="$1.bak.$(date +%Y%m%d%H%M%S)"
  copy="$base"
  while [ -e "$copy" ] || [ -L "$copy" ]; do copy="$base-$n"; n=$((n + 1)); done
  cp -p "$1" "$copy" && echo "backed up $1"
}

# The file a path names, following links (a dotfiles link stays a link; its target is written). On a link loop (more
# than 40 links) or a link into a folder that does not exist, prints why instead and fails.
resolve_link() {
  local f="$1" t n=0
  while [ -L "$f" ]; do
    n=$((n + 1))
    if [ "$n" -gt 40 ]; then printf '%s is a loop of symbolic links' "$1"; return 1; fi
    t="$(readlink "$f")"
    case "$t" in /*) f="$t" ;; *) f="$(dirname "$f")/$t" ;; esac
  done
  if [ "$n" -gt 0 ] && [ ! -d "$(dirname "$f")" ]; then printf '%s links to %s, in a folder that does not exist' "$1" "$f"; return 1; fi
  printf '%s' "$f"
}

# Set when something was refused or failed; the script exits 1 then, after doing what it could.
failed=0
refuse() { echo "$*" >&2; failed=1; }

# A dry run never runs the claude CLI: any claude command may rewrite ~/.claude.json (and back it up). It reads the
# files that CLI keeps instead; a real run asks the CLI.
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
claude_plugin_installed() {
  if [ "$dry" = 1 ]; then grep -qs '"feedback-graph@' "$claude_dir/plugins/installed_plugins.json"
  else claude plugin list 2>/dev/null | grep -q 'feedback-graph@'; fi
}
claude_server_registered() {
  if [ "$dry" = 1 ]; then
    local json="$HOME/.claude.json"
    [ -z "${CLAUDE_CONFIG_DIR:-}" ] || json="$CLAUDE_CONFIG_DIR/.claude.json"
    [ -f "$json" ] && FILE="$json" NAME="$1" node -e '
      const v = JSON.parse(require("node:fs").readFileSync(process.env.FILE, "utf8"));
      process.exit(v.mcpServers && Object.hasOwn(v.mcpServers, process.env.NAME) ? 0 : 1)' 2>/dev/null
  else claude mcp get "$1" >/dev/null 2>&1; fi
}

install_claude() {
  # The plugin (plugin/) brings the same MCP server and skills, plus hooks: registering them again would double the tools.
  # Its server (fg) reaches one install (FEEDBACK_GRAPH_URL, else port 8787): another instance still gets a server of its
  # own, under its own name, so the agent can reach both. The skills come with the plugin either way.
  local plugin=0
  if claude_plugin_installed; then
    if [ "$name" = feedback-graph ]; then
      local settings_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
      local settings="$settings_dir/settings.json"
      if [ "$dry" = 1 ]; then
        would "refresh the feedback-graph plugin environment in $settings with this install's current URL and API_TOKEN"
        return
      fi
      mkdir -p "$settings_dir"
      local target
      if ! target="$(resolve_link "$settings")"; then
        refuse "Claude Code: $target; left it unchanged (fix the link, then re-run)"
        return
      fi
      if [ -f "$target" ] && ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$target" 2>/dev/null; then
        refuse "Claude Code: $settings is not valid JSON; left it unchanged (fix it, then re-run)"
        return
      fi
      backup "$settings"
      # Written through a link to its target, so a settings.json kept in dotfiles stays a link.
      SETTINGS="$target" FG_PLUGIN_URL="$url" FG_PLUGIN_TOKEN="$token" node -e '
        const fs = require("node:fs");
        const file = process.env.SETTINGS;
        let value = {};
        try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        value.env = value.env && typeof value.env === "object" && !Array.isArray(value.env) ? value.env : {};
        value.env.FEEDBACK_GRAPH_URL = process.env.FG_PLUGIN_URL;
        if (process.env.FG_PLUGIN_TOKEN) value.env.FEEDBACK_GRAPH_TOKEN = process.env.FG_PLUGIN_TOKEN;
        else delete value.env.FEEDBACK_GRAPH_TOKEN;
        const tmp = `${file}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, file);
        fs.chmodSync(file, 0o600);
      '
      echo "Claude Code: refreshed the feedback-graph plugin URL and API_TOKEN in $settings (restart Claude Code)"
      return
    fi
    plugin=1
    echo "Claude Code: the feedback-graph plugin is installed (its fg server and skills); adding this install's server $name beside it"
  fi
  for s in feedback-graph postmortem test-from-feedback; do
    [ "$plugin" = 0 ] || break
    local link="$HOME/.claude/skills/$s" target
    target="$(readlink "$link" 2>/dev/null || true)"
    if [ "$target" = "$here/plugin/skills/$s" ]; then
      echo "skill already linked: ~/.claude/skills/$s"
    elif [ "$name" != feedback-graph ] && { [ -e "$link" ] || [ -L "$link" ]; }; then
      # A second install never repoints the first one's skills: they are the same skills, and work with either server.
      echo "skill ~/.claude/skills/$s belongs to another install (${target:-not a link}); left as it is (this install is the server $name)"
    elif [ -e "$link" ] && [ ! -L "$link" ]; then
      # A folder or file of your own: ln would put the link inside it (or replace it), and Claude Code loads yours.
      echo "skill ~/.claude/skills/$s is your own $([ -d "$link" ] && echo folder || echo file), not a link; skipped it (move it away and re-run to link this install's)"
    elif [ "$dry" = 1 ]; then
      if [ -L "$link" ]; then would "replace ~/.claude/skills/$s with a link to $here/plugin/skills/$s"
      else would "link ~/.claude/skills/$s -> $here/plugin/skills/$s"; fi
    else
      mkdir -p "$HOME/.claude/skills"
      ln -sfn "$here/plugin/skills/$s" "$link"
      echo "linked skill: ~/.claude/skills/$s"
    fi
  done
  # Literal references are expanded by Claude Code when it starts, not when this installer runs.
  local run_headers=(--header 'X-FG-Run: ${FG_RUN:-}' --header 'X-FG-Sandbox: ${FG_SANDBOX:-0}' --header 'X-FG-Run-Key: ${FG_RUN_KEY:-}')
  if claude_server_registered "$name"; then
    if [ "$dry" = 1 ]; then
      would "refresh Claude Code MCP server $name at $url/mcp with this install's current URL, API_TOKEN and dynamic run headers"
      return
    fi
    # `mcp add` does not update an existing entry. Remove and recreate our named entry so an upgrade that introduces
    # or rotates API_TOKEN cannot leave Claude connected with stale credentials (the rest of Claude's config is not
    # touched). The server name is instance-specific, so a second install never removes the first one's entry.
    claude mcp remove "$name" --scope user >/dev/null
    echo "Claude Code: refreshing existing MCP server $name"
  fi
  if [ "$dry" = 1 ]; then
    would "claude mcp add --transport http --scope user $name $url/mcp${token:+ --header 'Authorization: Bearer <API_TOKEN>'}"
  elif [ -n "$token" ]; then
    claude mcp add --transport http --scope user "$name" "$url/mcp" --header "Authorization: Bearer $token" "${run_headers[@]}"
    echo "Claude Code: registered $name at $url/mcp with your current API_TOKEN"
  else
    claude mcp add --transport http --scope user "$name" "$url/mcp" "${run_headers[@]}"
    echo "Claude Code: registered $name at $url/mcp"
  fi
}

# Questions only in a terminal (FEEDBACK_INSTALL_INTERACTIVE=1 asks them anyway, reading answers from stdin).
interactive() { [ -t 0 ] || [ "${FEEDBACK_INSTALL_INTERACTIVE:-}" = 1 ]; }

# Codex's per-server tool approval (a key of the server's table; values auto, prompt, writes, approve). With "approve",
# Codex calls this server's tools without asking, which `codex exec` needs: its approval policy is never, so otherwise
# every MCP tool call is refused. The tools only read the graph and file reports for you to decide on.
APPROVE_LINE='default_tools_approval_mode = "approve"'
RUN_HEADERS_LINE='env_http_headers = { "X-FG-Run" = "FG_RUN", "X-FG-Sandbox" = "FG_SANDBOX", "X-FG-Run-Key" = "FG_RUN_KEY" }'
IFS= read -r -d '' CODEX_AWK <<'AWK' || true
# This install's server in Codex's config.toml, read in two passes over the same file (given twice). The first finds
# its table and every way the file could declare the server that a line edit cannot update (an array of tables, a
# header subtable, dotted keys, an inline table, a header map that is not one line); the second writes the file with
# the table brought up to date to OUT (when set): url, the Authorization entry of http_headers (its other headers
# kept), env_http_headers and, with APPR=1, the approval mode. Prints what it found and what it changed.
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
# A dotted key with quotes around simple parts removed: "mcp_servers"."x" and mcp_servers . x are mcp_servers.x.
function norm(k,   n, parts, i, out, p) {
  n = split(k, parts, ".")
  out = ""
  for (i = 1; i <= n; i++) {
    p = trim(parts[i])
    if (p ~ /^".*"$/ || p ~ /^'.*'$/) p = substr(p, 2, length(p) - 2)
    out = out (i > 1 ? "." : "") p
  }
  return out
}
# The position after the TOML string that starts (with its quote) at s[i], or 0 when it does not end on the line.
function strend(s, i,   q, c) {
  q = substr(s, i, 1)
  for (i++; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (q == "\"" && c == "\\") { i++; continue }
    if (c == q) return i + 1
  }
  return 0
}
function skipws(s, i) { while (i <= length(s) && substr(s, i, 1) ~ /[ \t]/) i++; return i }
function endok(s, i) { i = skipws(s, i); return i > length(s) || substr(s, i, 1) == "#" }
# Reads a value's text from s[i] on, keeping across lines whether it is inside a multi-line string (ml: its quotes) or
# array (depth): a line inside one is part of a value, never a header or a key.
function scan(s, i,   c, q, j) {
  while (i <= length(s)) {
    c = substr(s, i, 1)
    if (ml != "") {
      if (ml == "\"\"\"" && c == "\\") { i += 2; continue }
      if (substr(s, i, 3) == ml) {
        # Up to two more quotes right after the closing ones are the string's own.
        q = substr(ml, 1, 1)
        for (j = i + 3; j < i + 5 && substr(s, j, 1) == q; j++);
        i = j; ml = ""; continue
      }
      i++; continue
    }
    if (c == "#") return
    if (substr(s, i, 3) == "\"\"\"" || substr(s, i, 3) == "'''") { ml = substr(s, i, 3); i += 3; continue }
    if (c == "\"" || c == "'") { j = strend(s, i); if (!j) return; i = j; continue }
    if (c == "[" || c == "{") depth++
    else if (c == "]" || c == "}") depth--
    i++
  }
}
# The one-line inline table of strings at the start of s, into mk (raw keys), mv (raw values) and mn (lowercase
# names); its entry count, or -1 when it is anything else.
function parsemap(s,   i, j, n, c, k) {
  n = 0
  i = skipws(s, 1)
  if (substr(s, i, 1) != "{") return -1
  i = skipws(s, i + 1)
  if (substr(s, i, 1) == "}") return endok(s, i + 1) ? 0 : -1
  while (1) {
    c = substr(s, i, 1)
    if (c == "\"" || c == "'") { j = strend(s, i); if (!j) return -1 }
    else { for (j = i; j <= length(s) && substr(s, j, 1) ~ /[A-Za-z0-9_-]/; j++); if (j == i) return -1 }
    k = substr(s, i, j - i)
    n++; mk[n] = k; mn[n] = tolower(k ~ /^["']/ ? substr(k, 2, length(k) - 2) : k)
    i = skipws(s, j)
    if (substr(s, i, 1) != "=") return -1
    i = skipws(s, i + 1)
    c = substr(s, i, 1)
    if (c != "\"" && c != "'") return -1
    j = strend(s, i)
    if (!j) return -1
    mv[n] = substr(s, i, j - i)
    i = skipws(s, j)
    c = substr(s, i, 1)
    if (c == "}") return endok(s, i + 1) ? n : -1
    if (c != ",") return -1
    i = skipws(s, i + 1)
  }
}
# pre: the byte-order mark the file starts with, if any, written back before its first line.
function emit(s) { if (OUT != "") { print pre s (cr ? "\r" : "") > OUT; pre = "" } }
BEGIN { T = "mcp_servers." NAME; URL_LINE = "url = \"" URL "\""; AUTH = "\"Bearer " TOKEN "\""; BOM = "\357\273\277" }
{ line = $0; cr = sub(/\r$/, "", line); first = (NR == FNR) }
FNR == 1 {
  ml = ""; depth = 0
  if (substr(line, 1, 3) == BOM) { line = substr(line, 4); $0 = line; pre = first ? "" : BOM }
}
# A line inside a multi-line string or array (scan): kept as it is.
ml != "" || depth > 0 { multi = 1; scan(line, 1); if (!first) emit(line); next }
# A table header: [a.b] or [[a.b]], with an optional comment after it.
/^[ \t]*\[/ {
  h = line
  arr = (h ~ /^[ \t]*\[\[/)
  sub(/^[ \t]*\[\[?/, "", h)
  h = norm(substr(h, 1, index(h, "]") - 1))
  cur = h
  if (first) {
    if (arr && (h == T || index(h, T ".") == 1)) bad = bad ? bad : "an array of tables [[" h "]]"
    else if (index(h, T ".http_headers") == 1 || index(h, T ".env_http_headers") == 1) bad = bad ? bad : "a [" h "] table"
    if (h == T && !arr) found = 1
    next
  }
  emit(line)
  if (h == T && !arr && !done) {
    done = 1
    if (!has_url) { emit(URL_LINE); ch_conn = 1 }
    if (APPR && !has_appr) { emit(APPROVE_LINE); ch_appr = 1 }
    if (!has_env) { emit(RUN_HEADERS_LINE); ch_env = 1 }
    if (TOKEN != "" && !has_hh) { emit("http_headers = { \"Authorization\" = " AUTH " }"); ch_conn = 1 }
  }
  next
}
# A key line (key = value).
/^[ \t]*[A-Za-z0-9_"'-]/ && index($0, "=") {
  k = norm(substr(line, 1, index(line, "=") - 1))
  v = substr(line, index(line, "=") + 1)
  full = cur == "" ? k : cur "." k
  ours = (cur == T)
  scan(v, 1)
  open = (ml != "" || depth > 0)
  if (open) multi = 1
  if (first) {
    if (!ours && index(cur, T ".") != 1 && (full == T || index(full, T ".") == 1 || index(T, full ".") == 1))
      bad = bad ? bad : (cur == "" ? "dotted keys or an inline table at the top level (" k ")" : "an inline table or dotted keys under [" cur "] (" k ")")
    if (!ours) next
    if (k == "url") { has_url = 1; if (open) bad = bad ? bad : "a url that spans lines" }
    else if (k == "env_http_headers") has_env = 1
    else if (k == "default_tools_approval_mode") {
      has_appr = 1
      appr = trim(v)
      j = appr ~ /^["']/ ? strend(appr, 1) : 0
      appr = j ? substr(appr, 2, j - 3) : appr
    }
    else if (k == "http_headers") { has_hh = 1; if (parsemap(v) < 0) bad = bad ? bad : "http_headers that is not one line of { \"Header\" = \"value\", ... }" }
    else if (index(k, "http_headers.") == 1 || index(k, "env_http_headers.") == 1) bad = bad ? bad : "dotted header keys (" k ")"
    next
  }
  if (ours && k == "url" && trim(line) != URL_LINE) { emit(URL_LINE); ch_conn = 1; next }
  if (ours && k == "http_headers") {
    n = parsemap(v)
    ai = 0
    for (i = 1; i <= n; i++) if (mn[i] == "authorization") ai = i
    changed = 0
    if (TOKEN != "" && !ai) { for (i = n; i >= 1; i--) { mk[i + 1] = mk[i]; mv[i + 1] = mv[i] } n++; mk[1] = "\"Authorization\""; mv[1] = AUTH; changed = 1 }
    else if (TOKEN != "" && mv[ai] != AUTH) { mv[ai] = AUTH; changed = 1 }
    else if (TOKEN == "" && ai) { for (i = ai; i < n; i++) { mk[i] = mk[i + 1]; mv[i] = mv[i + 1] } n--; changed = 1 }
    if (!changed) { emit(line); next }
    ch_conn = 1
    if (!n) next
    s = ""
    for (i = 1; i <= n; i++) s = s (i > 1 ? ", " : "") mk[i] " = " mv[i]
    emit("http_headers = { " s " }")
    next
  }
}
!first { emit(line) }
END {
  print "form=" (bad ? "unsupported" : found ? "table" : "none")
  print "reason=" bad
  print "approval=" (has_appr ? 1 : 0)
  print "approval_value=" appr
  print "multiline=" (multi ? 1 : 0)
  print "changes=" (ch_conn ? " connection" : "") (ch_env ? " run_headers" : "") (ch_appr ? " approval" : "")
}
AWK
# What codex_table finds in config.toml ($1) and, with $2, writes there; $3=1 adds the approval mode.
codex_table() {
  LC_ALL=C awk -v NAME="$name" -v URL="$url/mcp" -v TOKEN="$token" -v APPR="$3" -v OUT="$2" -v APPROVE_LINE="$APPROVE_LINE" -v RUN_HEADERS_LINE="$RUN_HEADERS_LINE" "$CODEX_AWK" "$1" "$1"
}
# python3's tomllib error for $1 (exit 1), nothing when it parses, or exit 2 when there is no python3 with tomllib
# (3.11+; macOS's /usr/bin/python3 is 3.9) to ask. A byte-order mark is allowed, as Codex allows it.
toml_error() {
  command -v python3 >/dev/null 2>&1 || return 2
  python3 -I -c '
import sys
try:
    import tomllib
except ImportError:
    sys.exit(2)
try:
    tomllib.loads(open(sys.argv[1], "rb").read().decode("utf-8-sig"))
except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
    print(e)
    sys.exit(1)' "$1"
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
  echo "Codex: a tool not marked read-only (report_feedback) waits for your approval, and codex exec refuses it; to allow it, re-run with --codex-auto-approve"
  echo "  or add $APPROVE_LINE under [mcp_servers.$name] in $1"
  echo "  or, for one headless run: codex exec -c 'mcp_servers.$name.default_tools_approval_mode=\"approve\"' ..."
}

# The block names the server of the install that wrote it (none: feedback-graph, as before 0.7.6, unless no
# feedback-graph server is registered, when the install running this takes it over), so that install,
# and only that one, keeps it up to date.
if [ "$name" = feedback-graph ]; then
  BEGIN_MARK='<!-- BEGIN feedback-graph (managed by scripts/install-agent.sh in the Feedback Graph folder; re-run it to update) -->'
else
  BEGIN_MARK="<!-- BEGIN feedback-graph (server $name; managed by scripts/install-agent.sh in the Feedback Graph folder; re-run it to update) -->"
fi
END_MARK='<!-- END feedback-graph -->'
# Whether the default install's server (feedback-graph) is registered in Codex's config ($1) or Claude Code's.
default_server_registered() {
  grep -Eq '^[[:space:]]*\[mcp_servers\.("feedback-graph"|feedback-graph)\][[:space:]]*(#.*)?$' "$1" 2>/dev/null ||
    { has_claude && claude_server_registered feedback-graph; }
}

# Puts the edited copy $3 in place of config.toml ($1, whose file is $2) once it parses, with one backup first;
# otherwise removes it and leaves config.toml as it was. With nothing to check it with, says so.
codex_replace() {
  local err rc=0
  err="$(toml_error "$3")" || rc=$?
  if [ "$rc" = 1 ]; then
    rm -f "$3"
    refuse "Codex: updating $1 would leave it invalid TOML ($err); left it and the guidance unchanged"
    return 1
  fi
  if [ "$rc" = 2 ] && [ -f "$2" ]; then
    echo "Codex: could not check that $1 still parses (no python3 3.11+ with tomllib); it has only one-line values, the form this script edits line by line"
  fi
  backup "$1"
  [ -z "$token" ] || chmod 600 "$3" # it holds the token
  mv "$3" "$2"
}

install_codex() {
  local cfg="$codex_home/config.toml" md="$codex_home/AGENTS.md"
  [ "$dry" = 1 ] || mkdir -p "$codex_home"

  # Codex config keys for a streamable HTTP MCP server: url, static http_headers for the token, env_http_headers for
  # a labelled run, and (when you allow it) default_tools_approval_mode. Only this install's [mcp_servers.<name>] table
  # is edited; any other form of it is refused, and the result must parse (python3's tomllib, when there is one)
  # before it replaces config.toml, which keeps the original otherwise. A linked config.toml is written through.
  local target facts form reason approve=0 changes err md_target
  if ! target="$(resolve_link "$cfg")"; then
    refuse "Codex: $target; left it and $md unchanged (fix the link, then re-run)"
    return
  fi
  # AGENTS.md too is written through a link (dotfiles), so its link is checked before anything changes.
  if ! md_target="$(resolve_link "$md")"; then
    refuse "Codex: $md_target; left it and $cfg unchanged (fix the link, then re-run)"
    return
  fi
  local rc=0
  if [ -f "$target" ]; then err="$(toml_error "$target")" || rc=$?; fi
  if [ "$rc" = 1 ]; then
    refuse "Codex: $cfg is not valid TOML ($err); left it and $md unchanged"
    return
  fi
  facts="$(codex_table "$target" "" 0 2>/dev/null || true)"
  form="$(printf '%s\n' "$facts" | sed -n 's/^form=//p')"
  reason="$(printf '%s\n' "$facts" | sed -n 's/^reason=//p')"
  if [ "$form" = unsupported ]; then
    refuse "Codex: $cfg declares the server $name as $reason, which this script does not edit; left it and $md unchanged. Write it as a [mcp_servers.$name] table with url (and http_headers = { ... } on one line), or remove it, then re-run."
    return
  fi
  # Line edits are safe without a parser to check them only in a file of one-line values.
  if [ "$rc" = 2 ] && [ "$(printf '%s\n' "$facts" | sed -n 's/^multiline=//p')" = 1 ]; then
    refuse "Codex: $cfg has multi-line strings or arrays, and there is no python3 3.11+ (with tomllib) here to check that an edit of it still parses; left it and $md unchanged. Install Python 3.11+ and re-run, or add [mcp_servers.$name] with url = \"$url/mcp\" yourself."
    return
  fi
  local mode
  mode="$(printf '%s\n' "$facts" | sed -n 's/^approval_value=//p')"
  if [ "$form" = table ] && [ "$(printf '%s\n' "$facts" | sed -n 's/^approval=//p')" = 1 ]; then
    if [ "$mode" = approve ]; then
      echo "Codex: $name tools already run without asking ($APPROVE_LINE in $cfg)"
    else
      # Your own explicit choice is kept, even with --codex-auto-approve.
      echo "Codex: $cfg sets default_tools_approval_mode = \"$mode\" for $name; left your choice as it is. codex exec refuses report_feedback unless it is \"approve\": change it there to allow that."
    fi
  elif want_approval; then approve=1
  fi
  if [ "$form" = table ]; then
    changes="$(codex_table "$target" "" "$approve" | sed -n 's/^changes=//p')"
    if [ "$dry" = 1 ]; then
      [ -z "$changes" ] || backup "$cfg"
      case "$changes" in *connection*) would "refresh $name in $cfg with this install's current URL and API_TOKEN" ;; *) echo "Codex: MCP server $name already registered with the current URL and credentials" ;; esac
      case "$changes" in *run_headers*) would "add dynamic FG_RUN/FG_SANDBOX/FG_RUN_KEY headers to $cfg" ;; esac
      case "$changes" in *approval*) would "add $APPROVE_LINE to [mcp_servers.$name] in $cfg" ;; esac
      [ "$approve" = 1 ] || [ "$(printf '%s\n' "$facts" | sed -n 's/^approval=//p')" = 1 ] || approval_hint "$cfg"
    elif [ -z "$changes" ]; then
      echo "Codex: MCP server $name already registered with the current URL and credentials"
      [ "$(printf '%s\n' "$facts" | sed -n 's/^approval=//p')" = 1 ] || approval_hint "$cfg"
    else
      local tmp="$target.fg-tmp.$$"
      cp -p "$target" "$tmp"
      codex_table "$target" "$tmp" "$approve" >/dev/null
      codex_replace "$cfg" "$target" "$tmp" || return
      case "$changes" in *connection*) echo "Codex: refreshed $name with this install's current URL and API_TOKEN" ;; *) echo "Codex: MCP server $name already registered with the current URL and credentials" ;; esac
      case "$changes" in *approval*) echo "Codex: $name tools now run without asking ($APPROVE_LINE in $cfg)" ;; esac
      [ "$approve" = 1 ] || [ "$(printf '%s\n' "$facts" | sed -n 's/^approval=//p')" = 1 ] || approval_hint "$cfg"
    fi
  else
    if [ "$dry" = 1 ]; then
      backup "$cfg"
      would "add [mcp_servers.$name] with url = \"$url/mcp\"${token:+ and the API_TOKEN as a Bearer header (then make it readable by you only)} to $cfg"
      if [ "$approve" = 1 ]; then would "add $APPROVE_LINE to it"; fi
    else
      local tmp="$target.fg-tmp.$$" sep
      if [ -f "$target" ]; then cp -p "$target" "$tmp"; else (umask 077 && : >"$tmp"); fi
      sep="$(separator "$tmp")"
      {
        printf '%s' "${sep%x}"
        echo "[mcp_servers.$name]"
        echo "url = \"$url/mcp\""
        if [ "$approve" = 1 ]; then echo "$APPROVE_LINE"; fi
        echo "$RUN_HEADERS_LINE"
        if [ -n "$token" ]; then echo "http_headers = { \"Authorization\" = \"Bearer $token\" }"; fi
      } >>"$tmp"
      codex_replace "$cfg" "$target" "$tmp" || return
      if [ -n "$token" ]; then
        echo "Codex: registered $name at $url/mcp with your API_TOKEN in $cfg (made readable by you only)"
      else
        echo "Codex: registered $name at $url/mcp in $cfg"
      fi
      if [ "$approve" = 1 ]; then echo "Codex: $name tools run without asking ($APPROVE_LINE)"; else approval_hint "$cfg"; fi
    fi
  fi

  local block
  block="$(printf '%s\n%s\n%s' "$BEGIN_MARK" "$(cat "$here/skill/codex/AGENTS.md")" "$END_MARK")"
  local owner=""
  if [ -f "$md" ] && grep -q '^<!-- BEGIN feedback-graph' "$md"; then
    owner="$(sed -n 's/^<!-- BEGIN feedback-graph (server \([a-z0-9_-]*\);.*/\1/p' "$md" | head -n 1)"
    if [ -z "$owner" ] && [ "$name" != feedback-graph ] && ! default_server_registered "$cfg"; then
      # A block from before 0.7.6 names no server; with no feedback-graph server here, a named install wrote it.
      local adopt="the Feedback Graph guidance in $md names no server and no feedback-graph server is registered, so this install (the server $name) takes it over"
      if [ "$dry" = 1 ]; then would "$adopt"; else echo "Codex: $adopt"; fi
      owner="$name"
    fi
    owner="${owner:-feedback-graph}"
  fi
  if [ -n "$owner" ] && [ "$owner" != "$name" ]; then
    # Another install's block, kept as it wrote it: one block of the same guidance serves every server.
    echo "Codex: the Feedback Graph guidance in $md belongs to the install registered as $owner; left as it is (this install is the server $name)"
  elif [ -f "$md" ] && grep -q '^<!-- BEGIN feedback-graph' "$md"; then
    # A BEGIN without its own END (before the next BEGIN or the end of the file): where that block ends is unknown, and
    # rewriting it would drop everything after it.
    if ! awk '/^<!-- BEGIN feedback-graph/ { if (on) bad = 1; on = 1; next } /^<!-- END feedback-graph -->/ { on = 0 } END { exit (on || bad) ? 1 : 0 }' "$md"; then
      refuse "Codex: the Feedback Graph guidance in $md has a BEGIN marker but no $END_MARK after it; left $md unchanged (every BEGIN needs its own END: put it where that guidance ends, or remove the extra BEGIN, then re-run)"
      return
    fi
    local current
    current="$(awk '/^<!-- BEGIN feedback-graph/{on=1} on{print} /^<!-- END feedback-graph -->/{on=0}' "$md")"
    if [ "$current" = "$block" ]; then
      echo "Codex: guidance already up to date in $md"
      return
    fi
    backup "$md"
    if [ "$dry" = 1 ]; then would "update the Feedback Graph guidance between its markers in $md"; return; fi
    local tmp="$md_target.tmp.$$"
    BLOCK="$block" awk '
      /^<!-- BEGIN feedback-graph/ { if (!done) print ENVIRON["BLOCK"]; done = 1; skip = 1; next }
      skip && /^<!-- END feedback-graph -->/ { skip = 0; next }
      !skip { print }
    ' "$md" >"$tmp"
    mv "$tmp" "$md_target"
    echo "Codex: updated the Feedback Graph guidance in $md"
  else
    backup "$md"
    if [ "$dry" = 1 ]; then would "add the Feedback Graph guidance to $md"; return; fi
    local sep
    sep="$(separator "$md")"
    printf '%s%s\n' "${sep%x}" "$block" >>"$md_target"
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
exit "$failed"
