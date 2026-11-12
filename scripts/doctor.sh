#!/usr/bin/env bash
# Is everything Feedback Graph needs in place? One PASS / WARN / FAIL / SKIP line per check, and exit 1 when any check
# failed. It never prints a secret. The sole fail-safe mutation is stopping codex-runner when its live sandbox/network
# isolation check fails, so a warning cannot leave unsafe Codex jobs running.
#   ./scripts/doctor.sh
# Checks: Docker, that no other folder's install runs under this one's FG_INSTANCE, that the api and worker are not
# crash-looping or dead and the worker's heartbeat is recent, the ports the stack publishes, Ollama
# (answers, structured output with a real schema call, models pulled), from inside the containers (host.docker.internal,
# Ollama, the transcripts and Codex login mounts), the Codex login here, and GitHub and Linear through the api's checks.
set -uo pipefail
# The Compose project is this checkout's (FG_INSTANCE and COMPOSE_FILE from its .env): a shell's own value would point
# docker compose at another install's containers.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
. scripts/lib/env.sh
. scripts/lib/ollama.sh
. scripts/lib/restore-journal.sh
. scripts/lib/state-fs.sh

case "${1:-}" in
  -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

expected_url="http://localhost:$(envval API_PORT)"; expected_url="${expected_url%:}"
[ "$expected_url" != http://localhost ] || expected_url=http://localhost:8787
if [ -n "${FEEDBACK_GRAPH_URL:-}" ] && [ "${FEEDBACK_GRAPH_URL%/}" != "$expected_url" ] && [ "${FEEDBACK_GRAPH_URL%/}" != "${expected_url/localhost/127.0.0.1}" ]; then
  warn "FEEDBACK_GRAPH_URL overrides this install ($expected_url); fg and install-agent.sh may target another install"
  more "Unset FEEDBACK_GRAPH_URL for this checkout, or keep it only for an intentional remote target."
fi

if [ "$(envval OPERATOR_ALLOW)" = all ]; then
  warn "OPERATOR_ALLOW=all lets operator-token holders make every configured decision; narrow it for a shared install"
fi

# ── Docker ──────────────────────────────────────────────────────────────────────────────────────────────────────────
docker_ok=0
if ! command -v docker >/dev/null 2>&1; then fail "docker: not installed (https://docs.docker.com/get-docker/)"
elif docker info >/dev/null 2>&1; then docker_ok=1; pass "docker: the daemon answers"
else fail "docker: installed, but the daemon does not answer (start Docker Desktop, or: sudo systemctl start docker)"; fi

# One install per folder: Docker Compose names containers and volumes after FG_INSTANCE (default feedback-graph), so
# containers under this folder's name that another folder started are that folder's install, and docker compose here
# would take it over (and its data). setup.sh refuses to start then; a hand-written .env can still get here.
check_instance_env
instance="$(fg_instance)"
# Set when containers under this name are another folder's: no check below runs docker compose (or calls the api), so
# doctor never inspects, execs in or stops that install's containers.
foreign=""
if [ "$docker_ok" = 1 ]; then
  started_in="$(instance_dir "$instance")"
  if [ -z "$started_in" ]; then pass "install: no other folder runs as $instance"
  elif [ "$(physical_dir "$started_in")" = "$(physical_dir "$here")" ]; then pass "install: $instance runs from this folder"
  else
    fail "install: the containers named $instance were started from $started_in, not this folder: docker compose here would take over that install and its data"
    more "give this folder its own name and ports in .env: FG_INSTANCE=feedback-graph-$(basename "$here" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-\n' '-'),"
    more "API_PORT, NEO4J_HTTP_PORT, NEO4J_BOLT_PORT, POSTGRES_PORT and OLLAMA_PORT (see ./scripts/setup.sh --help)"
    foreign="$started_in"
    skip "containers, api and agent endpoint: not checked, since the ones answering are the install in $started_in"
  fi
fi

# A restore killed part-way (scripts/lib/restore-journal.sh): the stack it stopped stays down, and while the store may be
# the backup's but state/ is not the worker does not start. Not when the containers under this name are another folder's.
[ -n "$foreign" ] || case "$(restore_status)" in
  none) ;;
  running) warn "restore: one is running now (pid $(journal_get pid), from $(journal_get src)); it stops the stack while it replaces the store" ;;
  damaged) restore_note="$(restore_damaged)"; fail "restore: ${restore_note%%$'\n'*}"; more "${restore_note#*$'\n'  }" ;;
  untouched) restore_note="$(restore_interrupted untouched)"; warn "restore: ${restore_note%%$'\n'*}"; more "${restore_note#*$'\n'  }" ;;
  before) restore_note="$(restore_interrupted before)"; warn "restore: ${restore_note%%$'\n'*}"; more "${restore_note#*$'\n'  }" ;;
  replacing) restore_note="$(restore_interrupted replacing)"; fail "restore: ${restore_note%%$'\n'*}"; more "${restore_note#*$'\n'  }" ;;
