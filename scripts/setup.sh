#!/usr/bin/env bash
# First-time setup, safe to re-run: write .env (your project folders, generated Neo4j and Postgres passwords, on Linux
# your uid and gid) unless it exists, mount every folder in PROJECTS_DIRS (docker-compose.override.yml, generated:
# docker-compose.yml stays as shipped), create the folders Docker would otherwise create as root, and check Ollama and
# its models.
#   PROJECTS_DIRS=~/code,~/work ./scripts/setup.sh     (or answer the question)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
. scripts/lib/env.sh

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; exit 1; }; }
need docker "https://docs.docker.com/get-docker/"
need openssl "used to generate passwords"

expand() { local p="${1/#\~/$HOME}"; p="${p%/}"; printf '%s' "${p:-/}"; }

# Claude Code's transcripts (CLAUDE_PROJECTS_DIR, default ~/.claude/projects).
claude_projects="$(expand "$(envval CLAUDE_PROJECTS_DIR)")"
[ "$claude_projects" = / ] && claude_projects="$HOME/.claude/projects"

# A projects folder is a folder holding one folder per project. Suggest the folders holding the most distinct folders
# Claude Code ran in (never one inside a dot-folder, such as an agent's worktrees), then the usual places.
suggest() {
  {
    if [ -d "$claude_projects" ]; then
      find "$claude_projects" -name '*.jsonl' -type f 2>/dev/null | head -n 500 |
        while IFS= read -r f; do grep -m 1 -o '"cwd":"[^"]*"' "$f" 2>/dev/null | head -n 1; done |
        sed -e 's/^"cwd":"//' -e 's/"$//' | grep -v '/\.' | sort -u | while IFS= read -r c; do dirname "$c"; done |
        sort | uniq -c | sort -rn | awk '{ $1 = ""; sub(/^ /, ""); print }'
    fi
    for d in code Code projects Projects src dev Developer work git; do echo "$HOME/$d"; done
  } | while IFS= read -r d; do [ -d "$d" ] && [ "$d" != "$HOME" ] && [ "$d" != / ] && echo "$d"; done | awk '!seen[$0]++' | head -n 5
}

# The project folders: PROJECTS_DIRS (comma list), else PROJECTS_DIR, from the environment or .env; asked for on a
# first run in a terminal; else the best guess.
dirs_raw="$(envval PROJECTS_DIRS)"
[ -n "$dirs_raw" ] || dirs_raw="$(envval PROJECTS_DIR)"
if [ -z "$dirs_raw" ]; then
  # A best guess: a pipe stage that finds nothing (or is cut short by head) is not an error here.
  guesses="$(set +o pipefail; suggest || true)"
  first="$(printf '%s\n' "$guesses" | head -n 1)"
  if [ -t 0 ]; then
    echo "Which folders hold your projects (one folder per project inside)? Sessions are read only from folders you later select in Settings."
    [ -n "$guesses" ] && printf 'Found:\n%s\n' "$(printf '%s\n' "$guesses" | sed 's/^/  /')"
    read -r -p "Project folders, comma-separated${first:+ [$first]}: " answer
    dirs_raw="${answer:-$first}"
  else
    dirs_raw="$first"
    [ -n "$dirs_raw" ] && echo "using $dirs_raw as your projects folder (set PROJECTS_DIRS=/a,/b and re-run to change it)"
  fi
fi
[ -n "$dirs_raw" ] || { echo "no projects folder: run PROJECTS_DIRS=/path/to/your/projects ./scripts/setup.sh"; exit 1; }

