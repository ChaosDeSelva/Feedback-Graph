#!/usr/bin/env bash
# Is everything Feedback Graph needs in place? One PASS / WARN / FAIL / SKIP line per check, and exit 1 when any check
# failed. Changes nothing, and never prints a secret (tokens are only ever sent to the service they belong to).
#   ./scripts/doctor.sh
# Checks: Docker, that no other folder's install runs under this one's FG_INSTANCE, the ports the stack publishes, Ollama
# (answers, structured output with a real schema call, models pulled), from inside the containers (host.docker.internal,
# Ollama, the transcripts and Codex login mounts), the Codex login here, and GitHub and Linear through the api's checks.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
. scripts/lib/env.sh
. scripts/lib/ollama.sh

case "${1:-}" in
  -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "usage: ./scripts/doctor.sh" >&2; exit 1 ;;
esac

failed=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
skip() { printf 'SKIP  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failed=1; }
# Further lines of the check above (how to fix it).
more() { printf '      %s\n' "$*"; }
expand() { local p="${1/#\~/$HOME}"; printf '%s' "${p%/}"; }

[ -f .env ] || warn ".env: not found; run ./scripts/setup.sh first (the checks below use the defaults)"

# ── Docker ──────────────────────────────────────────────────────────────────────────────────────────────────────────
docker_ok=0
if ! command -v docker >/dev/null 2>&1; then fail "docker: not installed (https://docs.docker.com/get-docker/)"
elif docker info >/dev/null 2>&1; then docker_ok=1; pass "docker: the daemon answers"
else fail "docker: installed, but the daemon does not answer (start Docker Desktop, or: sudo systemctl start docker)"; fi

# One install per folder: Docker Compose names containers and volumes after FG_INSTANCE (default feedback-graph), so
# containers under this folder's name that another folder started are that folder's install, and docker compose here
# would take it over (and its data). setup.sh refuses to start then; a hand-written .env can still get here.
if [ "$docker_ok" = 1 ]; then
  instance="$(envval FG_INSTANCE)"; instance="${instance:-feedback-graph}"
  started_in="$(docker ps -a --filter "label=com.docker.compose.project=$instance" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n 1)"
  physical() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
  if [ -z "$started_in" ]; then pass "install: no other folder runs as $instance"
  elif [ "$(physical "$started_in")" = "$(physical "$here")" ]; then pass "install: $instance runs from this folder"
  else
    fail "install: the containers named $instance were started from $started_in, not this folder: docker compose here would take over that install and its data"
    more "give this folder its own name and ports in .env: FG_INSTANCE=feedback-graph-$(basename "$here" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-\n' '-'),"
    more "API_PORT, NEO4J_HTTP_PORT, NEO4J_BOLT_PORT, POSTGRES_PORT and OLLAMA_PORT (see ./scripts/setup.sh --help)"
  fi
fi

compose=(docker compose)
store="$(envval STORE)"
if [ "$store" = postgres ] && [ -z "$(envval DATABASE_URL)" ]; then compose+=(--profile postgres); fi
running=""
[ "$docker_ok" = 1 ] && running="$("${compose[@]}" ps --status running --services 2>/dev/null || true)"
is_running() { printf '%s\n' "$running" | grep -qx "$1"; }

# ── Ports ───────────────────────────────────────────────────────────────────────────────────────────────────────────
listening() {
  if command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}
# port <service> <port on this machine> <port in the container>
port() {
  local svc="$1" host="$2" inner="$3" other=""
  if ! listening "$host"; then pass "port $host ($svc): free"; return; fi
  if [ "$docker_ok" = 1 ]; then
    if "${compose[@]}" port "$svc" "$inner" 2>/dev/null | grep -qE ":$host\$"; then pass "port $host ($svc): used by this Feedback Graph"; return; fi
    other="$(docker ps --filter "publish=$host" --format '{{.Names}}' 2>/dev/null | head -n 1)"
  fi
  if [ -n "$other" ]; then warn "port $host ($svc): used by the container $other, not this folder's stack (another checkout?); fine if that is the one you use"
  else fail "port $host ($svc): used by something else; stop it, or set a different port in .env"; fi
}
api_port="$(envval API_PORT)"; api_port="${api_port:-8787}"
neo_http="$(envval NEO4J_HTTP_PORT)"; neo_bolt="$(envval NEO4J_BOLT_PORT)"
port api "$api_port" 8787
if [ "$store" != postgres ]; then
  port neo4j "${neo_http:-7476}" 7474
  port neo4j "${neo_bolt:-7689}" 7687
elif [ -z "$(envval DATABASE_URL)" ]; then
  pg="$(envval POSTGRES_PORT)"
  port postgres "${pg:-5434}" 5432
fi

# ── Ollama ──────────────────────────────────────────────────────────────────────────────────────────────────────────
# OLLAMA_URL is what the containers use; from here the same server is on localhost.
ollama_url="$(envval OLLAMA_URL)"
container_ollama="${ollama_url:-http://host.docker.internal:11434}"
ollama_url="$(ollama_host_url "$ollama_url" "$(envval OLLAMA_PORT)")"
models=("$(envval OLLAMA_MODEL)" "$(envval OLLAMA_EMBED_MODEL)")
models=("${models[0]:-gemma4}" "${models[1]:-nomic-embed-text}")
classify_llm="$(envval CLASSIFY_LLM)"
probe_model=""
case "$classify_llm" in "" | ollama:*) probe_model="${classify_llm#ollama:}"; probe_model="${probe_model:-${models[0]}}" ;; esac
if ! command -v curl >/dev/null 2>&1; then
  fail "curl: not installed (the Ollama and api checks need it)"