esac

# Pinned to this checkout's name, so docker compose addresses exactly the project checked above.
compose=(docker compose -p "$instance")
store="$(envval STORE)"
if [ "$store" = postgres ] && [ -z "$(envval DATABASE_URL)" ]; then compose+=(--profile postgres); fi
# docker compose may run: Docker answers and the containers under this name, if any, are this folder's.
own=0
[ "$docker_ok" = 1 ] && [ -z "$foreign" ] && own=1
running=""
[ "$own" = 1 ] && running="$("${compose[@]}" ps --status running --services 2>/dev/null || true)"
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
    if [ "$own" = 1 ] && "${compose[@]}" port "$svc" "$inner" 2>/dev/null | grep -qE ":$host\$"; then pass "port $host ($svc): used by this Feedback Graph"; return; fi
    other="$(docker ps --filter "publish=$host" --format '{{.Names}}' 2>/dev/null | head -n 1)"
  fi
  if [ -n "$other" ]; then warn "port $host ($svc): used by the container $other, not this folder's stack (another checkout?); fine if that is the one you use"
  else fail "port $host ($svc): used by something else; stop it, or set a different port in .env"; fi
}
api_port="$(envval API_PORT)"; api_port="${api_port:-8787}"
api_bind="$(envval API_BIND)"; api_bind="${api_bind:-127.0.0.1}"
api_token="$(envval API_TOKEN)"
owner_token="$(envval FG_OWNER_TOKEN)"
# What the running containers actually publish, as "<service> <address:port>" for each binding beyond loopback: an extra
# Compose file (or COMPOSE_FILE) can publish the api on 0.0.0.0 whatever API_BIND says.
published=""
[ "$own" = 1 ] && published="$("${compose[@]}" ps --format '{{.Service}} {{.Ports}}' 2>/dev/null || true)"
exposed="$(printf '%s\n' "$published" | awk '{
  svc = $1; $1 = ""; n = split($0, b, ",")
  for (i = 1; i <= n; i++) {
    x = b[i]; gsub(/^ +| +$/, "", x)
    if (x !~ /->/) continue
    split(x, hp, "->"); ip = hp[1]; sub(/:[0-9]+$/, "", ip)
    if (ip ~ /^127\./ || ip == "::1" || ip == "[::1]" || ip == "localhost") continue
    print svc " " hp[1]
  }
}' | awk '!seen[$0]++')"
api_exposed="$(printf '%s\n' "$exposed" | awk '$1 == "api" { print $2 }' | paste -sd, - | sed 's/,/, /g')"
if printf '%s\n' "$published" | grep -q '^api '; then
  if [ -z "$api_exposed" ]; then pass "API bind: the running api is published on loopback only"
  elif [ -z "$api_token" ]; then
    fail "API bind: the running api is published on $api_exposed, beyond loopback, with no API token; publish it on 127.0.0.1 only (API_BIND, and any extra Compose file) or run ./scripts/setup.sh --yes --enable-auth"
  else
    warn "API bind: the running api is published on $api_exposed, beyond loopback; confirm the firewall/reverse proxy restricts it"
  fi