dirs=()
IFS=',' read -r -a parts <<< "$dirs_raw"
for p in "${parts[@]}"; do
  p="$(printf '%s' "$p" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$p" ] || continue
  d="$(expand "$p")"
  case "$d" in /*) ;; *) echo "$p: give an absolute path (or ~/...)"; exit 1 ;; esac
  case "$d" in *:* | *'|'* | *\\* | *'"'* | *'$'*) echo "$d: a projects folder path cannot contain : | \\ \" or \$ (Docker mounts and .env lines use them)"; exit 1 ;; esac
  [ -d "$d" ] || { echo "$d does not exist; create it or fix PROJECTS_DIRS"; exit 1; }
  dirs+=("$d")
done
[ ${#dirs[@]} -gt 0 ] || { echo "no projects folder given"; exit 1; }
joined="$(IFS=,; printf '%s' "${dirs[*]}")"

# Bind-mount sources Docker would otherwise create, owned by root, on first start. (An empty ~/.codex/sessions does not
# make install-agent.sh think Codex is installed: it looks for the CLI or Codex's own config or login.)
mkdir -p state "$claude_projects"
codex_sessions="$(expand "$(envval CODEX_SESSIONS_DIR)")"
[ "$codex_sessions" = / ] && codex_sessions="$HOME/.codex/sessions"
mkdir -p "$codex_sessions"
# Placeholder for the Codex login mount, so Docker never creates a directory in its place.
[ -e state/codex-auth.json ] || : > state/codex-auth.json

# Linux: the containers run as you (HOST_UID/HOST_GID; docker-compose.yml passes them as `user:`), so they can write
# ./state and read transcripts only you may read. Elsewhere Docker Desktop maps file ownership: 1000 is fine.
run_uid="" run_gid=""
if [ "$(uname -s)" = Linux ] && [ "$(id -u)" != 1000 ]; then run_uid="$(id -u)" run_gid="$(id -g)"; fi

if [ -f .env ]; then
  echo ".env exists; leaving it alone."
  env_dirs="$(grep -E '^PROJECTS_DIRS=' .env | tail -n 1 | cut -d= -f2- || true)"
  [ -z "$(printenv PROJECTS_DIRS)" ] || [ "$(printenv PROJECTS_DIRS)" = "$env_dirs" ] ||
    echo "note: put PROJECTS_DIRS=$joined in .env too, or the next ./scripts/setup.sh run goes back to what .env says"
  if [ -n "$run_uid" ] && ! grep -qE '^HOST_UID=.' .env; then
    echo "Linux: you are uid $run_uid, and the containers run as uid 1000 unless .env says otherwise. Add these two lines to .env"
    echo "  (then docker compose up -d), so they can write ./state and read your transcripts:"
    echo "    HOST_UID=$run_uid"
    echo "    HOST_GID=$run_gid"
  fi
else
  codex=""
  [ -f "$HOME/.codex/auth.json" ] && codex="$HOME/.codex/auth.json"
  # The folders as given (one or several), so .env says what was asked for; PROJECTS_DIR is the first.
  sed -e "s|^NEO4J_PASSWORD=.*|NEO4J_PASSWORD=$(openssl rand -hex 18)|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 18)|" \
      -e "s|^PROJECTS_DIR=.*|PROJECTS_DIR=${dirs[0]}|" \
      -e "s|^PROJECTS_DIRS=.*|PROJECTS_DIRS=$joined|" \
      -e "s|^FEEDBACK_TOOL_DIR=.*|FEEDBACK_TOOL_DIR=$here|" \
      -e "s|^CODEX_AUTH_FILE=.*|CODEX_AUTH_FILE=$codex|" \
      -e "s|^HOST_UID=.*|HOST_UID=$run_uid|" \
      -e "s|^HOST_GID=.*|HOST_GID=$run_gid|" \
      .env.example > .env
  chmod 600 .env
  echo "wrote .env (projects: $joined${codex:+; codex login found}${run_uid:+; containers run as uid $run_uid})"
fi

# Every projects folder is mounted read-only. One folder needs nothing beyond docker-compose.yml (PROJECTS_DIR);
# more are mounted by a generated docker-compose.override.yml, which docker compose reads automatically.
override=docker-compose.override.yml
mark='# Generated by scripts/setup.sh from PROJECTS_DIRS in .env.'
generated() { [ -f "$override" ] && head -n 1 "$override" | grep -qF "$mark"; }
# Needed only when PROJECTS_DIRS says more than PROJECTS_DIR does: several folders, or another one.
multi_env="$(envval PROJECTS_DIRS)"
[ -n "$multi_env" ] && [ ${#dirs[@]} -eq 1 ] && [ "${dirs[0]}" = "$(expand "$(envval PROJECTS_DIR)")" ] && multi_env=""
if [ -f "$override" ] && ! generated; then
  [ -n "$multi_env" ] && echo "note: $override is your own, so PROJECTS_DIRS was not applied to it; see docs/operations.md (Install)"
elif [ -z "$multi_env" ]; then
  generated && rm -f "$override" && echo "removed the generated $override (one projects folder: docker-compose.yml mounts it)"
else
  # Inside YAML single quotes: ' doubled, and $ doubled so docker compose takes it literally.
  esc() { printf '%s' "$1" | sed -e "s/'/''/g" -e 's/\$/$$/g'; }
  yq() { printf "'%s'" "$(esc "$1")"; }
  roots="/vibe" hosts="${dirs[0]}" mounts="      - $(yq "${dirs[0]}:/vibe:ro")"
  for i in "${!dirs[@]}"; do
    [ "$i" -eq 0 ] && continue
    roots="$roots,/roots/$((i + 1))"
    hosts="$hosts,${dirs[$i]}"
    mounts="$mounts"$'\n'"      - $(yq "${dirs[$i]}:/roots/$((i + 1)):ro")"
  done
  {
    echo "$mark"
    echo '# Re-run ./scripts/setup.sh after changing PROJECTS_DIRS; edits here are overwritten.'
    echo 'x-roots: &roots'
    echo "  PROJECT_ROOTS: $(yq "$roots,/examples")"
    # The examples root as docker-compose.yml mounts it (interpolated by compose, so not escaped).
    # shellcheck disable=SC2016
    printf "  HOST_PROJECT_ROOTS: '%s,%s'\n" "$(esc "$hosts")" '${FEEDBACK_TOOL_DIR:-${PWD}}/examples'
    echo 'services:'
    for svc in worker api; do
      echo "  $svc:"
      echo '    environment: *roots'
      echo '    volumes:'
      echo "$mounts"
    done
  } > "$override"
  echo "mounted ${#dirs[@]} projects folders ($override)"
fi

# Ollama on the host, with both models, unless every job uses another provider. OLLAMA_URL is what the containers
# use; from here the same server is on localhost (the bundled ollama profile publishes 11435).
ollama_url="$(envval OLLAMA_URL)"
case "$ollama_url" in
  "" | *host.docker.internal*) ollama_url="http://localhost:11434" ;;
  http://ollama:11434*) ollama_url="http://localhost:11435" ;;
esac
models=("$(envval OLLAMA_MODEL)" "$(envval OLLAMA_EMBED_MODEL)")
models=("${models[0]:-gemma4}" "${models[1]:-nomic-embed-text}")
if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found: check yourself that Ollama answers at $ollama_url with ${models[*]} pulled"
elif tags="$(curl -fsS --max-time 5 "$ollama_url/api/tags" 2>/dev/null)"; then
  for m in "${models[@]}"; do
    case "$m" in *:*) want="$m" ;; *) want="$m:latest" ;; esac
    if printf '%s' "$tags" | grep -qE "\"(name|model)\":\"($m|$want)\""; then echo "ollama: $m is there"
    else echo "ollama: $m is missing: ollama pull $m"; fi
  done
else
  echo "Ollama does not answer at $ollama_url. Install it (https://ollama.com), start it, and: ollama pull ${models[0]} && ollama pull ${models[1]}"
  echo "  (or set CLASSIFY_LLM, POSTMORTEM_LLM, SCAN_LLM and CHECK_LLM to other providers in .env; embeddings always use Ollama)"
fi
if [ "$(uname -s)" = Linux ]; then
  echo "Linux: the containers reach Ollama through the Docker bridge, so it must listen beyond localhost:"
  echo "  sudo systemctl edit ollama  ->  [Service] Environment=\"OLLAMA_HOST=0.0.0.0\"  then  sudo systemctl restart ollama"
  echo "  (keep port 11434 closed to other machines with your firewall)"
fi

profiles=""
[ "$(envval STORE)" = postgres ] && [ -z "$(envval DATABASE_URL)" ] && [ "$(envval COMPOSE_PROFILES)" != postgres ] &&
  profiles=" (STORE=postgres: add COMPOSE_PROFILES=postgres to .env so every docker compose command includes the database)"
api_port="$(envval API_PORT)"
echo "next: docker compose up -d --build && open http://localhost:${api_port:-8787} && ./scripts/install-agent.sh$profiles"