elif tags="$(curl -fsS --max-time 5 "$ollama_url/api/tags" 2>/dev/null)"; then
  pass "ollama: answers at $ollama_url"
  missing=""
  for m in "${models[@]}" ${probe_model:+"$probe_model"}; do
    case "$m" in *:*) want="$m" ;; *) want="$m:latest" ;; esac
    printf '%s' "$tags" | grep -qE "\"(name|model)\":\"($m|$want)\"" || case " $missing " in *" $m "*) ;; *) missing="${missing:+$missing }$m" ;; esac
  done
  if [ -z "$missing" ]; then pass "ollama: models pulled (${models[*]})"
  else fail "ollama: not pulled: $missing"; more "ollama pull ${missing// / \&\& ollama pull }   (or ./scripts/setup.sh --pull-models)"; fi
  if [ -z "$probe_model" ]; then skip "ollama structured output: the classifier runs on $classify_llm"
  elif case " $missing " in *" $probe_model "*) true ;; *) false ;; esac; then skip "ollama structured output: $probe_model is not pulled"
  else
    ollama_structured_probe "$ollama_url" "$probe_model" "$(envval OLLAMA_NUM_CTX)"
    case "$PROBE" in
      ok) pass "ollama structured output: a schema-constrained call to $probe_model answered with JSON" ;;
      thinking) fail "ollama structured output: $probe_model answered only in its thinking, with no content (asked with think:false)"; ollama_thinking_fix | sed 's/^  /      /' ;;
      timeout) warn "ollama structured output: $probe_model gave no answer in time ($PROBE_DETAIL); run again once it has loaded" ;;
      notjson) warn "ollama structured output: $probe_model answered, but not with JSON: $PROBE_DETAIL" ;;
      unsupported) fail "ollama structured output: refused by this Ollama: ${PROBE_DETAIL:-HTTP 501}"; ollama_structured_fix | sed 's/^  /      /' ;;
      *) fail "ollama structured output: ${PROBE_DETAIL:-no answer}" ;;
    esac
  fi
else
  fail "ollama: does not answer at $ollama_url (install it from https://ollama.com and start it)"
fi

# ── Inside the containers ───────────────────────────────────────────────────────────────────────────────────────────
if [ "$docker_ok" != 1 ]; then
  skip "containers: Docker does not answer"
elif ! is_running worker; then
  skip "containers: the worker is not running (docker compose up -d), so host.docker.internal and the mounts were not checked"