elif printf '%s\n' "$api_bind" | grep -Eq '^(127(\.[0-9]{1,3}){3}|localhost|::1|\[::1\])$'; then
  # With another folder's containers under this name, the api running is that install's: only the address configured here
  # is checked.
  if [ -n "$foreign" ]; then pass "API bind: loopback only as configured here ($api_bind); the running api was not checked, since it is the install in $foreign"
  else pass "API bind: loopback only ($api_bind; the api is not running, so this is the configured address)"; fi
elif [ -z "$api_token" ]; then
  fail "API bind: $api_bind would expose a tokenless API that anything reaching it can read; set API_BIND=127.0.0.1 or run ./scripts/setup.sh --yes --enable-auth"
else
  warn "API bind: $api_bind is reachable beyond loopback; confirm the firewall/reverse proxy restricts it"
fi
printf '%s\n' "$exposed" | awk 'NF && $1 != "api"' | while read -r svc at; do
  warn "port $at ($svc): published beyond loopback; anyone who can reach this machine can try its password"
done
if [ -n "$api_token" ] && [ -z "$owner_token" ]; then
  fail "Owner sign-in: FG_OWNER_TOKEN is missing; run ./scripts/setup.sh --yes to create it, then restart the api"
elif [ -n "$owner_token" ]; then pass "Owner sign-in: configured"
else warn "Owner sign-in: no owner token, so the UI is read-only for owner actions (Inbox, lessons, scans, settings) and any program on this machine and any container on this Docker host (OrbStack and Docker Desktop route them through the gateway) can read the API; run ./scripts/setup.sh --yes --enable-auth to sign in as owner"; fi
neo_http="$(envval NEO4J_HTTP_PORT)"; neo_bolt="$(envval NEO4J_BOLT_PORT)"
port api "$api_port" 8787
if [ "$store" != postgres ]; then
  port neo4j "${neo_http:-7476}" 7474
  port neo4j "${neo_bolt:-7689}" 7687
elif [ -z "$(envval DATABASE_URL)" ]; then
  pg="$(envval POSTGRES_PORT)"
  port postgres "${pg:-5434}" 5432
fi

