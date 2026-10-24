#!/usr/bin/env bash
# Setup, safe to re-run: write .env (generated Neo4j and Postgres passwords, on Linux your uid and gid) unless it exists,
# mount exactly the project folders you chose (in Settings, else PROJECTS_DIRS; docker-compose.override.yml, generated:
# docker-compose.yml mounts none and stays as shipped), create the folders Docker would otherwise create as root, and
# check Ollama and its models. In a terminal it also offers to fix what it finds: pull missing models, store a Claude
# token so post-mortems run on your Claude subscription, start (or restart) the stack and connect your agents. Without a
# terminal it only reports. Re-run it after changing the project folders in Settings: it remounts them.
#   PROJECTS_DIRS=~/code,~/work ./scripts/setup.sh     (or answer the question, or add them in Settings)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
. scripts/lib/env.sh

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; exit 1; }; }
need docker "https://docs.docker.com/get-docker/"
need openssl "used to generate passwords"

# Questions only in a terminal (FEEDBACK_SETUP_INTERACTIVE=1 asks them anyway, reading answers from stdin).
interactive() { [ -t 0 ] || [ "${FEEDBACK_SETUP_INTERACTIVE:-}" = 1 ]; }
# ask "question" y|n: true for yes; Enter takes the default.
ask() { local a=""; read -r -p "$1 " a || true; a="${a:-$2}"; case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac; }

expand() { local p="${1/#\~/$HOME}"; p="${p%/}"; printf '%s' "${p:-/}"; }

# Claude Code's transcripts (CLAUDE_PROJECTS_DIR, default ~/.claude/projects).
claude_projects="$(expand "$(envval CLAUDE_PROJECTS_DIR)")"
[ "$claude_projects" = / ] && claude_projects="$HOME/.claude/projects"

# A projects folder is a folder holding one folder per project. Suggest (never pick) the folders holding the most distinct
# folders Claude Code ran in (never one inside a dot-folder, such as an agent's worktrees), then the usual places.
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

# The project roots: the folders the containers may see, each read-only. There is no default and no guess: the folders
# saved in Settings (state/settings/project-roots.json), else PROJECTS_DIRS (comma list, from .env; PROJECTS_DIR from
# older versions), else asked in a terminal. PROJECTS_DIRS in the environment wins over all of them (and is saved).
roots_file=state/settings/project-roots.json
# The roots in the file Settings writes, one per line. Paths there never hold " or \ (the api refuses them).
saved_roots() {
  tr -d '\n' <"$roots_file" | sed -n 's/.*"roots"[[:space:]]*:[[:space:]]*\[//p' | grep -oE '"[^"]*"|\]' |
    awk '/^\]$/ { exit } { print substr($0, 2, length($0) - 2) }'
}
from=""
dirs_raw="$(printenv PROJECTS_DIRS 2>/dev/null || true)"
if [ -n "$dirs_raw" ]; then from="PROJECTS_DIRS"
elif [ -f "$roots_file" ] && grep -q '"roots"' "$roots_file"; then
  # A pipe stage that finds nothing (no roots saved) is not an error here.
  dirs_raw="$(set +o pipefail; saved_roots | paste -sd, - || true)" from="Settings"
  # Whichever changed last wins: PROJECTS_DIRS edited in .env after the roots were saved replaces them.
  env_dirs="$(envval PROJECTS_DIRS)"
  if [ -f .env ] && [ .env -nt "$roots_file" ] && grep -qE '^PROJECTS_DIRS=' .env && [ "$env_dirs" != "$dirs_raw" ]; then
    dirs_raw="$env_dirs" from="PROJECTS_DIRS in .env, changed after Settings"
  fi
elif [ -n "$(envval PROJECTS_DIRS)" ]; then dirs_raw="$(envval PROJECTS_DIRS)" from="PROJECTS_DIRS in .env"
elif [ -n "$(envval PROJECTS_DIR)" ]; then dirs_raw="$(envval PROJECTS_DIR)" from="PROJECTS_DIR in .env"
elif interactive; then
  guesses="$(set +o pipefail; suggest || true)"
  echo "Which folders hold your projects (one folder per project inside)? Only these are mounted, read-only; you can"
  echo "change them later in Settings. Sessions are read only from the projects you then select."
  [ -n "$guesses" ] && printf 'Suggestions:\n%s\n' "$(printf '%s\n' "$guesses" | sed 's/^/  /')"
  read -r -p "Project folders, comma-separated (Enter for none yet): " dirs_raw || true
  from="your answer"
fi