else
  in_worker() { "${compose[@]}" exec -T worker "$@" 2>&1; }
  # Name resolution first: without it every http://host.docker.internal URL fails, Ollama's included.
  if in_worker node -e "require('node:dns').promises.lookup('host.docker.internal').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null; then
    pass "host.docker.internal: resolves inside the worker"
  else
    fail "host.docker.internal: does not resolve inside the worker (docker-compose.yml maps it with extra_hosts: host-gateway)"
  fi
  if in_worker node -e "fetch(process.env.OLLAMA_URL+'/api/tags',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null; then
    pass "ollama from the worker: answers at $container_ollama"
  else
    fail "ollama from the worker: no answer at $container_ollama"
    [ "$(uname -s)" = Linux ] && more "Linux: Ollama must listen beyond localhost (OLLAMA_HOST=0.0.0.0; see ./scripts/setup.sh)"
  fi
  # mount <container dir> <what> <host dir>
  mount_check() {
    local n
    if n="$(in_worker sh -c "test -r '$1' && test -x '$1' && ls -1 '$1' | wc -l")"; then
      n="$(printf '%s' "$n" | tr -dc 0-9)"
      if [ "${n:-0}" -gt 0 ]; then pass "$2: mounted and readable in the worker ($n entries, from $3)"
      else warn "$2: mounted but empty in the worker (from $3); no sessions yet, or the folder is set wrong in .env"; fi
    else fail "$2: not readable in the worker (from $3); check the folder exists and that the containers' user may read it"; fi
  }
  claude_dir="$(expand "$(envval CLAUDE_PROJECTS_DIR)")"; claude_dir="${claude_dir:-$HOME/.claude/projects}"
  codex_dir="$(expand "$(envval CODEX_SESSIONS_DIR)")"; codex_dir="${codex_dir:-$HOME/.codex/sessions}"
  mount_check /transcripts "Claude Code transcripts" "$claude_dir"
  mount_check /codex-sessions "Codex sessions" "$codex_dir"
  if in_worker sh -c 'test -s /codex/auth.json' >/dev/null; then pass "Codex login: present in the worker"
  else skip "Codex login: none in the worker (only needed for codex-cli scans and post-mortems)"; fi
fi

# ── Codex login on this machine ─────────────────────────────────────────────────────────────────────────────────────
codex_auth="$(expand "$(envval CODEX_AUTH_FILE)")"
codex_home="${CODEX_HOME:-$HOME/.codex}"
if [ -n "$codex_auth" ] && [ -s "$codex_auth" ]; then pass "Codex login: $codex_auth (CODEX_AUTH_FILE)"
elif [ -n "$codex_auth" ]; then fail "Codex login: CODEX_AUTH_FILE is $codex_auth, which is missing or empty (codex login, then run this again)"
elif [ -s "$codex_home/auth.json" ]; then warn "Codex login: $codex_home/auth.json exists but is not mounted; set CODEX_AUTH_FILE=$codex_home/auth.json in .env to use codex-cli"
else skip "Codex login: none (only needed for codex-cli)"; fi

# ── GitHub and Linear, as the running api sees them ─────────────────────────────────────────────────────────────────
status=""
if command -v curl >/dev/null 2>&1; then
  auth=()
  api_token="$(envval API_TOKEN)"
  [ -n "$api_token" ] && auth=(-H "Authorization: Bearer $api_token")
  status="$(curl -fsS --max-time 10 "${auth[@]+"${auth[@]}"}" "http://localhost:$api_port/api/status" 2>/dev/null || true)"
fi
# The api checks a token against the service and reports the account or what is wrong; the token itself never leaves it.
connection() {
  local kind="$1" label="$2" obj state detail
  obj="$(printf '%s' "$status" | grep -oE "\"$kind\":\{\"state\":\"[a-z_]+\"[^}]*\}" | head -n 1)"
  state="$(printf '%s' "$obj" | sed -nE 's/.*"state":"([a-z_]+)".*/\1/p')"
  detail="$(printf '%s' "$obj" | sed -nE 's/.*"detail":"(([^"\\]|\\.)*)".*/\1/p')"
  case "$state" in
    connected) pass "$label: ${detail:-connected}" ;;
    not_connected) skip "$label: not connected (${detail:-optional})" ;;
    error) fail "$label: ${detail:-error}" ;;
    *) skip "$label: the api did not report it" ;;
  esac
}
if [ -z "$status" ]; then
  skip "GitHub, Linear: the api does not answer at http://localhost:$api_port (docker compose up -d), so their tokens were not checked"
else
  pass "api: answers at http://localhost:$api_port"
  connection github GitHub
  connection linear Linear
fi

echo
if [ "$failed" = 1 ]; then echo "Some checks failed; fix the FAIL lines above and run ./scripts/doctor.sh again."; exit 1; fi
echo "No failures."