# A listening runner is not enough: /health executes its real nested sandbox, without a model.
if [ -n "$(envval CODEX_RUNNER_URL)" ]; then
  runner_unsafe=0
  runner_reasons=""
  runner_flag="state/runner-control/codex-runner-disabled"
  # Read only as a plain file, and only so much of it: a container can write state/.
  if flag_reasons="$(state_read "$runner_flag" 4096 | tr -cd '[:print:]\n')"; then
    warn "Codex runner: disabled by its persisted isolation-safety flag"
    while IFS= read -r reason; do [ -z "$reason" ] || more "Reason: $reason"; done <<<"$flag_reasons"
    # setup.sh --runner-procfs-compat clears only the procfs reason; any other is cleared by hand once the probe passes.
    if [ -n "$flag_reasons" ] && printf '%s\n' "$flag_reasons" | grep -qv '^procfs:'; then
      more "Fix the isolation failure first (or choose claude-cli or an API scan provider), then delete $runner_flag and run ./scripts/doctor.sh again: its live probes must pass. --runner-procfs-compat does not clear this."
    else
      more "Clear it only by rerunning setup.sh --runner-procfs-compat after reviewing the isolation tradeoff."
    fi
  elif [ -n "$foreign" ]; then
    :
  elif [ "$docker_ok" = 1 ] && ! is_running codex-runner; then
    warn "Codex runner: configured but stopped; doctor left it stopped and did not create a safety flag"
  elif [ "$docker_ok" = 1 ] && is_running worker; then
    if runner_detail="$("${compose[@]}" exec -T worker node -e 'fetch(process.env.CODEX_RUNNER_URL.replace(/\/+$/, "") + "/health", {signal:AbortSignal.timeout(10000)}).then(async r=>{ const h=await r.json(); if(!r.ok||!h.ok||!h.sandbox) throw Error(h.error||"sandbox probe failed"); }).catch(e=>{console.error(e.message);process.exit(1)})' 2>&1)"; then
      pass "Codex runner: its nested sandbox starts successfully"
    else
      fail "Codex runner: sandbox cannot start or runner is unavailable"
      more "$runner_detail"
      runner_unsafe=1
      case "$runner_detail" in
        *proc*mount*|*mount*proc*)
          more "This is the procfs mount failure of Docker Desktop/OrbStack or Linux: review setup.sh --runner-procfs-compat (explicit opt-in removes Docker system-path protection); Claude/API avoids that exception. See docs/operations.md."
          runner_reasons="${runner_reasons}procfs: nested sandbox could not mount proc\n" ;;
        *)
          more "Rebuild codex-runner with scripts/seccomp/codex-runner.json, check AppArmor and docs/operations.md; --runner-procfs-compat does not fix this failure."
          runner_reasons="${runner_reasons}sandbox: nested sandbox startup failed\n" ;;
      esac
    fi
    # Docker Desktop implementations do not all enforce bridge-network isolation alike. Probe the actual runner,
    # including an explicit Host header (fetch() silently discards it), rather than trusting the Compose topology.
    if is_running codex-runner; then
      api_id="$("${compose[@]}" ps -q api 2>/dev/null || true)"
      api_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$api_id" 2>/dev/null | awk '{print $1}')"
      targets="host.docker.internal:$api_port"
      [ -n "$api_ip" ] && targets="$targets,$api_ip:8787"
      # Probe both this stack and common local service ports. The runner must not be able to reach another project's
      # database/cache or Feedback Graph Cloud merely because those are outside this Compose project.
      pg_probe="$(envval POSTGRES_PORT)"; targets="$targets,host.docker.internal:${pg_probe:-5434},host.docker.internal:5432,host.docker.internal:5442,host.docker.internal:6379"
      targets="$targets,host.docker.internal:${neo_http:-7476},host.docker.internal:${neo_bolt:-7689},host.docker.internal:8788"
      ollama_port="$(envval OLLAMA_PORT)"; targets="$targets,host.docker.internal:${ollama_port:-11435}"
      # Every other install on this machine too, whatever this one's ports: the default install's, and those of each
      # install setup.sh registered (their .env, running or not).
      others="8787 7476 7689 5434 11435"
      for f in "${XDG_STATE_HOME:-$HOME/.local/state}"/feedback-graph/installs/*; do
        [ -f "$f" ] || continue
        d="$(cat "$f")"
        [ -f "$d/.env" ] && [ "$(cd "$d" 2>/dev/null && pwd -P)" != "$(pwd -P)" ] || continue
        others="$others $(grep -E '^(API_PORT|NEO4J_HTTP_PORT|NEO4J_BOLT_PORT|POSTGRES_PORT|OLLAMA_PORT)=' "$d/.env" | cut -d= -f2- | tr -cd '0-9\n' | tr '\n' ' ')"
      done
      for p in $others; do case ",$targets," in *",host.docker.internal:$p,"*) ;; *) targets="$targets,host.docker.internal:$p" ;; esac; done
      if isolation_detail="$("${compose[@]}" exec -T -e FG_ISOLATION_TARGETS="$targets" codex-runner node -e '
        const http=require("node:http"), net=require("node:net");
        const targets=process.env.FG_ISOLATION_TARGETS.split(",").filter(Boolean);
        const probe=([host,port], api)=>new Promise(resolve=>{
          if(api){const r=http.request({host,port:+port,path:"/api/health",headers:{Host:"localhost"},timeout:1200},x=>{x.resume();resolve(`${host}:${port} HTTP ${x.statusCode}`)});r.on("error",()=>resolve(null));r.on("timeout",()=>r.destroy());r.end();return}
          const s=net.connect({host,port:+port});s.setTimeout(1200);s.once("connect",()=>{s.destroy();resolve(`${host}:${port} TCP`)});s.once("error",()=>resolve(null));s.once("timeout",()=>{s.destroy();resolve(null)});
        });
        Promise.all(targets.map((t,i)=>probe(t.split(":"),i<2))).then(xs=>{const open=xs.filter(Boolean);if(open.length){console.error(`runner reached protected endpoint(s): ${open.join(", ")}`);process.exit(1)}})
      ' 2>&1)"; then
        pass "Codex runner: live network probe cannot reach the API, database or host Ollama"
      else
        fail "Codex runner: container/network isolation does not hold on this Docker implementation"
        more "$isolation_detail"
        more "Codex runner is being stopped now. Choose claude-cli or an API scan provider; only restart it after the isolation probe passes."
        runner_unsafe=1
        runner_reasons="${runner_reasons}network: runner reached a protected host or service endpoint\n"
      fi
    else fail "Codex runner: configured, but its container is not running for the live isolation probe"; runner_unsafe=1; fi
  else fail "Codex runner: configured but cannot be checked from a running worker"; runner_unsafe=1; fi
  if [ "$runner_unsafe" = 1 ]; then
    printf '%b' "${runner_reasons:-isolation: runner safety probe failed\n}" | state_write "$runner_flag" ||
      more "Could not write $runner_flag (said above); the runner is stopped now but would start again with the stack."
    if "${compose[@]}" stop codex-runner >/dev/null 2>&1; then more "Stopped codex-runner: queued codex-cli jobs will remain parked."
    else more "Could not stop codex-runner automatically; stop it before allowing more jobs."; fi
  fi
fi

if [ "$own" = 1 ] && is_running neo4j; then
  memory="$(database_memory "${compose[@]}")"
  if [ -n "$memory" ]; then
    # A few KiB of swap is the kernel paging out idle memory, not pressure: swap counts from 1 MiB (shown in KiB below it).
    report="$(printf '%s' "$memory" | awk -F'[:,}]' '{printf "Neo4j memory: %.0f MiB used / %.0f MiB limit; %.0f MiB headroom; ",$2/1048576,$4/1048576,$6/1048576; if ($8 > 0 && $8 < 1048576) printf "%.0f KiB swap",$8/1024; else printf "%.0f MiB swap",$8/1048576; if ($12 != "null") printf "; %.0f MiB swap headroom",$12/1048576}')"
    if printf '%s' "$memory" | awk -F'[:,}]' '{exit !($6/$4 < 0.15 || $8 >= 1048576)}'; then
      warn "$report"; more "Increase NEO4J_MEMORY_LIMIT or lower NEO4J_HEAP_INITIAL/NEO4J_HEAP and NEO4J_PAGECACHE together; leave Docker VM headroom. The small profile is for smaller hosts, not a remedy for a container already short on headroom."
    else pass "$report"; fi
  else skip "Neo4j memory: cgroup counters unavailable"; fi
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

# ── The api and the worker: running, or crash-looping on a bad .env ─────────────────────────────────────────────────
# A service Compose restarts after each crash, or one that died, reads as "not running" below and would only be skipped.
# fatal_line <service>: the last fatal line it logged (a config error names the setting), as one line.
fatal_line() {
  "${compose[@]}" logs --no-log-prefix --tail 200 "$1" 2>/dev/null | grep '"msg":"fatal"' | tail -n 1 |
    sed -E 's/^.*"error":"(([^"\\]|\\.)*)".*$/\1/; s/\\n/; /g; s/\\"/"/g' | cut -c 1-400
}
if [ "$own" = 1 ]; then
  states="$("${compose[@]}" ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null || true)"
  for svc in api worker; do
    read -r _ st code <<<"$(printf '%s\n' "$states" | awk -v s="$svc" '$1 == s' | head -n 1)" || true
    case "$st:${code:-0}" in
      # Compose reports exit 0 for a container between restarts, whatever it exited with: no code is said.
      restarting:*) why="restarting after each crash" ;;
      # Paused or stopped on purpose: nothing it logged says why, but nothing runs (fg status calls it stale).
      paused:*) fail "$svc: paused, so it does nothing"; more "docker compose unpause $svc"; continue ;;
      exited:0) fail "$svc: stopped"; more "docker compose up -d $svc"; continue ;;
      :*) continue ;;
      exited:*) why="exited with code $code" ;;
      *) continue ;;
    esac
    fatal="$(fatal_line "$svc")"
    fail "$svc: $why${fatal:+: $fatal}"
    more "docker compose logs $svc shows why; after fixing .env, docker compose up -d"
  done
fi

# ── Inside the containers ───────────────────────────────────────────────────────────────────────────────────────────
codex_login_reported=""
if [ "$docker_ok" != 1 ]; then
  skip "containers: Docker does not answer"
elif [ -n "$foreign" ]; then
  :
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
      elif [ "${4:-}" = intentional-empty ]; then skip "$2: intentionally empty (--no-transcripts, from $3)"
      else warn "$2: mounted but empty in the worker (from $3); no sessions yet, or the folder is set wrong in .env"; fi
    else fail "$2: not readable in the worker (from $3); check the folder exists and that the containers' user may read it"; fi
  }
  claude_dir="$(expand "$(envval CLAUDE_PROJECTS_DIR)")"; claude_dir="${claude_dir:-$HOME/.claude/projects}"
  codex_dir="$(expand "$(envval CODEX_SESSIONS_DIR)")"; codex_dir="${codex_dir:-$HOME/.codex/sessions}"
  claude_empty=""; codex_empty=""
  case "$claude_dir" in */.host/empty-claude) claude_empty=intentional-empty ;; esac
  case "$codex_dir" in */.host/empty-codex) codex_empty=intentional-empty ;; esac
  # Before 0.7.6 --no-transcripts mounted empty folders in state/, which the worker can swap for a link to a host folder.
  for d in "$claude_dir" "$codex_dir"; do
    case "$d" in */state/empty-claude | */state/empty-codex) fail "transcripts: $d is in state/, which the worker can change; run ./scripts/setup.sh to move it to .host/" ;; esac
  done
  mount_check /transcripts "Claude Code transcripts" "$claude_dir" "$claude_empty"
  mount_check /codex-sessions "Codex sessions" "$codex_dir" "$codex_empty"
  if in_worker sh -c 'test -s /codex/auth.json' >/dev/null; then pass "Codex login: present in the worker"
  else skip "Codex login: none in the worker (only needed for codex-cli scans and post-mortems)"; fi
  codex_login_reported=1