dirs=()
IFS=',' read -r -a parts <<< "$dirs_raw"
for p in "${parts[@]+"${parts[@]}"}"; do
  p="$(printf '%s' "$p" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$p" ] || continue
  d="$(expand "$p")"
  case "$d" in /*) ;; *) echo "$p: give an absolute path (or ~/...)"; exit 1 ;; esac
  case "$d" in *:* | *'|'* | *\\* | *'"'* | *'$'*) echo "$d: a projects folder path cannot contain : | \\ \" or \$ (Docker mounts and .env lines use them)"; exit 1 ;; esac
  if [ ! -d "$d" ]; then
    echo "$d does not exist on this machine (from $from); create it, or remove it in Settings (or PROJECTS_DIRS in .env)"
    exit 1
  fi
  case ",$(IFS=,; printf '%s' "${dirs[*]+"${dirs[*]}"}")," in *",$d,"*) continue ;; esac
  dirs+=("$d")
done
joined="$(IFS=,; printf '%s' "${dirs[*]+"${dirs[*]}"}")"
if [ ${#dirs[@]} -eq 0 ]; then
  echo "no project folders yet: nothing is mounted. Add one in Settings (Where folders come from) and run ./scripts/setup.sh"
  echo "  again, or run: PROJECTS_DIRS=/path/to/your/projects ./scripts/setup.sh"
else
  echo "project folders (from $from): $joined"
fi

# Bind-mount sources Docker would otherwise create, owned by root, on first start. (An empty ~/.codex/sessions does not
# make install-agent.sh think Codex is installed: it looks for the CLI or Codex's own config or login.)
mkdir -p state/settings "$claude_projects"
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
  # .env is kept as it is, except that PROJECTS_DIRS says which folders are mounted.
  env_dirs="$(grep -E '^PROJECTS_DIRS=' .env | tail -n 1 | cut -d= -f2- || true)"
  if [ "$env_dirs" = "$joined" ] && grep -qE '^PROJECTS_DIRS=' .env; then echo ".env exists; leaving it alone."
  else setenv PROJECTS_DIRS "$joined" && echo ".env exists; set PROJECTS_DIRS to the project folders"; fi
  if [ -n "$run_uid" ] && ! grep -qE '^HOST_UID=.' .env; then
    echo "Linux: you are uid $run_uid, and the containers run as uid 1000 unless .env says otherwise. Add these two lines to .env"
    echo "  (then docker compose up -d), so they can write ./state and read your transcripts:"
    echo "    HOST_UID=$run_uid"
    echo "    HOST_GID=$run_gid"
  fi
else
  codex=""
  [ -f "$HOME/.codex/auth.json" ] && codex="$HOME/.codex/auth.json"
  # The folders as given (none, one or several), so .env says what is mounted.
  sed -e "s|^NEO4J_PASSWORD=.*|NEO4J_PASSWORD=$(openssl rand -hex 18)|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 18)|" \
      -e "s|^PROJECTS_DIRS=.*|PROJECTS_DIRS=$joined|" \
      -e "s|^CODEX_AUTH_FILE=.*|CODEX_AUTH_FILE=$codex|" \
      -e "s|^HOST_UID=.*|HOST_UID=$run_uid|" \
      -e "s|^HOST_GID=.*|HOST_GID=$run_gid|" \
      .env.example > .env
  chmod 600 .env
  echo "wrote .env (projects: ${joined:-none yet}${codex:+; codex login found}${run_uid:+; containers run as uid $run_uid})"
fi

# Settings shows these as the saved roots, so it agrees with what is mounted (the api compares the two).
# Not when nothing was chosen at all: then there is nothing to say.
if [ -n "$from" ] && [ "$from" != Settings ]; then
  {
    printf '{\n  "roots": ['
    sep=""
    for d in "${dirs[@]+"${dirs[@]}"}"; do printf '%s\n    "%s"' "$sep" "$d"; sep=","; done
    [ ${#dirs[@]} -eq 0 ] || printf '\n  '
    printf '],\n  "updatedAt": "%s"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$roots_file.tmp" && mv "$roots_file.tmp" "$roots_file"
fi

# Exactly these folders are mounted, read-only, for the worker and the api, by a generated docker-compose.override.yml
# (docker compose reads it automatically; docker-compose.yml mounts no project folder and stays as shipped). Always
# written, also with no folders, so a folder removed in Settings is unmounted.
override=docker-compose.override.yml
mark='# Generated by scripts/setup.sh'
generated() { [ -f "$override" ] && head -n 1 "$override" | grep -qF "$mark"; }
if [ -f "$override" ] && ! generated; then
  echo "note: $override is your own, so the project folders were not mounted by it; see docs/operations.md (Install)"
else
  # Inside YAML single quotes: ' doubled, and $ doubled so docker compose takes it literally.
  esc() { printf '%s' "$1" | sed -e "s/'/''/g" -e 's/\$/$$/g'; }
  yq() { printf "'%s'" "$(esc "$1")"; }
  containers="" mounts=""
  for i in "${!dirs[@]}"; do
    containers="${containers:+$containers,}/roots/$((i + 1))"
    mounts="${mounts:+$mounts$'\n'}      - $(yq "${dirs[$i]}:/roots/$((i + 1)):ro")"
  done
  {
    echo "$mark from the project roots (Settings, or PROJECTS_DIRS in .env)."
    echo '# Re-run ./scripts/setup.sh after changing them; edits here are overwritten.'
    echo 'x-roots: &roots'
    echo "  PROJECT_ROOTS: $(yq "$containers")"
    echo "  HOST_PROJECT_ROOTS: $(yq "$joined")"
    echo 'services:'
    for svc in worker api; do
      echo "  $svc:"
      echo '    environment: *roots'
      if [ -n "$mounts" ]; then
        echo '    volumes:'
        echo "$mounts"
      fi
    done
  } >"$override"
  echo "mounted ${#dirs[@]} project folder$([ ${#dirs[@]} -eq 1 ] || echo s) ($override)"
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
  missing=()
  for m in "${models[@]}"; do
    case "$m" in *:*) want="$m" ;; *) want="$m:latest" ;; esac
    if printf '%s' "$tags" | grep -qE "\"(name|model)\":\"($m|$want)\""; then echo "ollama: $m is there"
    else echo "ollama: $m is missing: ollama pull $m"; missing+=("$m"); fi
  done
  if [ ${#missing[@]} -gt 0 ] && interactive && command -v ollama >/dev/null 2>&1 &&
    ask "Pull ${missing[*]} now (gemma4 is about 10 GB)? [Y/n]" y; then
    for m in "${missing[@]}"; do OLLAMA_HOST="$ollama_url" ollama pull "$m"; done
  fi
else
  echo "Ollama does not answer at $ollama_url. Install it (https://ollama.com), start it, and: ollama pull ${models[0]} && ollama pull ${models[1]}"
  echo "  (or set CLASSIFY_LLM, POSTMORTEM_LLM, SCAN_LLM and CHECK_LLM to other providers in .env; embeddings always use Ollama)"
fi
if [ "$(uname -s)" = Linux ]; then
  echo "Linux: the containers reach Ollama through the Docker bridge, so it must listen beyond localhost:"
  echo "  sudo systemctl edit ollama  ->  [Service] Environment=\"OLLAMA_HOST=0.0.0.0\"  then  sudo systemctl restart ollama"
  echo "  (keep port 11434 closed to other machines with your firewall)"
fi

# Post-mortems need real reasoning: with a Claude Code token they run on your Claude subscription (claude-cli);
# classifying, summaries and embeddings stay on the free local model.
if interactive && command -v claude >/dev/null 2>&1 && [ -z "$(envval CLAUDE_CODE_OAUTH_TOKEN)" ] && [ -z "$(envval POSTMORTEM_LLM)" ]; then
  echo "Post-mortems run on Ollama now. To run them on your Claude subscription instead, run  claude setup-token  in"
  echo "another terminal and paste the token it prints."
  token=""
  read -r -s -p "Paste the token (hidden; Enter to skip): " token || true
  echo
  if [ -z "$token" ]; then
    echo "skipped: post-mortems stay on Ollama (re-run ./scripts/setup.sh to add the token later)"
  else
    case "$token" in
      *[!A-Za-z0-9._-]*) echo "that does not look like a token (letters, digits, . _ - only); nothing saved" ;;
      *) setenv CLAUDE_CODE_OAUTH_TOKEN "$token" && echo "saved to .env: post-mortems now run on Claude (classifying and summaries stay on Ollama)" ;;
    esac
  fi
  unset token
fi

compose=(docker compose)
profiles=""
if [ "$(envval STORE)" = postgres ] && [ -z "$(envval DATABASE_URL)" ] && [ "$(envval COMPOSE_PROFILES)" != postgres ]; then
  profiles=" (STORE=postgres: add COMPOSE_PROFILES=postgres to .env so every docker compose command includes the database)"
  compose+=(--profile postgres)
fi
api_port="$(envval API_PORT)"
url="http://localhost:${api_port:-8787}"
if interactive && ask "Start Feedback Graph now (docker compose up -d --build; restarts it to apply .env and project folder changes)? [Y/n]" y; then
  "${compose[@]}" up -d --build
  auth=()
  api_token="$(envval API_TOKEN)"
  [ -n "$api_token" ] && auth=(-H "Authorization: Bearer $api_token")
  printf 'waiting for %s ' "$url"
  up=""
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 2 "${auth[@]+"${auth[@]}"}" "$url/api/status" >/dev/null 2>&1; then up=1; break; fi
    printf .
    sleep 2
  done
  echo
  if [ -z "$up" ]; then
    echo "not answering after 3 minutes; see: docker compose logs api worker"
    exit 1
  fi
  echo "running: $url (Settings: add project folders and choose the projects to read)"
  if ask "Connect Claude Code and Codex to it (./scripts/install-agent.sh)? [Y/n]" y; then
    ./scripts/install-agent.sh || echo "install-agent.sh did not finish; fix what it says and re-run it"
  fi
else
  echo "next: docker compose up -d --build && open $url && ./scripts/install-agent.sh$profiles"
fi
