# Operating Feedback Graph

## Install

```sh
./scripts/setup.sh            # asks for your project folders, writes .env, checks Ollama, then offers to start the stack and connect your agents
```

In a terminal, answer yes to its questions and setup does the rest: it runs `docker compose up -d --build`, waits for the API, prints the address (`http://localhost:8787`, or the `API_PORT` in `.env`) and runs `./scripts/install-agent.sh` (MCP server and guidance for Claude Code and Codex; README: Connect your agents). If you answer no, it prints the commands to run yourself:

```sh
docker compose up -d --build
open http://localhost:8787
./scripts/install-agent.sh
```

`setup.sh` is safe to re-run; it never overwrites an existing `.env`. `./scripts/setup.sh --help` lists its flags. Without a terminal (an agent, a script) flags answer the questions:

| Flag | Effect |
|---|---|
| `--yes`, `-y` | Yes to every question: pull missing models, create the tokens on a new install, start the stack, connect agents. On an existing tokenless `.env` it adds no tokens (see `--enable-auth`). |
| `--demo` | Adds this checkout's `examples/` as a project folder, selects demo-shop and, once the stack answers, seeds its demo lessons (`fg demo seed`) and prints `fg demo context`, `fg demo check` and `fg activity` to try. |
| `--enable-auth` | Adds the missing `API_TOKEN`, `FG_OWNER_TOKEN` and `FG_OPERATOR_TOKEN` to an existing tokenless install. Without a terminal it needs `--yes` too, or it fails without changing anything. |
| `--pull-models` | Pulls missing Ollama models, and nothing else unasked. |
| `--projects <dirs>` | The project folders, comma-separated (same as `PROJECTS_DIRS=<dirs>`). |
| `--select <keys>` | The projects to read (`acme,demo-shop`), written to `.env` as `INGEST_PROJECTS`; it seeds the selection until one is made in Settings. |
| `--github-token-file <f>`, `--linear-key-file <f>`, `--claude-token-file <f>` | `GITHUB_TOKEN`, `LINEAR_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` read from a file you wrote, saved to `.env` and never printed. Secrets are never taken as arguments. |
| `--skip-agents` | Never registers agents, even with `--yes`. |
| `--no-transcripts` | Mounts empty install-local transcript folders (in `.host/`) instead of your real ones. Setup refuses a transcripts folder, Codex login file or project folder inside `state/`. |
| `--small` | Uses the checked-in 1.5 GiB Neo4j profile ([Install: Memory profiles](install.md#memory-profiles)). |
| `--runner-procfs-compat` | Offers the runner-only procfs exception, after printing its security tradeoff ([below](#docker-masked-system-paths-procfs-compatibility)). `--yes` alone never enables it. |

What setup does:

- **Finds the project roots**, the folders that hold your projects (one folder per project inside). There is no default and no guess. In order: `PROJECTS_DIRS` in the environment (`PROJECTS_DIRS=~/code,~/work ./scripts/setup.sh`); the roots saved in Settings (`state/api-settings/project-roots.json`, which the api writes), unless `PROJECTS_DIRS` in `.env` was edited after them; `PROJECTS_DIRS` in `.env` (`PROJECTS_DIR` from older versions); else, in a terminal, it asks, suggesting the folders your Claude Code sessions ran in, spelled as on disk (Enter for none). Without a terminal and without any, it mounts none and says how to add one. Each folder must exist on the host, or it stops before changing anything. It writes the result to `.env` as `PROJECTS_DIRS` and to the roots file, so Settings, `.env` and the mounts agree. A folder in there that is not a git repo but holds repos (`~/src/github.com/org/repo`, `~/code/client/app`) offers each repo as a project of its own (see [Data controls](#data-controls)).
- **Mounts exactly those folders**, read-only, for `worker` and `api`. `docker-compose.yml` mounts no project folder. `setup.sh` always writes `docker-compose.override.yml`, which `docker compose` reads automatically, so `docker-compose.yml` stays as shipped and `git pull` never conflicts. It mounts each folder at `/roots/1`, `/roots/2`…, and sets `PROJECT_ROOTS` / `HOST_PROJECT_ROOTS` to list them (container and host paths, in the same order). Both are empty with no folders, which is a valid setup: everything starts, with no projects. It never touches an override you wrote yourself (one without its header line); add the mounts there by hand in that shape.
- **Changing the roots later:** in Settings (**Where folders come from**) add a folder, add a suggested one (the parent folders of sessions that ran outside every root, with their session counts), or remove one. Saving writes `state/api-settings/project-roots.json` and logs a **project roots saved** Activity entry; Settings then shows *Saved. Run ./scripts/setup.sh to mount these folders (restarts the containers).* until the mounted roots match. Roots are Docker bind mounts, so the change takes effect only when `setup.sh` regenerates the override and the containers are recreated (answer yes to its start question, or `docker compose up -d`). A root must be an absolute host path without `: | \ " $ ,`, not `/` or your home folder; at most 20.
- **Creates the folders Docker would otherwise create, owned by root**: `state/settings`, `state/runner-control`, the Claude Code transcripts folder (`CLAUDE_PROJECTS_DIR`, default `~/.claude/projects`) and the Codex sessions folder (`CODEX_SESSIONS_DIR`, default `~/.codex/sessions`). An empty `~/.codex/sessions` does not make `install-agent.sh` set up Codex: it looks for the `codex` CLI, or Codex's own `config.toml` or `auth.json`.
- **Creates the tokens** on a new install (in a terminal it asks first): `API_TOKEN` for agents, `FG_OWNER_TOKEN` for you in the browser and `FG_OPERATOR_TOKEN` for `./scripts/fg` and agents doing triage (see [Agents with the operator token](#agents-with-the-operator-token)). In a terminal it also offers to save a Claude token (`claude setup-token`) so post-mortems and Ask run on your Claude subscription.
- **On Linux, runs the containers as you**: a new `.env` gets `HOST_UID` and `HOST_GID` (your `id -u` and `id -g`) when you are not uid 1000; for an existing `.env` it prints the two lines to add (see [Linux](#linux)).
- **Writes ports from your shell to `.env`**: an `API_PORT`, `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`, `POSTGRES_PORT` or `OLLAMA_PORT` exported in the shell is saved there, so `fg`, doctor and `install-agent.sh` reach what Compose started.
- **Keeps installs apart**: a second checkout gets its own Compose name and ports, every install registers its folder in `~/.local/state/feedback-graph/`, and setup, doctor, backup, restore, `fg` and `install-agent.sh` refuse to act on another folder's containers. See [Install: A second install](install.md#a-second-install).
- **Runs one at a time per checkout**: a second setup in the same folder waits for the first (its lock is `.host/setup.lock`, which no container mounts; an old `state/.setup.lock` is removed). No lock is held while models are pulled or the stack is built.
- **Needs only Docker with the Compose plugin on the host** (and `openssl`): it checks for `docker compose` before writing anything. The scripts use Node for reading `docker compose config` when it is installed, else the same Node image the services are built from. `demo-pushback.sh` also needs the `claude` CLI.
- **Checks Ollama** on the host (`/api/tags`) and both models (`OLLAMA_MODEL`, default `gemma4`, and `OLLAMA_EMBED_MODEL`, default `nomic-embed-text`), says which `ollama pull` is missing, and checks that the classifier's Ollama model returns structured output. Ollama is needed for embeddings always, and for the other jobs unless each uses another provider.

Setup, doctor, backup, restore and `fg` never write, read or remove a path under `./state` through a link a container left there (SECURITY.md).

### Signing in

Run `./scripts/fg signin` and open the link it prints. It signs this machine's browser in as the owner once, within 60 s, only at `localhost`, `127.0.0.1` or `[::1]` and never through a proxy (opened at any other host name, it is refused and spent); the API keeps only its hash, in memory. Pasting `FG_OWNER_TOKEN` into the sign-in card still works. Never give that token to an agent.

The session cookie is named after the port it is reached on (`fg_session_<port>`), so two installs on one machine keep separate sessions. Sign-outs are saved in `state/api-settings/owner-session-revocations.json` before they take effect. If that file is missing or corrupt at startup, the API rewrites it and refuses every earlier owner session (sign in again), so deleting it cannot revive a signed-out cookie.

A **read-only install** has no tokens (one upgraded from before tokens existed, or set up with every token question answered no). The API cannot tell your browser from any other program, so owner actions are refused: the UI shows a read-only banner and disables Inbox decisions, lesson edits, scans, Ask and settings. Any program on this machine, other containers included (OrbStack and Docker Desktop route them through the gateway), can still read it. Fix it with `./scripts/setup.sh --yes --enable-auth`, then sign in and rerun `./scripts/install-agent.sh` (agents registered without a token get 401 until then). An open tab follows the change within 30 s.

### Linux

- **Ollama must listen beyond localhost:** the containers reach it through the Docker bridge (`host.docker.internal`). Run `sudo systemctl edit ollama`, add `[Service]` and `Environment="OLLAMA_HOST=0.0.0.0"`, then `sudo systemctl restart ollama`. Keep port 11434 closed to other machines with your firewall.
- **File ownership:** the api, the worker and the codex-runner run as `HOST_UID:HOST_GID` from `.env` (docker-compose.yml passes them as `user:`), 1000:1000 when they are empty. `setup.sh` fills them in with your `id -u` and `id -g` on a first run when you are not uid 1000, so the worker can write `./state` and read transcripts only you may read; on an existing `.env` it prints the two lines to add (then `docker compose up -d`). Any uid works: `HOME` in the images is `/home/fg`, writable by every uid (the agent CLIs keep their settings there), and the Codex login volume (`codex-home`) and the codex-runner scratch volume are writable by whichever uid runs the worker. The runner shares the worker's uid because each reads files only the other's owner may: the runner's token (mode 600) and the worker's repository copies (mode 700). `./scripts/check-uid.sh` (part of `check.sh`) proves it in Docker: the worker image as uid 1234 writes `worker.sqlite` in a state folder that only uid 1234 may write, and uid 1000 cannot. After changing `HOST_UID`, make `./state` yours (`sudo chown -R "$(id -u):$(id -g)" state`) if an earlier uid wrote it.

## Health

| Check | Meaning |
|---|---|
| `GET /api/health` | The API process is up (no dependencies). Open without `API_TOKEN`. |
| `GET /api/ready` | The API can reach its store (Neo4j or Postgres). 503 otherwise. The body names the store: `{"ok": true, "store": "neo4j"}`. Used by the container health check, so it is open without `API_TOKEN` (it says nothing else). |
| `GET /api/status` | Version, `store` (`neo4j` or `postgres`), whether it answers (`graph`), the worker's last heartbeat, last cycle, last error and models. `models` gives each job's model (`classify`, `postmortem`, `scan`, `summary`, `docs`, `chat`) with `ok` and, when it could not be asked, the `reason` (`SUMMARY_LLM=off` is reported as `off: true`, not as a problem); `givenUpTurns` counts turns the classifier gave up on. `ollama` says whether Ollama answers at `OLLAMA_URL` with the embedding model pulled (`url`, `ok`, `reason`); every embedding needs it, and while it does not answer each `ollama:` model is reported unavailable. `codeMaps` lists maps that are rebuilding, interrupted or failed, with `builtAt` and `checkedAt`. The UI header shows the same as a badge. |
| `POST /api/turns/requeue` | Gives the turns the classifier gave up on another try (`{"requeued": n}`). Yours only, from the UI (Inbox, when it is empty); logged in Activity as **turns re-queued**. |
| `docker compose ps` | Worker health comes from a heartbeat file the worker writes every 30 s (a timer, so long post-mortems do not look like a hang). |
| `./scripts/doctor.sh` | One PASS / WARN / FAIL / SKIP line per check, exit 1 on any FAIL (`fg doctor` runs it too). See below. |

Logs are one JSON object per line (`docker compose logs -f worker api`). The API logs method, path, status and duration, never query strings or bodies.

`doctor.sh` checks:

- **Docker and this install:** that no other folder's install runs under this one's `FG_INSTANCE` (then it checks nothing inside those containers, one SKIP line instead), and any restore killed part-way.
- **The api and the worker:** either one restarting after each crash, or exited with an error, is a FAIL with the last fatal line it logged (a bad `.env` value names the setting); one stopped (`docker compose stop`) or paused is a FAIL saying how to start it again; and so is a running worker whose heartbeat is more than 90 s old (it beats every 30 s). `fg status` likewise says `stale` rather than `ok` after 90 s without a heartbeat.
- **Ports and exposure:** each port is free or this stack's. The API bind check reads the addresses the running containers actually publish, so an extra Compose file that publishes the api (or a database) beyond loopback is reported whatever `API_BIND` says. A missing owner token, or a tokenless install, is reported with the fix.
- **Codex runner** (when `CODEX_RUNNER_URL` is set): its real nested sandbox starts, and a live network probe from inside it cannot reach this install's API, databases or Ollama, the default install's ports, or those of any other install registered on the machine. A failure stops the runner and records why (see [Docker masked system paths](#docker-masked-system-paths-procfs-compatibility)).
- **Neo4j memory:** usage, headroom and swap. It warns below 15% headroom or from 1 MiB of swap; a few KiB of swap is the kernel paging out idle memory and is shown in KiB without a warning.
- **Ollama:** it answers, the models are pulled and structured output works with a real schema call.
- **Inside the containers:** `host.docker.internal`, Ollama, the transcripts and Codex login mounts.
- **Connections and code maps:** GitHub and Linear tokens as the api checks them; any code map with a failed or interrupted rebuild (a rebuild still writing is not a failure, unless the worker is not running).
- **Agents:** an authenticated MCP initialization, as agents make it, so an `API_TOKEN` added or rotated without rerunning `install-agent.sh` shows up here instead of as 401s in every agent.

## Running it for more than one machine

1. Put it behind a TLS reverse proxy (Caddy, nginx, a cloud load balancer) that forwards `X-Forwarded-Proto`.
2. In `.env`: set distinct `API_TOKEN` and `FG_OWNER_TOKEN` (`./scripts/setup.sh --yes --enable-auth` adds them, or `openssl rand -hex 24` each), plus `PUBLIC_HOSTS=feedback.example.com` and `API_BIND=0.0.0.0`. The API refuses to start with a non-loopback `API_BIND`, or with `PUBLIC_HOSTS`, and no `API_TOKEN`.
3. Sign in once in the browser with `FG_OWNER_TOKEN` (`fg signin` links work only at localhost). Agents use the separate `API_TOKEN`: `FEEDBACK_GRAPH_URL=https://feedback.example.com ./scripts/install-agent.sh` registers the MCP server with it for Claude Code and Codex (in `~/.codex/config.toml` as a static `Authorization` header in `http_headers`; the file is then made readable by you only).

Without `API_TOKEN` the API answers only this machine, judged by socket address rather than host name; that includes other containers on this Docker host, which can read it. Never expose or proxy a read-only install. This is still one person's graph; see [Editions](editions.md) for the team edition.

## Running on Postgres

Neo4j is the default store. The same api and worker run on Postgres 17 with pgvector instead:

1. In `.env`: `STORE=postgres` and `POSTGRES_PASSWORD=$(openssl rand -hex 18)` (letters and digits only: it is placed in a URL). `setup.sh` writes a password for new installs; startup refuses an empty one with the bundled service.
2. Also `COMPOSE_PROFILES=postgres` in `.env`, so every `docker compose` command (up, down, logs, ps, and the backup scripts) includes the database without `--profile postgres`. Then `docker compose up -d --build`. The profile starts the `postgres` service (`pgvector/pgvector:0.8.7-pg17`, bound to `127.0.0.1:${POSTGRES_PORT:-5434}`, data in the `postgres-data` volume). The Neo4j container still starts, because it is the default service, but nothing connects to it.
3. `curl localhost:8787/api/ready` answers `{"ok":true,"store":"postgres"}`.

Your own server instead of the container: `DATABASE_URL=postgres://user:password@host:5432/db` (the `vector` extension, pgvector 0.8.0 or newer, and `pg_trgm`, which ships with Postgres, must be installable by that user) and no profile (`COMPOSE_PROFILES` empty). An older pgvector is refused at startup with the version found: the searches need its iterative HNSW scans, and older versions fail every search once the extension is loaded. `DATABASE_URL` is checked at startup with every other setting; its password never appears in a log or error message, whether it is in the userinfo or a `?password=` parameter.

Migrations (`packages/store-postgres/migrations`) run at startup under an advisory lock, so the api and the worker can start together; `0002_codegraph.sql` adds the code map tables. Vector searches use the HNSW indexes when the project has enough rows for that to pay, with iterative scans so a project's rows are still found when closer rows belong to other projects; small projects get an exact scan, and vectors of another length (an older embedding model) always do, so any embedding model works. The embedding-model check and `reembed` behave as on Neo4j. Text containing NUL characters (it happens in transcripts) is stored without them, since Postgres text cannot hold them; Neo4j keeps them.

Switching backend starts with an empty store: data is not copied between them. Carry lessons and code facts over with Export on the old backend and **Import bundle** on the new one (see [Data controls](#data-controls)); misses and their evidence come back as the worker re-reads the selected projects' transcripts. Keep the old backend's backup until you are happy.

## Neo4j memory

The Neo4j container has a 3 GiB limit (`NEO4J_MEMORY_LIMIT`). Its heap starts at 512 MiB (`NEO4J_HEAP_INITIAL`) and may grow to 1 GiB (`NEO4J_HEAP`), with a 512 MiB page cache (`NEO4J_PAGECACHE`), a 256 MiB transaction budget for the DBMS and for the database (`NEO4J_TRANSACTION_TOTAL_MAX`, `NEO4J_TRANSACTION_DATABASE_MAX`) and 64 MiB per transaction (`NEO4J_TRANSACTION_MAX`). Change them together to fit the Docker VM, leaving room for the OS and the other services; raising only the heap without accounting for page cache and native memory can still exhaust the VM. A transaction over its budget fails without taking the database down. See [Neo4j's memory configuration guidance](https://neo4j.com/docs/operations-manual/current/performance/memory-configuration/).

For a low-memory pilot, `./scripts/setup.sh --small` selects the supported 1.5 GiB profile; do not hand-tune only the heap. Existing installs can follow [Install: Memory profiles](install.md#memory-profiles). The code map is written in transactions that fit the small profile's 32 MiB each (2,000 rows a statement, 1,000 files at a time), so a large monorepo's map builds there too, and orphan map cleanup runs in bounded batches, so unselecting a large repository does not need one transaction holding its whole graph.

## Running codex-cli confined

Codex's read-only sandbox can read the whole filesystem it runs on, so inside the worker it could read every transcript, every project's `.env`, the worker's state and its secrets (SECURITY.md). The codex-runner service gives it a filesystem with nothing else on it. In `.env`:

```sh
COMPOSE_PROFILES=codex                      # or postgres,codex
CODEX_RUNNER_URL=http://codex-runner:8790
CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json   # setup never sets this for you
SCAN_LLM=codex-cli                          # and/or POSTMORTEM_LLM, CLASSIFY_LLM (not CHECK_LLM)
```

then `docker compose up -d --build`. `ALLOW_UNCONFINED_CODEX` is not needed and not read for these jobs.

How it works:

- **The runner container** (`codex-runner`, Dockerfile target `codex-runner`) holds Node, the Codex CLI and the runner script (`packages/core/src/llm/codexRunner.ts`), nothing else of the repo. It mounts the `codex-scratch` volume at `/scratch`, its own `codex-runner-home` volume at `/codex` with your Codex login file in it (read-only), and `state/runner-control` read-only (its safety flag). Nothing else: no transcripts, no projects, no other state, and no secrets in its environment. Its root filesystem is read-only (`/tmp` is a tmpfs), it drops every capability, and it is not published on any host port.
- **Each job:** the worker copies the repository without secret files, git metadata or heavy folders into `/scratch/fb-mirror-*` (a file whose path is too long for the scratch folder is left out), and sends the runner the prompt, that folder's name, the output schema, the model and the timeout over the compose network. The runner refuses a folder outside `/scratch`, runs `codex exec -s read-only -C <mirror>`, kills codex and everything it started when the timeout passes, and returns the exit code, the end of its output and the answer. The worker removes the copy afterwards. The runner executes one job at a time; a second job waits.
- **Per-job isolation:** each Codex process runs inside a fresh bubblewrap mount and PID namespace exposing only its own mirror at `/repo`, system runtime files, a temporary job folder and its login file. Other mirrors, the runner token and earlier jobs' Codex history are absent. An isolation failure stops the job; it never falls back to the shared container filesystem. At startup and before every job, the runner removes abandoned `fb-mirror-*` directories whose lease expired five minutes ago, keeping the current job and fresh pending copies. The worker also sweeps at startup and before making a mirror, removing a dead local worker's copies at once. Lease files are outside the mirror and never exposed to jobs.
- **The token:** the runner writes a new random token to `/scratch/.runner-token` (readable by its own uid only) every time it starts, and refuses any request without it. Only the worker and the runner mount the volume.
- **Namespace permissions:** Codex's own sandbox (bubblewrap) is what keeps the commands codex runs from writing files or reaching the network. It needs unprivileged user namespaces, which Docker's default seccomp profile refuses; without them every command codex runs fails. The runner therefore uses the checked-in deny-by-default `scripts/seccomp/codex-runner.json`: a pinned Moby default allowlist plus the namespace exceptions, with BPF, ptrace and process-memory access, kernel modules, perf and io_uring denied. It keeps no capabilities, `no-new-privileges` and a read-only root, and does not use `seccomp=unconfined`. Docker's default AppArmor profile denies bubblewrap's mount propagation changes (`bwrap: Failed to make / slave: Permission denied`) even when seccomp allows user namespaces, so the runner gets its own AppArmor setting (`CODEX_RUNNER_APPARMOR`); the other services keep theirs, and the runner is never privileged. See [Docker's AppArmor documentation](https://docs.docker.com/engine/security/apparmor/). Hosts that disable user namespaces (or deny nested namespaces through an LSM policy) fail the job with the bubblewrap diagnostic; do not bypass isolation to work around it. Rebuild the runner image after upgrading to install bubblewrap. The container integration suite covers the Docker namespace and nested sandbox checks; verify them on your own host with `./scripts/doctor.sh`.

On Ubuntu hosts that restrict unprivileged user namespaces, `apparmor=unconfined` is not enough: the kernel strips the capabilities UID mapping needs. Load the supplied named profile on the Docker host, then select it in `.env`:

```sh
sudo ./scripts/install-runner-apparmor.sh
# Set CODEX_RUNNER_APPARMOR=feedback-graph-codex-runner in .env, then recreate the runner.
docker compose up -d --force-recreate codex-runner
```

This grants user namespace permission only to the named runner policy; it does not lift Ubuntu's restriction globally or add container capabilities. Docker Desktop and hosts without this restriction can keep `CODEX_RUNNER_APPARMOR=unconfined`. CI tests both outer and nested tool namespaces under the named policy. See [Ubuntu's user namespace restrictions](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/#apparmor-unprivileged-user-namespace-restrictions).

Check it: `docker compose ps codex-runner` (healthy), `docker compose logs codex-runner` (one line per job: status and duration, never the prompt or the token). The worker's `provider` log line says `codex-cli` at startup. On Linux, the `codex-scratch` and `codex-runner-home` volumes are owned by the worker's uid like `codex-home` (see [Linux](#linux)).

### Docker masked system paths: procfs compatibility

A Docker-masked parent `/proc` can stop Linux from mounting a new private `/proc`, giving `Can't mount proc ... Operation not permitted`. The runner's `/health` starts the real outer and nested tool sandbox, without a model call, and answers HTTP 503 if either cannot start; `./scripts/doctor.sh` reports that failure. Jobs never fall back to an unconfined process.

Docker Desktop, OrbStack and Linux hosts with masked system paths (GitHub-hosted CI included) can hit this. The supported workaround is Docker's runner-only `systempaths=unconfined` option in a separate Compose file. It removes Docker's masked and read-only system-path list inside that container, so it is a security relaxation and is **not enabled automatically**. All other runner settings stay: dropped capabilities, read-only root, `no-new-privileges`, seccomp and AppArmor. The job's private mount and PID namespace still creates its own `/proc` and hides shared scratch, runner tokens and parent processes. Never apply the option to the worker or API.

On macOS there is **no AppArmor enforcement**, so with this option the runner also has **no Docker masked/read-only system-path protection**. It still runs as an ordinary uid with dropped capabilities, `no-new-privileges`, a read-only root, the checked-in seccomp allowlist and per-job bubblewrap mount, PID and user namespaces. Those do not replace the two removed protections. If that tradeoff is unacceptable, use Claude Code or an API provider for scans instead.

`./scripts/setup.sh --runner-procfs-compat` prints the tradeoff, asks, then writes the file below and adds it to `COMPOSE_FILE`, keeping the base file, the generated project mounts and any custom files. To do it by hand, first enable the runner in `.env` (`COMPOSE_PROFILES=codex`, `CODEX_RUNNER_URL=http://codex-runner:8790`). If its health check reports the procfs error and you accept the tradeoff, create this file in the repository root. Keep it separate from the generated `docker-compose.override.yml`, which setup rewrites:

```yaml
# docker-compose.runner-procfs.yml
services:
  codex-runner:
    security_opt:
      - systempaths=unconfined
```

Then add it to `.env`, keeping any other Compose files you use; the generated project-mount override must stay in the list:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.runner-procfs.yml
```

Recreate the runner and check it. Compose reads that list from `.env`, so later setup and restart commands keep both your project mounts and this choice; no host kernel setting changes:

```sh
docker compose --profile codex config --quiet
docker compose --profile codex up -d --no-deps --force-recreate codex-runner
# Run the real sandbox check from the worker. Require HTTP 200 and ok:true, sandbox:true.
docker compose exec -T worker node -e 'fetch(process.env.CODEX_RUNNER_URL + "/health").then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))'
./scripts/doctor.sh
```

To remove the exception, remove only `:docker-compose.runner-procfs.yml` from `COMPOSE_FILE` in `.env`, then recreate:

```sh
docker compose --profile codex up -d --no-deps --force-recreate codex-runner
```

A masked host then reports unhealthy again. The runner keeps its Codex login while the exception is on, so apply it only when you accept the reduced protection. Do not instead remove the runner's private PID and `/proc` sandbox, add privileged mode or disable host security controls; there is no automatic fallback, because using the host's existing `/proc` would undermine the PID isolation the readiness check tests.

**The runner-disabled flag.** When doctor stops the runner after an isolation failure, it writes `state/runner-control/codex-runner-disabled`, one line per reason (`procfs:`, `sandbox:`, `network:`). While that file exists, Compose, backup and restore commands cannot revive job execution. `./scripts/setup.sh --runner-procfs-compat` removes only the `procfs:` line. Any other reason stays until you have fixed it (or chosen Claude Code or an API scan provider), seen `./scripts/doctor.sh` pass its live probes, and deleted the file yourself. A flag from before 0.7.4 in `state/settings/` is moved to `state/runner-control/` on the next start, so deleting the new one is final. Doctor and `fg status` list every reason. While the flag exists the worker reports the runner as off on purpose: the sidebar shows one grey line, *Codex runner off: scans paused*, with the reason and the fix, instead of red error badges.

**Tests.** The Docker integration suite selects the compatibility setting explicitly in CI (`FG_TEST_RUNNER_UNMASK_SYSTEM_PATHS=1`): it first checks that the masked configuration answers 503, then recreates only the disposable test runner with the exception for the full isolation checks, keeping the named AppArmor profile, non-root user, read-only root, dropped capabilities and `no-new-privileges`. The variable does not change production Compose defaults. Without it, on a host whose masked `/proc` stops the nested sandbox (Docker Desktop, OrbStack), the suite checks that the runner reports itself not ready and refuses jobs, then skips only the sandbox tests with that reason. The network test likewise skips its direct-address check, with the reason, on a Docker that routes between bridge networks; `doctor.sh` disables the runner on such a host.

## The judge

`check_before_done` is judged in the api by `CHECK_LLM` (default: the local Ollama model; `claude-cli` and `codex-cli` are refused, since the api has no agent CLIs).

- `CHECK_CONCURRENCY` (default 2) judge calls run at once; the rest wait in line.
- A response comes back within 50 s. If the judge has not answered by then, the answer is "queued": it lists the lessons to check by hand meanwhile and says, in one line, when to call again with the same arguments. The retry joins the call already running and gets its verdict.
- That call keeps running while its retries keep coming back, for up to `CHECK_WAIT_SECONDS` (default 300). A call that runs past it fails once, and retries in the next two minutes are told so (with the lessons) instead of starting another call bound to overrun. A call nobody comes back for is abandoned.
- After ten observed calls, a check whose remaining time cannot fit the median call answers "queued" at once, and the ETA of a running call comes from the observed calls that ran longer than it has.
- A past miss is judged (or served by `get_task_context`) only when it shares a file with the work or is at least `MISS_MIN_SIMILARITY` (default 0.85) similar to it.
- In a folder that is not selected, the check answers "not judged" at once.
- Every check in a selected project leaves exactly one **pre-done check** Activity entry, including one that timed out or failed.

The queue numbers are in the structured `queue` field: see [Judge queue estimates](queue-estimates.md).

## Backups

```sh
./scripts/backup.sh                          # backups/<UTC timestamp>/{neo4j.dump or postgres.dump, state.tgz, STORE, SHA256SUMS}
./scripts/restore.sh backups/20261022T120000Z
```

Both scripts read `STORE` from `.env` and back up that store with the worker's `state/`:

- **Neo4j** (the default): Neo4j Community can only dump a stopped database, so the stack stops for the minute a backup takes. Schedule it with cron or launchd at a quiet hour. The dump (and a restore's load) runs in a one-off `neo4j-admin` container whose heap is capped at `NEO4J_ADMIN_HEAP_SIZE` from the shell's environment (default `256m`), so it cannot crowd out another Neo4j on a small Docker host; give a large graph more with `NEO4J_ADMIN_HEAP_SIZE=1g ./scripts/backup.sh`. When the dump or load fails, its log is printed.
- **Postgres** (`STORE=postgres`): `pg_dump --format=custom` takes a consistent snapshot while everything keeps running. With `DATABASE_URL` empty it dumps the bundled `postgres` service (starting it if needed); with `DATABASE_URL` set it dumps your own server, from a throwaway `pgvector/pgvector:0.8.7-pg17` container on the stack's network (the URL is passed through the environment, never on a command line). Your server must be Postgres 17 or older for that `pg_dump`.

Backups are readable by you only. `state.tgz` holds only files and folders: a link, FIFO or socket a container left in `state/` is left out and named. The redaction archive's decryption keys are never in a backup (see [Encrypted redaction archive](#encrypted-redaction-archive)).

**Restore.** `restore.sh` checks the checksums, refuses a backup of the other store (a `postgres.dump` with `STORE=neo4j`, or the reverse), asks you to type `restore` (`FORCE=1` skips that), and replaces the current store and worker state:

- **Before it stops anything**, it refuses a `state.tgz` that unpacks to more than `FG_RESTORE_MAX_STATE_MB` (default 8192) or holds more than `FG_RESTORE_MAX_STATE_FILES` entries (default 200000), one that holds links or paths outside `state/`, one larger than the space free beside `state/`, and a dump larger than the space free in the Neo4j volume or the bundled Postgres service's (a `DATABASE_URL` server is not checked). Raise the two limits in the environment for a larger worker state.
- **Worker state** is unpacked beside the live one first, so a damaged archive changes nothing.
- **Neo4j:** the stack stops, the dump is loaded into `/data/.restore` inside the database's own volume, and it replaces the database by renames only once the load has succeeded. A truncated or failed load leaves the previous database as it was.
- **Postgres:** the api and worker stop, and the whole `public` schema is replaced in one transaction committed by the script's last line, so tables a later migration added go too, and a failed or cut-short restore leaves the database as it was.
- **Afterwards** it starts again what was running. A failed restore restarts it on the previous data and says what to do next.
- **Ctrl-C** is acted on between steps, never while the store and the state are being swapped: the restore stops right after, restored, and says to run `docker compose up -d`.
- **Every browser is signed out** (sign in again): the backup's older revocation file does not hold sign-outs made after it, and the cookies' signing key in `.env` is not restored. The runner-disabled flag is carried over only from a plain file.

**Interrupted restores.** A restore keeps a journal in `.restore/` until the store and `state/` are both replaced. One killed part-way (a closed terminal, a crash) is reported by the next `restore.sh`, `backup.sh` and `doctor.sh`:

- killed while unpacking the backup, before it stopped anything: the stack runs on as it was, a backup goes ahead, and `./scripts/restore.sh --abandon` removes what it left;
- killed later but before anything was replaced: backup refuses until `./scripts/restore.sh --abandon` cleans up and starts the stack again;
- killed while replacing: the store may be the backup's while `state/` is not, so the worker refuses to start (`state/.restore-incomplete` says why) until `./scripts/restore.sh <backup>` is run again, which finishes it.

A journal with a key or value `restore.sh` never writes (a pid of 1 or less, a service list that is not service names) is refused by restore, backup and doctor rather than acted on: check that no restore is running, then remove `.restore/`.

**Refusals.** Either script stops with a message, before touching anything, when `.env` is missing, `STORE` is neither `neo4j` nor `postgres`, `STORE=postgres` has neither `DATABASE_URL` nor `POSTGRES_PASSWORD`, the containers under this checkout's Compose name were started from another folder (that install's own folder backs it up), or `FG_INSTANCE` in the environment is not the one `.env` names. Neither script leaves an anonymous Docker volume behind: their containers carry the Compose project's label and this folder's, as `docker compose run` labels its own (`docker compose down --remove-orphans` removes one a killed run left).

## Upgrades

```sh
./scripts/backup.sh
git pull && docker compose up -d --build
```

The schema is created idempotently at startup. Read `CHANGELOG.md` for anything that needs a step.

- **Missing owner token:** if the upgraded install has `API_TOKEN` but no `FG_OWNER_TOKEN`, run `./scripts/setup.sh --yes` to create it, restart the api and rerun `./scripts/install-agent.sh`.
- **No tokens at all:** `setup.sh --yes` never adds credentials to an existing tokenless `.env`; the install stays read-only for owner actions until `./scripts/setup.sh --yes --enable-auth`.
- **Installs made with `--no-transcripts`:** before 0.7.6 their empty transcript folders were in `state/`, which the worker can change. After upgrading to 0.7.6 or later (0.8.0 included), run `./scripts/setup.sh --yes` once to move them to `.host/`; until then `./scripts/doctor.sh` fails with *transcripts: … is in state/* and names that command.
- **Neo4j logs volume:** Neo4j's `/logs` is the named volume `neo4j-logs`. The first `up` after upgrading from an earlier version leaves the old anonymous logs volume behind once; `docker volume prune` removes unused anonymous volumes.
- **Learning loop (0.8.0):** the first start of 0.8.0 seeds the loop's mode from `LOOP_MODE`, else `auto`. On an install with `API_TOKEN` or `FG_OWNER_TOKEN`, `auto` means housekeeping (linking repeated misses, merging duplicate lessons, re-ranking and retiring lessons) starts applying on its own, and agent-facing changes, approving lessons included, apply on their own once your verdicts on that type earn it ([The learning loop](#the-learning-loop)). To start cautiously, set `LOOP_MODE=observe` (record only) or `LOOP_MODE=propose` (ask you about everything) in `.env` before the first `up`; after that, Settings > Learning loop or `fg loop mode` decides, and `LOOP_DISABLED=1` stops it.
- **Code map:** after an upgrade that changes the map rules, each selected project's map is rebuilt once. The first upgrade to a version with the code map also re-reads the selected projects' transcripts (to record which files each session touched; re-reading is idempotent). Both run beside ingest; expect the first cycle to take longer.

## Changing the embedding model

The graph records which model embedded it. If you change `OLLAMA_EMBED_MODEL`, the services refuse to start and say so. Re-embed everything:

```sh
docker compose stop worker api
docker compose run --rm worker node src/reembed.ts
docker compose up -d
```

It is resumable: if it stops part way (a crash, Ollama going away), run it again with the same `OLLAMA_EMBED_MODEL` and it embeds only what is left. Running it with a different model starts over.

## Similarity thresholds

Every similarity bar is in `packages/core/src/thresholds.ts`, with why it has its value. Two units: a **score** is what
the vector searches return, (1 + cos) / 2; a **cosine** is the plain cosine of two stored embeddings.

| Bar | Unit | Value | What it gates |
|---|---|---|---|
| `SERVE_BY_MEANING` | score | 0.78 | A miss, fact, doc or lesson found by meaning alone is served only at or above it. |
| `DUPLICATE_FLAG` | cosine | 0.92 | Two lessons of one project are flagged `duplicate-of`. |
| `AUTO_MERGE` | cosine | 0.95 | The learning loop merges two approved lessons on its own only at or above it. |
| `NEAR_DUPLICATE_FROM` | cosine | 0.85 | From here up to `DUPLICATE_FLAG`, the loop asks its model whether two lessons say the same thing; a yes is a proposal. |
| `INBOX_WORD_OVERLAP`, `INBOX_MERGE_MINUTES` | share, minutes | 0.6, 60 | An agent's report and a flagged turn are one Inbox item: the same session, or this share of words within this time. |
| `INBOX_SEMANTIC_COSINE`, `INBOX_SEMANTIC_DAYS` | cosine, days | 0.85, 3 | The same, by meaning: a reworded or next-day report joins the item. |

**Retrieval eval.** `node scripts/retrieval-eval.ts` (local Ollama only; `--model`, `--floor`, `--json`) runs the
labelled acme corpus (`packages/core/src/testing/lessonCorpus.ts`: 30 lessons, 10 tasks, 2 of them nonsense) through
the embedding model and the serving path, and prints precision and recall per task and overall, and how each floor
separates the lessons that apply from the rest. Its run on 2026-11-12 with `nomic-embed-text`:

| | Precision | Recall |
|---|---|---|
| Vector ranking @1 | 0.88 | 0.81 |
| Vector ranking @3 | 0.38 | 1.00 |
| At or above 0.78 (what `search_graph` serves) | 0.67 | 1.00 |
| `get_task_context` | none served | 0.00 |

The nonsense tasks were served nothing. All 9 applying lessons scored 0.787 to 0.959; non-applying lessons in a task's
top 5 scored 0.698 to 0.829. At 0.78 all 9 are kept and 7 others let in; at 0.80, 7 of 9 and 2 others; at 0.75, all 9
and 32 others. So 0.78 stays. `get_task_context` serves no lesson by meaning alone (since 0.8.3 a lesson reaches a task
through its triggers or a named file), so its recall here is 0 by design; `search_graph` is where meaning matters. The
duplicate, merge and Inbox bars are not measured by this corpus and keep their values.

## Data controls

- **Project selection:** you choose which project folders are read; nothing is read until you do. The choice is stored in the graph (`ProjectSelection`), so it survives restarts and both services see it. The worker lists every project folder under the roots each cycle (`GET /api/settings/projects`): each top-level folder, except that a folder which is not a git repo itself but holds git repos one or two levels down (`~/src/github.com/org/repo`, `~/code/client/app`) offers those repos instead, each a project of its own keyed by its path with `__` between the parts (`github.com__org__repo`). A session belongs to the deepest repo its cwd is in; one that ran in such a folder outside all of its repos belongs to the folder itself, which is then listed too. A top-level folder you already selected (or excluded) as a whole stays one project: unselect it to have its repos listed one by one. For each: whether it exists, is a git repo, its remote, how many Claude Code and Codex sessions ran in it and when it was last active. A session counts in every folder it was in: a Claude Code session from each record's cwd, a Codex session from its first lines and each later cwd switch (only the cwd is read from each line, and only the bytes added since the last pass are scanned). A session that ran only in a root itself or a folder above one (started in `~/Code`, never in one project's folder) is listed apart under **Outside the roots**: none of its turns is read, so start the agent in the project's folder. Folders that sessions ran in but that are gone are listed as missing; sessions outside every root are only counted (add a root to make them selectable). Selecting a folder reads its sessions from the next cycle; unselecting stops reading it and keeps its data. The selection gates ingest (Claude Code and Codex, per session, so a session that moved into a selected folder is read from there: the turns typed after it moved to another project's folder are stored as a session of that project, `<id>#2`), memory import, scans, GitHub sync and MCP context. A second clone of a project (an alias folder, or a folder whose remote an existing project already has) follows that project: it is read when that project is selected, ticking it selects that project, and it is never made an alias of a project you have not selected. A folder saved in your selection that has since become a clone, or been excluded, is dropped from the list when you next save (Activity says so) instead of blocking the save.
  - `INGEST_PROJECTS` only seeds the selection on the first start of a version with selection (an install with `INGEST_PROJECTS=demo-shop` keeps reading exactly demo-shop). With it empty, an **upgrade** selects the projects you invested in: those holding approved lessons, confirmed feedback, docs or scans (never one in `EXCLUDE_PROJECTS`), so agents keep getting the lessons you approved; Activity (**projects selected**) lists them and says why. Review the choice in Settings. A new install, or an upgrade with none of those, selects nothing, logs that in Activity, and the header says **no projects selected**. After that `INGEST_PROJECTS` is ignored (the worker logs so if it differs).
  - **Global lessons reach every folder you have not excluded.** An agent working in a folder under a root that is not selected still gets the approved lessons scoped **global** from `get_task_context` (and nothing of that folder's own: its sessions are not read, so it has no misses, facts or code map). The answer says the folder is not selected and that it can be selected in Settings. `check_before_done` there answers "not judged" at once. A folder in `EXCLUDE_PROJECTS`, or a clone of an excluded project, gets nothing at all. The other MCP tools answer only for selected projects; outside them they say the folder is not tracked and point to Settings.
  - `EXCLUDE_PROJECTS` is a hard deny on top: an excluded folder is never read, scanned or served, cannot be selected, and an alias of an excluded project is excluded too.
  - **Remove unselected data:** `POST /api/settings/cleanup` with `{"confirm": "remove-unselected"}` (from the UI) deletes everything learned from projects that hold data but are not selected, and logs it; data filed under a clone of a selected project is kept. It is refused until a selection has been made. Cleanup and project delete wait for the worker to finish the transcript it is writing, and the worker checks the selection again before writing each one, so a cycle part way never writes a deleted project back. The worker then forgets which of those folders' transcripts and memory files it read, so selecting one again reads its whole history again (deleting a project that is still selected does not: only new sessions are read).
- **Codex sessions:** `~/.codex/sessions` (or `CODEX_SESSIONS_DIR`) is mounted read-only at `/codex-sessions`. Rollout files are streamed line by line (they can pass 800 MB); a large file that keeps growing is re-read at most every 10 minutes. Sessions run by Codex's own reviewer or sub-agents are skipped. Each session is recorded with `source: codex` and goes through the same redaction, classification, Inbox and post-mortem as a Claude Code session. Agent CLIs (post-mortems, scans) are denied `/codex-sessions` like `/transcripts`.
- **Code map:** for each selected project, the worker parses the code (tree-sitter in the worker, no model, nothing sent anywhere) into files, symbols, import edges, the tests covering each file, and commits per file over 90 days. It runs beside ingest and never holds it up: a project's repo is looked at no more than every five minutes and rebuilt only when it changed (git HEAD, `git status` and the size and mtime of uncommitted files; a folder that is not a git repo is rebuilt every five minutes). Unchanged files are not parsed again. It is bounded by `SCAN_MAX_FILES` (unset: 40% of the files worth mapping, between 400 and 4000, source and files your sessions edited first), `CODE_MAP_MAX_BYTES` for source files (default 1 MB, so a large router or generated query file is still mapped) and `SCAN_MAX_BYTES` (default 80 kB) for the rest. It skips `.gitignore`d, vendor and secret files, never follows symlinks, and stores no source: paths, symbol names and line ranges only. A **Scan** maps its project first. Each build logs a **code mapped** Activity entry with its size and duration.
  - **State:** each map records when it was built (`builtAt`) and when the worker last found it current (`checkedAt`); the Code map card shows the latter as **last checked**, as do `/api/status`, `fg status`, `get_task_context`, `get_module_context` and `impact`. A rebuild still writing is reported as rebuilding, and the old map stays in use meanwhile. A write whose worker was killed reads as interrupted within about 35 s (the write renews a lease while it runs) and is redone at the next pass. A failed rebuild keeps the old map and says why, with a next step.
  - **Rebuild by hand:** **Rebuild map** on the Code map card, `./scripts/fg map rebuild <key>`, or `POST /api/projects/<key>/codemap/rebuild` remaps the project from scratch at the worker's next pass.
- **Reading the code map:** the Projects page shows each project's map (files, symbols, edges, last checked) and its hotspots, scored `4 × misses + log2(1 + churn) + log2(1 + dependents)` (misses: confirmed misses whose session edited the file; churn: commits in 90 days; dependents: files importing it). Patterns lists the top hotspots across the selected projects. The same data over HTTP, read-only: `GET /api/projects/<key>/codemap/hotspots?limit=50` (`{meta, capped, hotspots}`; `meta` is null before the first build; test files are left out unless `tests=1`), `GET /api/projects/<key>/codemap/graph?limit=60` (the Graph page's Code mode: the top files by score, their neighbours, edges, misses and lessons; `tests=1` too), `GET /api/projects/<key>/codemap/module?path=<repo path>` (404 when the file is in neither the map nor its import index; a file past the cap answers from the index with `outside: true` and no symbols), `GET /api/projects/<key>/codemap/impact?path=<a>&path=<b>&depth=3` (depth 1 to 5) and `GET /api/codemap/hotspots?limit=10[&project=<key>][&tests=1]`. All of them answer for selected projects only: any other key, or one in `EXCLUDE_PROJECTS`, is a 404 that says to choose it in Settings. Agents get it through MCP: `get_module_context` (for a file past the cap it parses the file's symbols on demand), `impact`, the code map section of `get_task_context` when they pass `files` (files the map does not hold on one line per reason; that call also serves the facts on the named files and their folders first, then at most three from elsewhere, and lists the AGENTS.md / CLAUDE.md files on the named files' path, nearest first, a named folder's own included and none that links to a secret file; a file name may have spaces, named in `files` or quoted in the task), and the `files_changed` check of `check_before_done`. A file the map does not hold (a new one, most often) still gets its lessons: `get_module_context` lists the approved lessons whose paths or path triggers cover it, then those closest to it by meaning at or above the similarity floor, marked *check it applies*; `get_task_context` and `check_before_done` add the lessons closest to the task by meaning, marked the same, when a named or changed file is not in the map. Each of those calls is logged in Activity as **context served** (or **pre-done check**) with the tool and paths.
- **Lesson triggers:** each lesson can carry triggers (path globs, patterns for added lines, symbols) that bring it to a task or change that matches; edit them on the Lessons page (**Triggers**). Lessons whose triggers were worked out by older rules get them worked out again once, with no model, leaving those you set (Activity says how many triggers there were before and after). Lessons stored without triggers get them from the worker's backfill, a few per round once the post-mortems have nothing to do (it needs a post-mortem model), changing nothing else. The same pass suggests a broader "applies when" for a lesson flagged *"applies when" too narrow*; it is shown on the lesson with **Use it**, and never applied for you.
- **Agent reports and the detector:** an agent's `report_feedback` (from `/postmortem`, or a miss the developer did not put in words) and the detector can flag the same miss. A report within 60 minutes of a flagged turn in the same project, whose words mostly match that turn's or that comes from the same session (`session_id`, optional), is merged into one Inbox item: reported after the detector, it is added to the detector's item; reported before, the detector moves the report's item onto the real turn (so the post-mortem sees the whole session) and drops the report's stand-in session. Since 0.9.1 both are also matched **by meaning**: each flagged turn and each report is embedded when it arrives, and one within cosine 0.85 of an item's (`INBOX_SEMANTIC_COSINE`) within 3 days (`INBOX_SEMANTIC_DAYS`) joins it, so a reworded complaint or the same one the next day is one item; a flagged turn close in meaning to a pending item of the same project joins it too. With the embedding model down, matching falls back to words and session. Items flagged before 0.9.1 have no embedding and match by words only. A report you already confirmed or rejected stays as it is, and the detector is recorded as a second source; a detector item you rejected is never merged into. Each Inbox item carries `origins` (`detector`, `agent`, or both) and the agent's `agentReport` (its words, what it had done, when, and its session id). The Inbox and Lessons label such items *agent report*.
- **Memory import:** Claude Code feedback memories (`type: feedback` notes in a selected project's memory folder) become project lessons with source `memory`. By default they are **proposed**: they wait in Lessons for your approval and are not served to agents until you approve them. `MEMORY_AUTO_APPROVE=true` approves them on import. A file that changes is imported again and updates its lesson until you edit, approve or reject that lesson; from then on the lesson is yours and a new version of the file never changes it. Each import is logged in Activity as **memory imported**.
- **Instruction files in post-mortems:** a post-mortem reads `CLAUDE.md` and `AGENTS.md` in the project folder and in each parent folder up to the project root it is mounted under (folders above the mount are not visible to the worker), plus the session's Claude Code memory notes. Each is labelled by kind and by whether the session's agent loads it: Claude Code sessions load CLAUDE.md and memory, Codex sessions load AGENTS.md, and that agent's files are listed first. Only a loaded file counts as context the agent had (`context_available_ignored`). Codex's personal `~/.codex/AGENTS.md` is not mounted into the worker, so post-mortems do not see it. AGENTS.md is cited with its own kind (`agents_md`).
- **Files touched by sessions:** ingest records which repo files each session read and edited (from Read, Edit, Write, MultiEdit, NotebookEdit and Codex patch calls), as paths relative to the project folder; paths outside it and secret files are dropped. A miss is linked to the files its session edited, and to where the fix landed (files edited after the feedback). That is what ranks a project's hotspots and scopes a post-mortem's lesson to files.
- **Session summaries:** the worker's summarize stage runs beside ingest (never holding it up) for the selected projects' sessions. Each session keeps a cursor: the index and time of the last turn its summary covers. Once a session has been quiet for `SUMMARY_QUIET_MINUTES` (10), or `SUMMARY_MAX_DELTA_TURNS` (40) turns are waiting, only the turns after the cursor (your words, the agent's replies, its tool names and file paths, never commands; redacted) are sent with the previous summary, and the model (`SUMMARY_LLM`, default the local Ollama model) returns the merged summary, checked against its schema; the cursor moves to the last turn sent (at most 80 per update, so a long backlog takes a few passes). A delta of more than 20 turns is summarized in parts, then merged. An answer that is not a valid summary is asked again once; a second bad answer keeps the previous summary and backs the session off (5 minutes, doubling, up to 6 hours). A model that cannot be asked moves no cursor and costs nothing: the stage waits for the next cycle. Quiet for `SESSION_IDLE_MINUTES` (30) and summarized to its last turn, a session is **idle**; a new turn makes it **active** again and extends the summary. Sessions from before summaries are backfilled newest first, `SUMMARY_BACKFILL_PER_CYCLE` (3) per cycle. Each update is logged in Activity as **session summarized** (the turns it took in, chunks, model calls) and kept in the session's update history. `SUMMARY_LLM=off` turns the stage off. REST: `GET /api/sessions?project=&state=&cursor=` (newest first; `next` is the cursor of the following page), `GET /api/sessions/<id>` (summary, history, the Inbox items from the session and their lessons) and `POST /api/sessions/<id>/resummarize` (yours only, from the UI: rebuild from the first turn; refused when retention already removed turns it would need). MCP: `get_recent_sessions`, and a one-line-each list of the three most recent sessions in `get_task_context`. Summaries come from transcripts, so they are redacted before they are stored and are never part of an export bundle or a team sync; deleting a project deletes them.
- **Retention:** `TURN_RETENTION_DAYS` (empty by default: keep everything) removes the text of classified turns older than that many days, except in sessions that hold flagged feedback (their post-mortems need every turn). While summaries are on, a turn also keeps its text until its session's summary covers it (and while a rebuild is waiting); summaries themselves are never removed.
- **Export:** Projects page → **Export lessons, misses and facts (JSON)**, or `GET /api/export?project=<key>` (`&approved=1` for approved lessons only). A versioned JSON bundle of lessons (with their triggers), misses with their evidence, current facts, document metadata, the code map's file paths with their hotspot numbers (`codeFiles`: churn, misses, dependents, score; no source, symbols or edges) and each project's git remote (`projects: [{key, remote}]`, so clones in differently named folders can be matched). No raw transcripts, no session summaries, no vectors. With knowledge intake on, three more sections: `claims` (those you accepted, and those superseded by a conflict you settled: statement, type, who said it, when, scope; the quote only with `&quotes=1`), `conflicts` (those you settled or dismissed: both sides, your choice, note and reason) and `people` (the display names of who said them; never aliases). A source's text, its questions, unreviewed or rejected claims and open conflicts are never exported. Readers must ignore fields they do not know: added fields keep `schemaVersion: 1`.
- **Import:** Projects page → **Import bundle**, or `POST /api/import` with the bundle as the JSON body (`?keepApproved=1` keeps approved lessons approved). Yours only, from the UI, like every other write that teaches agents. The bundle must be `format: "feedback-graph-export"` with `schemaVersion: 1` (a newer one is refused with a message; fields this version does not know are ignored), is validated field by field, may be at most 50 MB, and is redacted again before anything is stored. It works across machines and backends:
  - **Lessons** are matched by id and re-embedded with the current `OLLAMA_EMBED_MODEL`. A lesson whose id is already here is left alone, so importing twice changes nothing and never overrides your decision. They arrive **proposed** (revoked ones stay revoked) and reach agents only once approved, unless you tick **keep approved** (`?keepApproved=1`): then approved lessons stay approved. Rejected and superseded lessons are not imported.
  - **Facts** go, re-embedded, into a project that has no facts yet (a project scanned here keeps its own). They are attributed to `import:<the model that found them>`, so the first scan here reads every file again and replaces them.
  - **Knowledge intake** (with `INTAKE_ENABLED`): people are matched by name (your own as yours) or added, confirmed; claims keep their ids and statuses (accepted or superseded; decided by `import`), and an accepted one that is not an opinion files its fact again (origin `claim`), as accepting it here would; settled conflicts are made again, settled as they were with the loser superseded, where both sides are here (a lesson by its id, a claim imported with it), and are otherwise left for detection to find. A claim or conflict already here is left alone, so importing twice adds nothing. A claim fact in `facts` is never imported as a plain fact. With intake off they are counted, not imported.
  - **Not imported:** misses (their evidence is the transcript, which a bundle never holds; they come back when the project's sessions are read), document metadata (the bundle has no text; upload the doc again) and the code map (rebuilt from the code). The response counts them.
  - Projects in `EXCLUDE_PROJECTS` are never imported. Each import is logged in Activity as **bundle imported**, with what came in and what was skipped.
- **Projects by git remote:** each project records its `origin` remote, normalized (`github.com/org/repo`, or `local/<name>` for a bare repo on disk; credentials, scheme, port and `.git` dropped). Only a folder that is itself the root of a git repo has one: a folder inside another repo does not inherit it. Existing projects get theirs on the next worker cycle, without re-reading transcripts. A folder that is not yet a project and has the same remote as an existing one is recorded as that project's alias: its sessions, and MCP calls from it, go to the existing project, and Activity logs a **project alias** entry. Projects that already existed separately are never merged. A folder with no remote works as before.
- **Delete:** Projects page → **Delete project data…** (type the name). Removes every session, flag, decision, post-mortem, lesson, fact, code map, document and log entry for the project. Unselect it in Settings (or add it to `EXCLUDE_PROJECTS`) so new sessions are not read again.

## Encrypted redaction archive

When redaction changes something you or a source wrote (uploads, owner facts, imports, lesson edits, incoming facts, document text and readings, post-mortem and seeded lesson writes), the original is kept encrypted, so wording that redaction got wrong can be recovered. Untouched input is not archived.

- Each entry has its own AES-256-GCM key, wrapped by the worker's RSA public key. The API holds only the public key and the ciphertext (`state/settings/redaction-archive`, or `REDACTION_ARCHIVE_DIR`) and cannot decrypt them.
- The worker's private key is in the separate `redaction-key` Docker volume, under `private/` (`REDACTION_ARCHIVE_KEY_DIR` overrides it; it must be outside the ciphertext directory and never mounted into the API). On upgrade, the worker moves the old symmetric key out of the shared directory before the API archive starts.
- Archive directories are 0700 and files 0600. A failed archive write stops the redacting write before its original is discarded. Archive paths are excluded from scanners and agent reads, independently of `.gitignore`.
- `REDACTION_ARCHIVE_RETENTION_DAYS` (default 30, 1 to 365): the worker removes expired ciphertext at startup and hourly.
- `backup.sh` leaves out every decryption key, legacy or current. Back up a recovery key separately, mode 0600, if you need one: restoring ordinary state alone does not restore access to encrypted originals. Wording lost before the archive existed still needs the source or an older backup, and a scheduled rescan is not reported as a restoration.

**GitHub document recovery.** PR documents stored under older redaction rules are re-fetched from GitHub under the current rules, without importing historical PR documents; this has its own versioned checkpoint, even where an older repair recorded `done`. It checks at most five retained masked documents per project per pass. Per-document fingerprints tell source text that literally says `[REDACTED]` from repaired text and from credentials that stay protected, so verified documents are not fetched again; a failed one keeps its retry time and progress. PR-state backfill saves the REST page and completed PR ids after each record, fetching metadata only. Both jobs and ordinary GitHub sync share a persisted budget of 1,200 HTTP requests per token per hour, and pause until the reported reset when GitHub reports fewer than 100 remaining; a new token has its own budget. Activity tells re-fetched documents and queued rescans from restored lessons.

## Team sync

Optional and off by default: with `CLOUD_URL` and `CLOUD_TOKEN` unset, no code path sends anything. Set both to
push project knowledge to a Feedback Graph Cloud org.

- **Settings.** `CLOUD_URL` is the cloud's base URL: `https://` (plain `http://` only to `localhost`, `127.0.0.1`,
  `[::1]` or `host.docker.internal`; inside Docker the first three are the container itself, so use
  `http://host.docker.internal:<port>` for a cloud on this machine, else https), with no user name or password in it.
  `CLOUD_TOKEN` is a personal access token from the cloud (`fgc_pat_<16 hex>_<43 characters>`, scope `sync`, a
  member role or above); create it in the cloud web app under Access tokens. `SYNC_INTERVAL_MINUTES` (5 or more)
  turns on automatic sync in the worker; empty means only **Sync now** (Settings, `fg cloud sync-now` or the admin tool `cloud_sync_now`, which the api runs).
  `SYNC_PROJECTS=a,b` narrows the projects sent; it never adds one: only projects selected in Settings, and never
  one in `EXCLUDE_PROJECTS`. `SYNC_SUGGESTIONS` (`false` by default) decides whether lessons you have not approved
  leave at all (below). These are checked at startup with every other setting; a bad token is reported without
  being echoed.
- **Local-only projects.** A project kept local is never sent, by a scheduled sync or by Sync now (forced included);
  selection and export stay local features. Mark it in Settings → Cloud sync, or with the owner-only
  `PUT /api/cloud/local-only` and `{ "projects": ["sandbox"] }`; the api and worker share this list.
  `CLOUD_LOCAL_ONLY_PROJECTS=a,b` in `.env` adds keys the UI cannot remove. The reserved `demo-shop` project and projects
  the demo seed created are always local-only, even after scans, hook activity or code-map rebuilds (a project whose
  remote merely ends in `demo-shop` is not). To share a demo-created project deliberately, send
  `{ "projects": [], "shareDemoProjects": ["demo-shop"] }` (keep any other local-only keys in `projects`); removing it
  restores the boundary. Data shared before a project became local-only is withdrawn by the next sync, not deleted
  from the cloud at once. `GET /api/cloud` lists them in `localOnlyProjects`, and the cloud preview names the reason.
- **What is sent.** One `POST <CLOUD_URL>/api/v1/sync` per project, `Authorization: Bearer <token>`, with the export
  bundle of that project (`format: feedback-graph-export`, `schemaVersion: 1`) rebuilt field by field: the project's
  key and normalized git remote, its lessons (below), misses (what was missed, the cause and its
  explanation, but an empty `feedbackText` and context items without their excerpts), current code facts, document
  metadata (title, link, no text) and `codeFiles` (paths and hotspot numbers). Everything passes redaction again on
  the way out. No transcripts, no source, no excerpts, no vectors.
  Facts from accepted intake claims go only with `SYNC_CLAIMS=true`, and never their quotes or a private source's
  ([Knowledge intake](#knowledge-intake)).
- **Which lessons.** Nothing is shared until it is approved, by you or by the learning loop (`approve_lesson`). A lesson
  or fact the loop changed on its own is sent as it was before until you **Keep** that decision or
  `LOOP_SYNC_HOLD_DAYS` (7) pass without a rollback; after that the loop's change is sent like yours. By default a
  bundle carries the approved lessons,
  plus, with its current status, any lesson the cloud already received from you (so revoking, superseding or moving
  one back to proposed demotes the team copy). A lesson you never approved (proposed, or rejected before it was ever
  sent) stays on this machine. `SYNC_SUGGESTIONS=true` sends every lesson with its status: proposed ones then arrive
  as suggestions for an admin. Approving or editing a lesson saves it locally and does not start a sync: it leaves at
  the next scheduled sync or **Sync now** (a lesson PATCH answers `{ id, status, sharing }` saying so). The record of
  what the cloud received is kept in the store (one record per cloud URL and token; the token itself is not stored),
  so it survives restarts and the worker's schedule and the api's Sync now share it. Another org, or a new token,
  starts with no record: nothing it never received is withdrawn from it, and no lesson's status is sent to it only
  because an earlier org had the lesson.
- **Your decisions follow.** Each bundle is the whole project and says `complete: true`: on the cloud, whatever you
  sent for that project before and it leaves out now is withdrawn (kept there, not served). It also lists in
  `withdrawn` the lessons, misses, docs and fact files sent before and gone now. Leaving unapproved lessons out never
  withdraws anything: what was never sent has nothing to withdraw. Approved lessons become team lessons (or wait for
  an admin when the org reviews them), proposed ones (sent because the cloud had them, or with `SYNC_SUGGESTIONS`)
  are suggestions for an admin, and a lesson you reject or that is superseded demotes the team copy. A decision an
  admin made on the cloud is never overwritten: the cloud flags it instead. A selected project that now holds nothing
  (its data deleted) is sent once as an empty complete bundle under its last remote. A project that was synced and is
  no longer in the sync list (unselected, added to `EXCLUDE_PROJECTS`, left out of `SYNC_PROJECTS` or made
  local-only) gets one last empty, complete bundle on the next sync: it names only ids already sent and the remote it
  was filed under, and takes all of it back out of the team graph, so the team copy does not linger. It then leaves
  the record (a failed one is tried again on the next sync); selecting the project again later sends it afresh. The
  cloud files a project with a shareable remote under the team; one with no remote, or a `local/` one, stays in your
  personal space in the org.
- **Retries.** 429 (another sync of the org is running), 5xx and network errors are retried: up to four attempts per
  project, never sooner than `Retry-After` (seconds or a date; a wait longer than a minute fails that project until the
  next run), otherwise 2, 4, 8 seconds. 413 (too large): when the cloud says it keeps a cut code map
  (`codeFilesPartial` in its answer), the bundle is sent again with its code map cut to the cloud's limit (else half
  the body), then half that, then none, and the result says how many code map files went; otherwise, or when even the
  bundle without its code map is too large, that project fails with what to do. 422 (rejected) fails that project. Either
  way the sync moves on to the next; 401 (bad, revoked or expired token) and 403 (no `sync` scope, or a viewer) stop the
  run. Redirects are refused, so the token only goes to `CLOUD_URL`. Backoff is per project: a project that failed on
  a scheduled run waits twice as long before its next try (doubling per failure in a row, up to a day) while the others
  keep the interval, and its next success resets it. Only a run that 401 or 403 stopped, or that threw, delays the
  whole schedule the same way. A scheduled run skips a project whose bundle has not changed since it was
  last sent (re-sending would change nothing on the cloud either), and so does **Sync now**; `fg cloud sync-now
  --force` (`POST /api/cloud/sync` with `{"force":true}`) sends every project again.
- **What is recorded.** Each run that sent, withdrew or failed something logs one **cloud sync** Activity entry: the
  cloud's host, the projects sent and taken back out, the counts sent, where the cloud filed each project and the
  first error. The worker's heartbeat (`/api/status` → `worker.cloudSync`) carries the last scheduled result and the
  next run; `/api/status` → `cloud` says whether sync is on, with the token shown as `[REDACTED]`. The token is never
  logged, stored in the graph or passed to agent CLIs.
- **REST.** `GET /api/cloud` (the card: host, schedule, projects, counts a sync would send, local-only projects, last
  result), `GET /api/cloud/progress` (the Sync now in progress, if any, and the last one's result) and
  `POST /api/cloud/sync` (Sync now; an owner route, also open to the operator token under `sync_now`, on by default,
  so `fg cloud sync-now` and the admin tool `cloud_sync_now` reach it; 409 when sync is off or already running).
- **End-to-end check.** `./scripts/cloud-sync-e2e.sh <cloud repo>` starts the cloud's docker compose under its own
  project name and port, and its own Neo4j and Postgres test containers (never the shared `docker-compose.test.yml`
  ones), makes an org and token through dev login and turns the org's review gate off (a new org reviews synced
  lessons, which would then arrive as suggestions), syncs a seeded project on both backends and checks the lesson
  arrived as a team lesson and is taken back out when the project is unselected, then removes everything it started.

## Knowledge intake

Off by default. With it on, transcripts of calls and notes are read into proposed claims and questions for you to
review on the Intake page ([guide](guide.md#intake)), and claims, facts and approved lessons are checked against each
other for conflicts you settle. Agents only ever see the claims you accept.

- **Turning it on.** Set `INTAKE_ENABLED=1` in `.env` (`1`, `true`, `yes` or `on`) and run `docker compose up -d`, so
  both the api and the worker restart with it. **Intake** then appears in the sidebar's Review group, between Inbox and
  Ask, and `/api/status` reports `intake.enabled`. Unset, the intake routes answer 404, the MCP tools
  `find_contradictions`, `what_do_we_know` and `submit_notes` are not offered, and the worker's intake stages do not run. Turning it off
  again keeps what was stored; claims already accepted stay facts.
- **Adding a source.** **Add a source** on the Intake page's Sources tab, or `POST /api/intake` with `projectKey`, `title` and `text` (txt, md, vtt or srt; up to 2,000,000
  characters), and optionally `kind` (`transcript`, the default, `notes` or `doc`), `occurredAt`, `participants`,
  `origin` and `private`. Over 64 chunks it answers 202 and is stored in the background. It is an owner route, reads
  included; the operator token may add sources under the `intake` verb (on by default), which is also how the admin
  MCP tool `intake_submit` reaches it. An agent hands you its notes with `submit_notes` (below).
- **Settings.**

  | Variable | Default | What |
  |---|---|---|
  | `INTAKE_ENABLED` | off | Turns knowledge intake on. |
  | `INTAKE_LLM` | `DOCS_LLM`, then `SCAN_LLM`, then the local model | The model that reads sources into claims and questions, skipping any the allow list refuses. Its health shows on the Dashboard as *intake reader*. |
  | `INTAKE_PROVIDER_ALLOW` | `ollama,claude-cli` | The providers what people said may be sent to. An `INTAKE_LLM` or `CONFLICT_LLM` outside it stops the services at startup with a configuration error. Add `openai` or `anthropic` only if you accept sending transcripts to that API. |
  | `INTAKE_LLM_CALLS_PER_DAY` | 200 | Extraction's model calls a day. Past it a source waits for the next day and says so; `0` reads nothing. |
  | `INTAKE_ARCHIVE` | on | `off` keeps no source's original text in the [redaction archive](#encrypted-redaction-archive). |
  | `CONFLICT_LLM` | intake's model | The judge of candidate conflicts, held to `INTAKE_PROVIDER_ALLOW` since it reads what people said. |
  | `CONFLICT_LLM_CALLS_PER_DAY` | 60 | The judge's calls a day; `0` keeps only the deterministic checks, so no new conflict is recorded. |
  | `CONFLICT_SWEEP_MINUTES` | 360 | How often the sweep pages through current facts and approved lessons for conflicts. |
  | `SYNC_CLAIMS` | `false` | `true`: facts with origin `claim` (accepted claims) go to [team sync](#team-sync) too; see below. Needs `CLOUD_URL` and `CLOUD_TOKEN`. |
  | `SYNC_PEOPLE` | `false` | `true`: a synced claim fact names who said it; otherwise it says "a participant". Needs `SYNC_CLAIMS=true`. |

  `SYNC_CLAIMS` and `SYNC_PEOPLE` can also be set on Settings' Cloud sync tab (or `PUT /api/cloud/intake-sharing` with
  `{claims, people}`, operator verb `settings`): that choice is stored and overrides `.env`'s, for both the api's Sync
  now and the worker's schedule, and is logged in Activity (`cloud_settings_changed`). In `.env` they take only `true` or `false`; a value that breaks a rule above stops the services at
  startup with a configuration error. The candidate threshold (cosine 0.72 to a neighbour, 0.85 to go to the judge
  with no differing value) is fixed, not a setting.
- **Privacy.**
  - Credentials and contact details (e-mail addresses, phone numbers, URL query tokens) are redacted before the text
    is stored and before any model call. The original goes to the encrypted redaction archive, as uploads do, unless
    `INTAKE_ARCHIVE=off`.
  - Speakers reach the model only as S1, S2, ..., and the list of who was there is never sent. Names spoken inside the
    text cannot be found reliably and do reach the model, which is why the default is the local one.
  - Sources are private by default: a transcript and an agent's notes are marked private unless you send
    `private: false`; notes and docs you add are not.
  - Transcript text, quotes, questions and sources are never served to agents, exported or synced. The doc searches
    behind `get_task_context`, its brief, `search_graph`, linked-project context and post-mortem context hunts leave
    intake sources out, and the ordinary document reader never reads one into facts.
  - **Cloud sync.** A fact with origin `claim` never goes to the cloud unless `SYNC_CLAIMS=true`. Even then its quote
    never goes, a fact from a private source never goes, and the speaker is named only with `SYNC_PEOPLE=true`
    (otherwise "a participant"). Open conflicts and questions never go. A claim fact that is superseded (it lost a
    conflict) or deleted is withdrawn from the cloud on the next sync, as other withdrawn items are.
- **Deleting a source.** On the Sources tab, or `DELETE /api/intake/sources/:id?keep=facts|none` (the operator token
  needs `docs_delete`).
  - `keep=facts` (the default) removes the text, its chunks, the claims you have not accepted and its questions, and
    its archived original in the redaction archive. Claims you accepted stay, as the facts they became.
  - `keep=none` also closes the facts its claims became. That is recorded as a `remove_source` decision by you on the
    Decisions page, and rolling it back re-opens them. Every claim from it goes whatever its status (with the
    conflicts it is a side of), the Activity entries about those claims lose their text, and the proposed people only
    this source named are deleted outright, with no "former participant" left.
- **Deleting one claim** (`DELETE /api/claims/:id`, owner only or the operator verb `claims_decide`): a claim that is not accepted or superseded goes for good, with the conflicts it is a side of; Activity records it without its text, and earlier entries about it lose their text too.
- **Forgetting a person** (People tab, `POST /api/people/:id/forget` with `confirm` set to their id; cannot be undone):
  their name is replaced by "former participant", their aliases and the claims of theirs you have not accepted are
  deleted, and their name is removed from the facts their accepted claims became and from earlier person Activity
  entries. The archived originals of sources they attended are not purged: they expire with the archive's lifetime
  (`REDACTION_ARCHIVE_RETENTION_DAYS`), or delete the source to purge its original now.
- **From a terminal.** `fg ingest <file|-> --project k` adds a source (`--kind`, `--date`, `--participants "Ana,Bo"`,
  `--title`, `--origin`, `--private` or `--shared`). A `.txt`, `.md`, `.vtt` or `.srt` file is sent as it is; a `.pdf`
  is turned into text with `pdftotext` (poppler) and a `.docx`, `.odt`, `.rtf`, `.html` or `.epub` with `pandoc`, on
  your machine, when they are installed (otherwise it says what to install; Feedback Graph itself reads no pdf or docx).
  A binary file is refused. `--wait` follows its reading and lists the claims, open questions and conflicts drawn from
  it. It needs Node on the host to read the file there; when `./scripts/fg` runs inside the api container instead,
  pipe text: `./scripts/fg ingest - --project k < notes.txt`.
- **Look-ups.** "What do we know about X": `GET /api/knowledge?q=` (optional `project`, `kinds` (any of `decisions`,
  `plans`, `facts`, `opinions`, `lessons`, `questions`), `person`, `since`, `limit`, and `format=md` for text), `fg know
  "<question>"`, the Ask starter *What do we know about …?* and the MCP tool `what_do_we_know`. One embedding of the
  question is matched against claims, facts and approved lessons (at the same closeness floor as `search_graph`), and
  open questions by their words; the answer is ranked, grouped by what each says (decisions, plans and commitments,
  facts, opinions, lessons, questions), with who said each and when, where it came from, `[disputed: <conflict>]`
  while a conflict on it is open, and both sides of those conflicts. `GET /api/knowledge` is the owner's: it includes
  claims you have not accepted (marked unreviewed), opinions, quotes and open questions, and refuses the agent
  credential (`API_TOKEN`); the operator token reads it under the `intake` verb. `what_do_we_know` (read-only) gives an
  agent accepted knowledge only: no opinion, no unreviewed claim, no quote, no question, and an unaccepted side of a
  conflict is named, not quoted. `fg conflicts [--open]` lists conflicts with both sides, `fg conflicts show <id>` one.
- **Agent notes.** `submit_notes` (MCP, not read-only) takes up to 200 KB and stores it as a private notes source marked
  `agent:<client>`. Its claims are only ever proposed and never accepted for you. It is untrusted input: its text is fenced
  as data like any source, a statement drawn from it that instructs an agent or holds a credential is dropped, and
  every quote must be in the notes.
- **Operator verbs.** `intake` (add, read and re-read sources) is on by default. `claims_decide` (accept, edit or
  reject claims, answer or assign questions, rename, merge or forget people) and `conflict_decide` (settle a
  conflict) are off unless `OPERATOR_ALLOW` names them. The admin MCP tools `intake_submit`, `claims_list`,
  `claim_decide`, `questions_list`, `question_answer`, `conflicts_list` and `conflict_resolve` follow those verbs.
- **Settling conflicts.** Each choice is a `resolve_conflict` decision by you, applied at once: it is on the Decisions
  page, exported with them, and rolled back like any other (the conflict reopens and the loser is restored). The
  learning loop never makes one, and your resolutions are never calibrated or counted as the loop's.
- **The learning loop and claims** (0.9.1; [the types](learning-loop-types.md#knowledge-intakes-types-091)). Like
  every loop type these follow the loop's mode, τ, caps, calibration and rollback. Housekeeping, applied on its own
  under `auto`: `link_claims` links claims from different sources that say the same thing, and `merge_claims` folds a
  proposed duplicate into what it repeats, so you review it once (nothing agents see changes). `accept_claim` (tier A,
  τ 0.92) accepts an exactly quoted fact or decision by a person you confirmed, once your own as-written accept rate
  on that type is at least 70% over 20 or more decisions; never an opinion, never from notes an agent submitted.
  Always proposals, for you on the Decisions page: `propose_resolution` (a probable supersession as B is true, or a
  conflict whose sides no longer share a scope as not a conflict), `assign_question` and `close_question` (citing the
  accepted claim that answers it). Settling a conflict is never automatic: `PUT /api/loop/settings` refuses `auto`
  for a tier P type, and the Settings page does not offer it.
- **Cost on local models.** An hour-long call is about 60,000 characters, about 8 windows of 8,000 characters. At
  about 45 s a window with gemma4 that is about 6 minutes, in the background, one window a round; the Sources tab
  shows *reading window 3/8*, and a restart resumes at the next window. The conflict judge only sees pairs the
  deterministic pre-filters flag (numbers, dates, versions, negation or named choices that differ) or that are very
  close, at most `CONFLICT_LLM_CALLS_PER_DAY` (60) a day, and each judged pair is remembered, so an unchanged pair is
  never judged twice.

## Agents with the operator token

With `FG_OPERATOR_TOKEN` set in `.env`, `http://localhost:8787/mcp/admin` gives a coding agent the owner decisions
`OPERATOR_ALLOW` names as MCP tools, and the `fg` CLI makes the same calls from a shell. Both send the token as the
Bearer; a bearer that matches neither `FG_OPERATOR_TOKEN` nor `API_TOKEN` is answered 401 on every route, reads included,
and logged as `auth refused` (the token itself is never logged). By default the operator token cannot decide lessons,
choose which projects are read, delete data, change settings or use Ask.

- **The token must be in the agent's own environment.** The agent reads it from the shell it was started in, not from
  Feedback Graph's `.env`. Export it there first, for example `export FG_OPERATOR_TOKEN="$(grep '^FG_OPERATOR_TOKEN=' .env | cut -d= -f2-)"`
  in the repo folder, then start the agent from that shell.
- **Codex.** Register the server in `~/.codex/config.toml` with the variable's name, not its value:

  ```toml
  [mcp_servers.feedback-graph-admin]
  url = "http://localhost:8787/mcp/admin"
  bearer_token_env_var = "FG_OPERATOR_TOKEN"
  ```

  Codex reads `FG_OPERATOR_TOKEN` from its environment when it starts; unset, the server is not found (404) and its
  tools are missing. `codex exec` needs the same export.
- **Claude Code.** `claude mcp add --transport http --scope user feedback-graph-admin http://localhost:8787/mcp/admin --header "Authorization: Bearer $FG_OPERATOR_TOKEN"`.
- **Approvals.** The read tools (`pipeline_status`, `list_projects`, `inbox_list`, `inbox_get`, `lessons_list`,
  `lesson_get`, `session_evidence`, `decisions_list`, `decision_get`, `loop_status`) say `readOnlyHint: true`, so a
  client may run them without asking. The others do not, and `inbox_decide`, `lesson_decide`, `run_cleanup`,
  `demo_remove`, `decision_decide` and `decision_rollback` also say `destructiveHint: true`.
- **Lists are paged.** `list_projects`, `inbox_list` and `lessons_list` return 20 compact rows by default (`limit` up to
  200) with `total`, `more` and a note naming the `offset` of the next page. A row leaves out PR descriptions, diffs and
  long rules; `inbox_get` and `lesson_get` give one item in full. Every tool's answer is also in `structuredContent`.
- **Attribution.** Writes made with the token are recorded as `operator:<name>` (the `X-FG-Operator` header, else the
  MCP client's name) on the item itself (Inbox decisions, lessons, fact relevance, links, uploads) and in Activity,
  whose entries also say how the write arrived: `details.via` is `operator`, `browser` or `api`.

## Inbox and Lessons review filters

The Inbox and Lessons pages, `fg inbox list`, `fg lessons list` and their GET APIs accept a PR number and author (`--pr 14194 --author login`, or `?pr=14194&author=login`). Both filters intersect. PR filters match GitHub metadata and explicit PR references in transcript feedback and preceding agent context. Author filters match source metadata only; mentioning a login in prose is not authorship. PR tokens are exact: `#14194` does not match `#141940`; authors match complete logins, not substrings. Omitting `status` in either CLI or API lists all statuses; use `--status pending` for the Inbox review queue and `--status proposed` for lesson proposals. The UI opens those queues by default. Filter values are kept in the URL hash, so a refreshed or shared link reopens the same view; a link whose target is deleted or outside the loaded filters never opens an unrelated item.

Settings → Integrations lets each project specify a GitHub **PR author** login (blank means all authors). The API is `PUT /api/settings/integrations/projects/:key` with `githubAuthor`; `fg integrations project <key> --github-author <login>` sets it. This restricts which PR discussions and PR documents are synced; it does not restrict who can comment on those PRs.

Inbox decisions offer **Undo** while the decision is unchanged and no post-mortem attempt or derived miss or lesson exists; once processing starts, Undo refuses and asks you to review the resulting data. The reopen is audited and keeps the decision history. A proposed lesson can be rejected during review. **Revoke** withdraws an approved lesson and records `revoked` separately; its cloud copy is demoted on the next successful sync. Lessons from a source PR closed without merging are flagged for review; the flag is evidence, not an automatic rejection. Activity collapses identical repeated scan-retry entries in the loaded page; uncheck the filter to see them all.

## The learning loop

The worker's learning loop decides on housekeeping (linking repeated misses, merging duplicate lessons, ranking,
retiring lessons that never help) and proposes changes to what agents are told, which it may later make on its own;
Decisions in the UI is its audit log.

- **Mode.** `auto` by default: housekeeping applies on its own; an agent-facing change (approving, rejecting,
  rewording or narrowing a lesson, turning one into a fact) applies on its own only once your own reviews of that type
  earned it in the call's confidence band (one of 5, by the call's score): at least 20 in that band, with the band's
  lower bound at its bar τ or above (0.9 for `approve_lesson`, which then approves proposed lessons without you), and
  at most `LOOP_AUTO_PER_DAY` (5) a day and `LOOP_AUTO_PER_PROJECT` (2) per project. Otherwise it waits as a proposal.
  Since 0.9.1 Inbox triage (`triage_inbox`) is earned the same way, at τ 0.9 and from 30 of your reviews in the band;
  your reviews of its proposals from before count. It never confirms on its own an agent's report or an item from your
  own sessions, nor decides one whose words read as a risky command or instructions to an agent: those stay
  proposals. The Decisions page's **needs you** view lists what waits, each with why. `fg loop mode propose` keeps every such
  change yours. `LOOP_MODE` seeds the mode on the first start;
  then Settings > Learning loop, `fg loop mode <off|observe|propose|auto> [--type t=m]` or the API decides. An install
  with no `API_TOKEN` and no `FG_OWNER_TOKEN` (or only blank ones) runs it at most in `observe`, since nobody could
  roll its changes back. The worker holds neither token: it reads the API's own answer in
  `state/api-settings/auth-state.json` (`AUTH_STATE_FILE`). The API writes *no token* there first thing at each start,
  its real answer once it listens, and renews that every 30 s while its database answers; so the loop observes until
  the API is up, and again within 2 minutes of the API stopping, crash-looping or losing its database. A worker run
  outside Compose may be told instead with `FG_AUTH_CONFIGURED=1` (`1`, `true` or `yes`; anything else is no).
- **Kill switch.** **Pause learning** (Dashboard, Settings, the Learning loop page), `fg loop pause`, or the admin tool
  `loop_pause` (when `OPERATOR_ALLOW` names `loop_settings`) stops it before its next write; `fg loop resume` starts it again. `LOOP_DISABLED=1` in `.env` stops it
  in a way none of those can undo (pause and resume then answer 409).
- **Undo.** Every applied decision can be rolled back, with the later decisions that depend on it, all or nothing:
  `fg decisions rollback <id>` (the full id `fg decisions list` prints, or a unique prefix of it) shows what that would undo and what blocks it; add `--apply` to do it. After a bad day,
  `fg decisions rollback --since 24h` lists every decision applied in the last 24 hours (by when it was applied, so a
  call it observed earlier and applied today is in), and `--apply` rolls them back, newest applied first. A rollback refused because you changed the target since marks the decision *overridden*; `--restore-anyway`
  writes what it was before over your change.
- **The operator token.** `loop_decide` (approve, reject, keep, roll back, notes) and `loop_settings` (mode, pause,
  resume) are off unless `OPERATOR_ALLOW` names them. A list there replaces the default verbs, so name them too
  (the 403 for a missing verb prints the whole line: what the token may do now, plus that verb). The operator's verdicts are kept on the decision but never count
  toward the loop earning auto-apply: only yours do.
- **Store outages.** Its routes answer 503 while the store does not answer; the pages keep retrying.
- **Cost.** A round reads the Activity log on from its cursor, 500 entries at a time, and judges only what changed since
  the last round plus 500 lessons of a slow sweep through all of them, so its cost follows what happened, not how big the
  store is. After the upgrade it reads the whole existing log back to back, 500 entries a round (on a store of 50,000
  entries, about 2 minutes on Postgres and 7 on Neo4j), then runs every 5 minutes. `GET /api/loop` counts in the store.

## Labelled test runs

Set `FG_RUN` to a unique run id and `FG_SANDBOX=1` in the agent's environment to label hook requests and keep sandbox records scoped to that run. Hooks also forward `FG_RUN_KEY` as `X-FG-Run-Key`; the `fg` CLI uses the same variables. For direct API or MCP calls, send `X-FG-Run`, `X-FG-Sandbox` and `X-FG-Run-Key` headers.

Operator requests that open or write a labelled run need a private random `FG_RUN_KEY` of at least 32 characters. Generate one with `openssl rand -hex 32`, keep it for that run and supply the same key for its cleanup. The operator display name is attribution, not proof of run ownership. Give independent callers different keys; never put a key in a shared prompt or URL.

`fg cleanup --run <id>` previews cleanup; add `--apply` to remove the run's untouched records. An operator can clean only runs opened with its key; a run already cleaned up, or never opened, answers "nothing to remove". Runs created by an unauthenticated agent, or before caller ownership was recorded, need cleanup by the owner: through the browser, or `scripts/fg cleanup --run OLD_RUN --owner` (preview, then add `--apply`), which needs `FG_OWNER_TOKEN` even on loopback. `API_TOKEN` and `FG_OPERATOR_TOKEN` never become owner credentials. Records touched outside the run are kept. Cleanup reads every Activity entry of the run, keeps real transcripts and protected record history, and removes their run and sandbox tags, so the transcript stays visible to its owner and safe to ingest again.

### Label real Claude Code and Codex sessions

The plugin's hooks and its MCP server read `FG_RUN`, `FG_SANDBOX` and `FG_RUN_KEY` from the launched agent's environment. Restart Claude Code after changing them. For an older standalone registration, run `claude mcp remove feedback-graph --scope user` and rerun `./scripts/install-agent.sh claude` once to install the dynamic headers. Codex uses `env_http_headers`; rerun the installer to add that map to an old table (merge its three keys yourself if your table already has a custom map).

```sh
export FG_RUN=review-065 FG_SANDBOX=1
export FG_RUN_KEY="$(openssl rand -hex 32)"
claude  # or: codex
```

Claude Code registers its real `session_id` at SessionStart, before transcript ingestion. With Codex, call `get_task_context` with the real session id at session start; labelled MCP calls register it before ingestion. A session already ingested without a run cannot be relabelled: start a fresh session if registration returns 409. The binding follows transcript candidates and confirmed feedback into post-mortems; a different run cannot claim the same session.

For a headless labelled Codex run, launch it with `FG_RUN`, `FG_SANDBOX=1`, a private random `FG_RUN_KEY` and `FG_OPERATOR_TOKEN` inherited, and pass the token through Codex's bearer option rather than in command-line text:

```sh
codex exec -c 'mcp_servers.feedback-graph.bearer_token_env_var="FG_OPERATOR_TOKEN"' '...'
```

In its first shell call, run the installation's `scripts/fg sessions register`, which reads the real `CODEX_THREAD_ID`, and keep passing that id as `session_id` to the MCP context, check and report tools: Codex exposes `CODEX_THREAD_ID` to its shell tools, but the HTTP MCP connection does not send it. MCP initialization and tool discovery do not claim run ownership. A failed registration reports a warning.

Desktop apps need these variables in their launch environment; changing a terminal variable cannot change an already-running app's MCP connection. A labelled request does not promise that an attempted edit of an owner's record creates a sandbox copy: check the run's Activity before relying on sandbox tests. See [OpenAI's MCP headers](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [Claude Code variable expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

### Isolated hooks, memory and judge probes

Use the checked-in `examples/demo-shop` only as the copy source, never as the agent working directory. `node scripts/demo-probe.mjs prepare --apply` creates the standalone `~/Code/demo-shop` fixture (`--folder` chooses another folder named `demo-shop`). Follow [Dedicated demo probe](demo-probe.md) for the reversible selection and privacy preparation, hook registration and cleanup: Claude hooks and Codex MCP read `FEEDBACK_GRAPH_TOKEN` (the install's API token) plus the private sandbox `FG_RUN_KEY`, a capability that can manage only the bundled local-only demo fixture. Codex needs explicit shell-environment pass-through and workspace network access for the local API. Owner routes need an authenticated browser session, or explicit `FG_OWNER_TOKEN` plus `X-FG-Owner: true`; `--local-owner` is no longer supported.

1. Keep `demo-shop` local-only (it is by default) and select it, and leave real project data and cloud sync untouched.
2. Set a fresh `FG_RUN`, `FG_SANDBOX=1` and a random private `FG_RUN_KEY`, and register the actual agent session as above.
3. Run `scripts/fg demo seed --run <label> --sandbox --json`. It creates clearly labelled approved demo fixtures without enabling `lesson_decide`, including the rule "Do not call console.log in src/probes/no-console.ts.", and returns a synthetic `probe` task, file list and plain-console diff that breaks it.
4. Ask `get_task_context` for that file and check the rule appears; then pass the probe's fields to `check_before_done` with the registered session id and check it reports the violation (a clean diff should not). Keep both responses and the run's Activity as evidence.
5. Remove the fixture with the same caller's `fg cleanup --run <label> --apply` (or the owner's `fg demo remove`, only when no other active probe shares the demo project).

For memory and post-mortem probes, use only synthetic notes and transcript fixtures in that demo project; never write probe notes to your own agent memory, approve a real lesson, or use another project's feedback. Installing or upgrading never runs probes or seeds a lesson.

## Measuring the learning loop

Three measures say whether the learning loop helps. All three use only data already stored. Each rate comes with its count and a 95% Wilson interval. The counts are small, so read the intervals rather than the rates.

### The control group

- `LOOP_HOLDOUT`, 0.2 by default and between 0 and 0.5, sets the share of eligible lessons the loop never changes.
  - A fixed hash of each lesson's id decides which lessons are held out.
  - Eligible lessons are those the loop could target at all. Lessons you wrote, the demo's lessons and a run's lessons are not eligible.
  - The loop does not make a call that would change a held-out lesson, not even in `observe`. Each round counts such calls under the skip reason `holdout`.
  - A lesson's track record on the Learning loop page says whether it is held out.
- Set the share once.
  - Raising it only adds lessons to the holdout, and lowering it releases some.
  - Either change mixes lessons the loop already changed into the other group, so the comparison starts over.
  - `0` turns the holdout off.
- The comparison (`holdout` in `GET /api/loop`) is intention-to-treat.
  - The treated group is every eligible lesson outside the holdout, whether or not a decision touched it. The loop retiring its least helpful lessons therefore cannot make the treated group look better.
  - Both groups count only lessons that agents were served at least once. Until both groups have one, the comparison is empty.
- Each group reports four things:
  - **repeat rate**: the share of its lessons whose miss happened again.
  - **helpful rate**: verdicts that the lesson applied (addressed, or a gap it caught), out of addressed, not addressed and not applicable.
  - **gaps fixed per time served**.
  - **not-applicable share** of the done-check's verdicts.
- `readHoldout` in core gives all four. The API sends the first two and the helpful rate's interval.

### Dashboard metrics

`readLoopMetrics` in core reads the last 8 weeks (`GET /api/loop/metrics`):
- **Repeat rate**: feedback that repeats an earlier miss, per week (the Patterns page's measure).
- **Checks that caught a gap**: done-checks that found at least one gap.
- **Gaps fixed per time served**, over eligible lessons.
- **Not-applicable share** of the done-check's verdicts.
- **Proposals per week**: decisions that waited for you. It stands in for the owner time the loop costs.
- **Rollback rate per type**, over the decisions applied in the window.

### The replay: would its decisions have matched yours?

`scripts/loop-replay.ts` cuts a store at a time T0, runs the loop in `observe` over the data up to T0, and scores each decision it would have made against what you did after T0.

**What counts as agreeing.** Only your own actions count, never an operator's or the worker's:
- **approve and reject**: you approved or rejected the lesson.
- **retire**: you revoked it.
- **reword**: you edited its words.
- **narrow scope**: you changed its scope or paths.
- **merge**: you superseded one lesson with the other.
- **record as a fact**: you converted the lesson to a fact.
- **triage**: your Inbox decision.
- **any type**: your Keep, Approve, Reject or Roll back of the loop's own decision on the same call. This decides over the rules above.
- Linking misses, ranking and thresholds have no hand-made counterpart. They stay unlabelled unless you judged the loop's own decision.

**The report.** For each type, the report gives:
- **precision**: agreed out of agreed plus contradicted.
- **strict precision**: agreed out of all its calls. A call you never acted on counts against it, because doing nothing is not disagreeing.
- **recall**: your actions of that kind that the loop also made.

**What the replay sees.** The store is only read, and nothing is written to it.
- The replay leaves out lessons, misses, Inbox items, facts and miss links made after T0.
- It rewinds lessons through your later edits and decisions (Activity's `changed` values) and through the loop's applied decisions (their snapshots).
- An Inbox item decided after T0 is pending again.
- These are used as they are now: a lesson's checks and embedding, fact relevance and the code map. A type that reads them can see a little of the future.
- Types that need a model find nothing unless you pass `--llm`, for example `--llm ollama:gemma4`.

**A frozen held-out set.**
- `--freeze-split split.json --heldout-share 0.3` picks 30% of the store's projects by a fixed hash and writes them to `split.json`. It never overwrites an existing file.
- Every later run passes `--split split.json`.
- You can add months (`"months": ["2026-10"]`) by hand. A cut in one of those months is held out.
- The report shows the tuning set and the held-out set apart. Tune the policy against the tuning set only; the held-out set is the estimate you report. This is the same discipline as the redaction held-out corpora.

**Running it.** Run it only against a throwaway database. `--restore` and `--demo` wipe it first, and the script refuses:
- a Postgres database whose name lacks `test`;
- a Neo4j on an install's bolt port: 7687, 7689 or `.env`'s `NEO4J_BOLT_PORT`;
- a store holding projects or lessons that the script did not write, unless you pass `--wipe` (on a terminal it then asks you to type the URL). A second install publishes its bolt port 10 or more above 7689, so this is the check that protects it.

Start the test databases with `docker compose -f docker-compose.test.yml up -d --wait` and remove them afterwards with `docker compose -f docker-compose.test.yml down -v`.

The script takes these options:
- `--t0` names a cut. Repeat it for several cuts.
- `--horizon-days 30` counts your actions up to 30 days after each cut; `none` counts them to the end.
- `--types a,b` replays only those types.
- `--json out.json` writes every scored call.
- `--wipe` lets `--restore` or `--demo` wipe a store that holds data the script did not write.
- Without `--restore` or `--demo` it reads the store as it is and writes nothing to it: no schema upgrade or start-up backfill, and any write refused. A Postgres store must already be at this version's migrations (start Feedback Graph on it once, or use `--restore`); a Neo4j store from before 0.8.0 is read as it is.

It checks every option before it connects, so a typo never leaves a wiped or half-seeded database.

**On a public demo dataset.** `--demo` seeds a small synthetic history: one project, `replay-demo`, with repeated misses, proposed lessons, served and judged lessons and an Inbox item. It then cuts the history and records "your" approvals, rejection, edit and Inbox decision after the cut. Nothing in it comes from a real install. It shows the harness working; it is not a benchmark.

```sh
node scripts/loop-replay.ts --store postgres --url postgres://fg:fg@localhost:5433/fg_replay_test --demo
```

**On a Postgres backup.** This works on a backup made by `scripts/backup.sh`. `pg_restore` runs on this machine, or inside the test container with `--pg-container`:

```sh
node scripts/loop-replay.ts --store postgres --url postgres://fg:fg@localhost:5433/fg_replay_test \
  --restore backups/<timestamp> --pg-container <project>-postgres-test-1 \
  --t0 2026-10-01T00:00:00Z --t0 2026-10-15T00:00:00Z --split split.json
```

**On a Neo4j backup.** Load the backup into a container of its own, replay it, then remove the container:

```sh
docker volume create fg-replay-neo4j
docker run --rm -i -v fg-replay-neo4j:/data neo4j:5.26-community \
  neo4j-admin database load neo4j --from-stdin --overwrite-destination=true < backups/<timestamp>/neo4j.dump
docker run -d --name fg-replay-neo4j -p 127.0.0.1:7799:7687 -e NEO4J_AUTH=neo4j/testpassword -v fg-replay-neo4j:/data neo4j:5.26-community
node scripts/loop-replay.ts --store neo4j --url bolt://127.0.0.1:7799 --t0 2026-10-01T00:00:00Z --split split.json
docker rm -f fg-replay-neo4j && docker volume rm fg-replay-neo4j
```

A backup holds your own feedback, so keep the report and `--json` output on your machine.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Badge says "worker offline" | `docker compose logs worker`: a config error is printed with every problem named. |
| Post-mortems never finish | Inbox → Confirmed: each item says whether it is waiting, failed (with the error) or gave up, with a Retry button. |
| "No approved lessons" for every task | `/api/status` and the logs: an embedding model mismatch stops the services with instructions. |
| Ingest seems stuck on history | It classifies newest first; selecting fewer projects narrows it. Turns the model answers but cannot label are given up after 3 tries; the empty Inbox offers to re-queue them. |
| Badge says "classifier unavailable" | The classifier's model could not be asked (not running, not pulled, unreachable, signed out, rate limited, timed out); the tooltip and `/api/status` give the reason. Classification pauses until it answers again, and no turn is charged a try for it. Fix the model (for Ollama: `ollama pull <model>`); the next cycle carries on. "post-mortem model unavailable" and "scan model unavailable" mean the same for those jobs: a post-mortem is not charged an attempt (and the rest of the batch waits), and a scan goes back in the queue (its error says why) instead of failing, is asked again every two minutes without being charged an attempt, and runs once the model answers. A scan that really fails is retried after 5, then 10 minutes and failed after its third attempt (Projects shows when it retries; asking for the scan again runs it at the next poll). An embedding model that is down counts the same way. "summaries paused" means the summary model (`SUMMARY_LLM`) could not be asked or built: no cursor moves and nothing is charged, and summaries carry on once it answers. |
| Badge says "Ollama unreachable" or "Ollama model missing" | Every embedding needs Ollama: start it, or `ollama pull` the `OLLAMA_EMBED_MODEL`. On Linux, see [Linux](#linux). |
| An agent hears "not in the code map" | The file is new, ignored, generated, not source, or over its size limit (`CODE_MAP_MAX_BYTES` for source, `SCAN_MAX_BYTES` otherwise); the map is rebuilt within five minutes of a repo change. The Code map card shows when it was last checked; **Rebuild map** remaps it now. |
| Code map card says the last rebuild stopped part way or failed | The worker stopped while writing it, or the store refused it; the card gives the next step (for Neo4j transaction memory, see [Neo4j memory](#neo4j-memory)). **Rebuild map** or `fg map rebuild <key>` retries it. |
| Cloud sync says error | The card's message names it: 401 means `CLOUD_TOKEN` is wrong, revoked or expired; 403 means it lacks the `sync` scope or you are a viewer; 413 means one project's bundle is too large even after cutting its code map (each project is sent on its own, so syncing fewer does not help): ask the cloud's operator to raise `SYNC_MAX_BYTES`, or leave that project out. Activity → **cloud sync** has each run. |
| Badge says "no projects selected" | Nothing is being read. Choose the folders to include in Settings. |
| Read-only banner, or owner actions answer 403 | The install has no tokens: run `./scripts/setup.sh --yes --enable-auth`, then sign in (see [Signing in](#signing-in)). |
| Agents get 401 | `API_TOKEN` was added or changed after they were registered: rerun `./scripts/install-agent.sh` (doctor's MCP check shows it). |
| A codex-cli job says "cannot reach the codex runner" or "has not written its token" | The runner is not running: `codex` missing from `COMPOSE_PROFILES`, or it is unhealthy (`docker compose logs codex-runner`). The job waits and is not charged a try. "refused the token": restart both, `docker compose restart codex-runner worker`. A runner that answers but is not ready: run `./scripts/doctor.sh`. |
| Codex answers but says every command failed (`bwrap: No permissions to create a new namespace`) | Codex's sandbox could not start: the runner needs the checked-in `scripts/seccomp/codex-runner.json` allowlist and the configured runner AppArmor policy (an override may have dropped them), and inside the worker it never can. See [Running codex-cli confined](#running-codex-cli-confined). |
| A folder's sessions are not listed | Its sessions ran outside every project root (Settings suggests their parent folders under **Outside the roots**), or under a root that is saved but not mounted yet. Add the folder in Settings and run `./scripts/setup.sh` (see [Install](#install)). |
| Settings says no project folders, or every project is gone after an upgrade | `docker-compose.yml` no longer mounts a default folder (it used to mount `PROJECTS_DIR` or `~/code`, and `./examples`). Run `./scripts/setup.sh`: it picks up `PROJECTS_DIR`/`PROJECTS_DIRS` from `.env` and mounts them through the override. |
| A script says another folder's containers run under this name | Two checkouts share one `FG_INSTANCE`. See [Install: A second install](install.md#a-second-install). |

For host test setup (`pnpm install` on the host, a single database contract suite), see [Install: Tests on the host](install.md#tests-on-the-host) and CONTRIBUTING.md.