fi

# ── Codex login on this machine ─────────────────────────────────────────────────────────────────────────────────────
codex_auth="$(expand "$(envval CODEX_AUTH_FILE)")"
codex_home="${CODEX_HOME:-$HOME/.codex}"
codex_configured=""
case ",$(envval COMPOSE_PROFILES)," in *,codex,*) codex_configured=1 ;; esac
! codex_job_configured || codex_configured=1
if [ -n "$codex_auth" ] && [ -s "$codex_auth" ]; then pass "Codex login: $codex_auth (CODEX_AUTH_FILE)"
elif [ -n "$codex_auth" ]; then fail "Codex login: CODEX_AUTH_FILE is $codex_auth, which is missing or empty (codex login, then run this again)"
elif [ -s "$codex_home/auth.json" ] && [ -n "$codex_configured" ]; then warn "Codex login: $codex_home/auth.json exists but is not mounted; set CODEX_AUTH_FILE=$codex_home/auth.json in .env to use codex-cli"
elif [ -z "$codex_login_reported" ]; then skip "Codex login: none (only needed for codex-cli)"; fi

# ── GitHub and Linear, as the running api sees them ─────────────────────────────────────────────────────────────────
status=""
if [ -z "$foreign" ] && command -v curl >/dev/null 2>&1; then
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
if [ -n "$foreign" ]; then
  :
elif [ -z "$status" ]; then
  skip "GitHub, Linear: the api does not answer at http://localhost:$api_port (docker compose up -d), so their tokens were not checked"
else
  pass "api: answers at http://localhost:$api_port"
  # A rebuild running now is listed with rebuilding:true; it is not a failure, unless the worker writing it is not
  # running (the api tells within its lease, about half a minute): then that write was cut short.
  worker_down=0 down_note=""
  [ "$own" != 1 ] || is_running worker || { worker_down=1; down_note=" (the worker is not running)"; }
  count="$(printf '%s' "$status" | WORKER_DOWN=$worker_down node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log((JSON.parse(s).codeMaps ?? []).filter(m=>!m.rebuilding||process.env.WORKER_DOWN==="1").length))' 2>/dev/null || echo '?')"
  case "$count:$worker_down" in
    0:0) pass "Code maps: no failed or interrupted rebuilds reported" ;;
    0:1) skip "Code maps: none reported failed, but the worker is not running (docker compose up -d), so none is rebuilt or retried" ;;
    '?':*) skip "Code maps: the api status response could not be read" ;;
    *) fail "Code maps: $count project(s) have a failed or interrupted rebuild$down_note; open their Code map cards or run fg status for details" ;;
  esac
  # A scan parked for more than a day on a model that fails its readiness probe is failed with the reason (scan/runner.ts).
  scans="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s).scans;if(!x){console.log("?");return}for(const j of x.gaveUp)console.log(`F ${j.projectKey}: ${j.error}`);for(const j of x.parked)console.log(`W ${j.projectKey} parked on ${j.provider}${j.since?` since ${j.since}`:""}`)})' 2>/dev/null || echo '?')"
  if [ "$scans" = '?' ]; then skip "Scans: the api status response does not list parked scans"
  elif [ -z "$scans" ]; then pass "Scans: none parked on an unavailable model"
  else
    while IFS= read -r line; do
      case "$line" in
        F\ *) fail "Scan: ${line#F }" ;;
        W\ *) warn "Scan: ${line#W }: a scan parked for 24 hours is failed, so fix the model or choose another one (SCAN_LLM)" ;;
      esac
    done <<<"$scans"
  fi
  connection github GitHub
  connection linear Linear
  # The worker beats every 30 s; one running but silent for 90 s (three beats) is hung, or its store write fails.
  if [ "$own" = 1 ] && is_running worker; then
    beat="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const b=JSON.parse(s).worker?.lastBeat;console.log(b?Math.round((Date.now()-Date.parse(b))/1000):"none")})' 2>/dev/null || echo '?')"
    case "$beat" in
      '?') skip "worker heartbeat: the api status response could not be read" ;;
      none) warn "worker heartbeat: none reported yet (starting?); run this again in a minute, else docker compose logs worker" ;;
      *) if [ "$beat" -le 90 ]; then pass "worker heartbeat: ${beat}s ago"
         else fail "worker heartbeat: none for ${beat}s (it beats every 30s): the worker is hung or cannot write to the store; docker compose logs worker, then docker compose restart worker"; fi ;;
    esac
  fi
fi

# Exercise the same authenticated MCP initialization agents use. This catches a newly-added or rotated API_TOKEN that
# was not propagated: status may answer while every installed agent gets 401. No response body or credential is shown.
if [ -n "$foreign" ]; then
  :
elif [ -z "$status" ]; then
  skip "MCP credential: the api is unavailable"
elif [ -z "$api_token" ]; then
  skip "MCP credential: API_TOKEN is not set (tokenless local install)"
elif curl -fsS --max-time 10 -o /dev/null -H "Authorization: Bearer $api_token" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"doctor","version":"1"}}}' \
  "http://localhost:$api_port/mcp" >/dev/null 2>&1; then
  pass "MCP credential: this install's API_TOKEN initializes the agent endpoint"
else
  fail "MCP credential: this install's API_TOKEN is refused by /mcp; rerun ./scripts/install-agent.sh after fixing it"
fi

echo
if [ "$failed" = 1 ]; then echo "Some checks failed; fix the FAIL lines above and run ./scripts/doctor.sh again."; exit 1; fi
echo "No failures."
