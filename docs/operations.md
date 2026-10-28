# Operating Feedback Graph

## Install

```sh
./scripts/setup.sh            # asks for your projects folder(s), writes .env, checks Ollama and its models
docker compose up -d --build
open http://localhost:8787    # or the API_PORT you set in .env; setup.sh prints the address
./scripts/install-agent.sh    # MCP server + guidance for Claude Code and Codex (README: Connect your agents)
```

`setup.sh` is safe to re-run; it never overwrites an existing `.env`. It:

- **finds the project roots**, the folders that hold your projects (one folder per project inside). There is no default and no guess. In order: `PROJECTS_DIRS` in the environment (`PROJECTS_DIRS=~/code,~/work ./scripts/setup.sh`); the roots saved in Settings (`state/settings/project-roots.json`, which the api writes), unless `PROJECTS_DIRS` in `.env` was edited after them; `PROJECTS_DIRS` in `.env` (`PROJECTS_DIR` from older versions); else, in a terminal, it asks, listing the folders your Claude Code sessions ran in as suggestions (Enter for none). Without a terminal and without any, it mounts none and says how to add one. Each folder must exist on the host, or it stops before changing anything. It writes the result to `.env` as `PROJECTS_DIRS` and to the roots file, so Settings, `.env` and the mounts agree. A folder in there that is not a git repo but holds repos (`~/src/github.com/org/repo`, `~/code/client/app`) offers each repo as a project of its own (see Project selection).
- **mounts exactly those folders**, read-only, for `worker` and `api`. `docker-compose.yml` mounts no project folder; `setup.sh` always writes `docker-compose.override.yml` (which `docker compose` reads automatically, so `docker-compose.yml` stays as shipped and `git pull` never conflicts) with each folder at `/roots/1`, `/roots/2`…, and `PROJECT_ROOTS` / `HOST_PROJECT_ROOTS` listing them (container and host paths, in the same order; both empty with no folders, which is a valid setup: everything starts, with no projects). It never touches an override you wrote yourself (one without its header line); add the mounts there by hand in that shape.
- **Changing the roots later:** in Settings (Where folders come from) add a folder, add a suggested one (the parent folders of sessions that ran outside every root, with their session counts), or remove one. Saving writes `state/settings/project-roots.json` (the api mounts only `./state/settings`, read-write) and logs a `roots_saved` activity; Settings then shows *Saved. Run ./scripts/setup.sh to mount these folders (restarts the containers).* until the mounted roots match. Roots are Docker bind mounts, so the change takes effect only when `setup.sh` regenerates the override and the containers are recreated (answer yes to its start question, or `docker compose up -d`). A root must be an absolute host path without `: | \ " $ ,`, not `/` or your home folder; at most 20.
- **creates the folders Docker would otherwise create, owned by root**: `./state`, the Claude Code transcripts folder (`CLAUDE_PROJECTS_DIR`, default `~/.claude/projects`) and the Codex sessions folder (`CODEX_SESSIONS_DIR`, default `~/.codex/sessions`). An empty `~/.codex/sessions` does not make `install-agent.sh` set up Codex: it looks for the `codex` CLI, or Codex's own `config.toml` or `auth.json`.
- **on Linux, runs the containers as you**: a new `.env` gets `HOST_UID` and `HOST_GID` (your `id -u` and `id -g`) when you are not uid 1000; for an existing `.env` it prints the two lines to add (see [Linux](#linux)).
- **needs only Docker on the host** (and `openssl`): the scripts use Node for reading `docker compose config` when it is installed, else the same Node image the services are built from. `demo-pushback.sh` also needs the `claude` CLI.
- **checks Ollama** on the host (`/api/tags`) and both models (`OLLAMA_MODEL`, default `gemma4`, and `OLLAMA_EMBED_MODEL`, default `nomic-embed-text`), and says which `ollama pull` is missing. Ollama is needed for embeddings always, and for the other jobs unless each uses another provider.

### Linux

- **Ollama must listen beyond localhost:** the containers reach it through the Docker bridge (`host.docker.internal`). Run `sudo systemctl edit ollama`, add `[Service]` and `Environment="OLLAMA_HOST=0.0.0.0"`, then `sudo systemctl restart ollama`. Keep port 11434 closed to other machines with your firewall.
- **File ownership:** the api, the worker and the codex-runner run as `HOST_UID:HOST_GID` from `.env` (docker-compose.yml passes them as `user:`), 1000:1000 when they are empty. `setup.sh` fills them in with your `id -u` and `id -g` on a first run when you are not uid 1000, so the worker can write `./state` and read transcripts only you may read; on an existing `.env` it prints the two lines to add (then `docker compose up -d`). Any uid works: `HOME` in the images is `/home/fg`, writable by every uid (the agent CLIs keep their settings there), and the Codex login volume (`codex-home`) and the codex-runner scratch volume are writable by whichever uid runs the worker. The runner shares the worker's uid because each reads files only the other's owner may: the runner's token (mode 600) and the worker's repository copies (mode 700). `./scripts/check-uid.sh` (part of `check.sh`) proves it in Docker: the worker image as uid 1234 writes `worker.sqlite` in a state folder that only uid 1234 may write, and uid 1000 cannot. After changing `HOST_UID`, make `./state` yours (`sudo chown -R "$(id -u):$(id -g)" state`) if an earlier uid wrote it.

## Health

| Check | Meaning |
|---|---|
| `GET /api/health` | The API process is up (no dependencies). Open without `API_TOKEN`. |
| `GET /api/ready` | The API can reach its store (Neo4j or Postgres). 503 otherwise. The body names the store: `{"ok": true, "store": "neo4j"}`. Used by the container health check, so it is open without `API_TOKEN` (it says nothing else). |
| `GET /api/status` | Version, `store` (`neo4j` or `postgres`), whether it answers (`graph`), the worker's last heartbeat, last cycle, last error and models. `models` gives each job's model (`classify`, `postmortem`, `scan`, `summary`) with `ok` and, when it could not be asked, the `reason` (`SUMMARY_LLM=off` is reported as `off: true`, not as a problem); `givenUpTurns` counts turns the classifier gave up on. `ollama` says whether Ollama answers at `OLLAMA_URL` with the embedding model pulled (`url`, `ok`, `reason`); every embedding needs it, and while it does not answer each `ollama:` model is reported unavailable. The UI header shows the same as a badge. |
| `POST /api/turns/requeue` | Gives the turns the classifier gave up on another try (`{"requeued": n}`). Yours only, from the UI (Inbox, when it is empty); logged in Activity as **turns re-queued**. |
| `docker compose ps` | Worker health comes from a heartbeat file the worker writes every 30 s (a timer, so long post-mortems do not look like a hang). |

Logs are one JSON object per line (`docker compose logs -f worker api`). The API logs method, path, status and duration, never query strings or bodies.

## Running it for more than one machine

1. Put it behind a TLS reverse proxy (Caddy, nginx, a cloud load balancer) that forwards `X-Forwarded-Proto`.
2. In `.env`: `API_TOKEN=$(openssl rand -hex 24)`, `PUBLIC_HOSTS=feedback.example.com`, `API_BIND=0.0.0.0`. The API refuses to start with a non-loopback `API_BIND` and no `API_TOKEN`.
3. People sign in once in the browser with the token. Agents: `FEEDBACK_GRAPH_URL=https://feedback.example.com ./scripts/install-agent.sh` registers the MCP server with the token, for Claude Code and for Codex (in `~/.codex/config.toml` as a static `Authorization` header in `http_headers`; the file is then made readable by you only).

Without a token the API refuses every host name except localhost, by design. This is still one person's graph; see [Editions](editions.md) for the team edition.

## Running on Postgres

Neo4j is the default store. The same api and worker run on Postgres 17 with pgvector instead:

1. In `.env`: `STORE=postgres` and `POSTGRES_PASSWORD=$(openssl rand -hex 18)` (letters and digits only: it is placed in a URL). `setup.sh` writes a password for new installs; startup refuses an empty one with the bundled service.
2. Also `COMPOSE_PROFILES=postgres` in `.env`, so every `docker compose` command (up, down, logs, ps, and the backup scripts) includes the database without `--profile postgres`. Then `docker compose up -d --build`. The profile starts the `postgres` service (`pgvector/pgvector:0.8.7-pg17`, bound to `127.0.0.1:${POSTGRES_PORT:-5434}`, data in the `postgres-data` volume). The Neo4j container still starts, because it is the default service, but nothing connects to it.
3. `curl localhost:8787/api/ready` answers `{"ok":true,"store":"postgres"}`.

Your own server instead of the container: `DATABASE_URL=postgres://user:password@host:5432/db` (the `vector` extension, pgvector 0.8.0 or newer, must be installable by that user) and no profile (`COMPOSE_PROFILES` empty). An older pgvector is refused at startup with the version found: the searches need its iterative HNSW scans, and older versions fail every search once the extension is loaded. `DATABASE_URL` is checked at startup with every other setting; its password never appears in a log or error message, whether it is in the userinfo or a `?password=` parameter.

Migrations (`packages/store-postgres/migrations`) run at startup under an advisory lock, so the api and the worker can start together; `0002_codegraph.sql` adds the code map tables. Vector searches use the HNSW indexes when the project has enough rows for that to pay, with iterative scans so a project's rows are still found when closer rows belong to other projects; small projects get an exact scan, and vectors of another length (an older embedding model) always do, so any embedding model works. The embedding-model check and `reembed` behave as on Neo4j. Text containing NUL characters (it happens in transcripts) is stored without them, since Postgres text cannot hold them; Neo4j keeps them.

Switching backend starts with an empty store: data is not copied between them. Carry lessons and code facts over with Export on the old backend and **Import bundle** on the new one (see [Data controls](#data-controls)); misses and their evidence come back as the worker re-reads the selected projects' transcripts. Keep the old backend's backup until you are happy.

## Running codex-cli confined

Codex's read-only sandbox can read the whole filesystem it runs on, so inside the worker it could read every transcript, every project's `.env`, the worker's state and its secrets (SECURITY.md). The codex-runner service gives it a filesystem with nothing else on it. In `.env`:

```sh
COMPOSE_PROFILES=codex                      # or postgres,codex
CODEX_RUNNER_URL=http://codex-runner:8790
CODEX_AUTH_FILE=~/.codex/auth.json          # setup.sh sets this when you have a Codex login
SCAN_LLM=codex-cli                          # and/or POSTMORTEM_LLM, CLASSIFY_LLM (not CHECK_LLM)
```

then `docker compose up -d --build`. `ALLOW_UNCONFINED_CODEX` is not needed and not read for these jobs.

How it works:

- **The runner container** (`codex-runner`, Dockerfile target `codex-runner`) holds Node, the Codex CLI and the runner script (`packages/core/src/llm/codexRunner.ts`), nothing else of the repo. It mounts the `codex-scratch` volume at `/scratch`, its own `codex-runner-home` volume at `/codex` with your Codex login file in it, and nothing else: no transcripts, no projects, no `./state`, and no secrets in its environment. Its root filesystem is read-only (`/tmp` is a tmpfs), it drops every capability, and it is not published on any host port.
- **Each job:** the worker copies the repository without secret files, git metadata or heavy folders into `/scratch/fb-mirror-*`, and sends the runner the prompt, that folder's name, the output schema, the model and the timeout over the compose network. The runner refuses a folder outside `/scratch`, runs `codex exec -s read-only -C <mirror>`, kills codex and everything it started when the timeout passes, and returns the exit code, the end of its output and the answer. The worker removes the copy afterwards. The runner executes one job at a time; a second job waits. Each Codex process runs inside a fresh bubblewrap mount and PID namespace exposing only its current filtered mirror at `/repo`, system runtime files, a temporary job folder and its login file. Other queued or reusable mirrors, the runner token and previous jobs' Codex history are absent. Isolation failure stops the job; it never falls back to the shared container filesystem. At startup and before every accepted job, the runner removes abandoned `fb-mirror-*` directories whose renewable lease expired five minutes ago, preserving the current job and fresh pending copies. The worker also sweeps at startup and before making a mirror, removing a dead local worker's copies immediately. Lease files are outside the mirror and never exposed to jobs.
- **The token:** the runner writes a new random token to `/scratch/.runner-token` (readable by uid 1000 only) every time it starts, and refuses any request without it. Only the worker and the runner mount the volume.
- **Runner namespace permissions:** Codex's own sandbox (bubblewrap) is what keeps the commands codex runs from writing files or reaching the network, and it needs an unprivileged user namespace, which Docker's default seccomp profile refuses. Without it every command codex runs fails. The runner therefore runs without the default seccomp filter; it still has no capabilities, `no-new-privileges` and a read-only root. The outer bubblewrap namespace also requires unprivileged user namespaces on the Docker host; keep `seccomp=unconfined`, the configured runner AppArmor policy and `no-new-privileges:true`, with all capabilities dropped. Docker's default AppArmor profile denies bubblewrap's mount propagation changes (`bwrap: Failed to make / slave: Permission denied`) even when seccomp allows user namespaces. The AppArmor exception applies only to `codex-runner`; the other services keep their profiles, and the runner is never privileged. Its per-job mount/PID namespace remains the boundary hiding other repositories and runner state. See [Docker's AppArmor profile documentation](https://docs.docker.com/engine/security/apparmor/). Hosts that disable user namespaces (or deny nested namespaces through an LSM policy) fail the job with the bubblewrap diagnostic; do not bypass isolation to work around it. Rebuild the runner image to install bubblewrap after upgrading. Docker namespace and nested Codex sandbox checks are covered by the container integration suite and must be verified on the deployment host.

On Ubuntu hosts that restrict unprivileged user namespaces, `apparmor=unconfined` is insufficient: the kernel strips capabilities needed for UID mapping. Load the supplied named profile on the Docker host, then select it in `.env`:

```sh
sudo ./scripts/install-runner-apparmor.sh
# Set CODEX_RUNNER_APPARMOR=feedback-graph-codex-runner in .env, then recreate the runner.
docker compose up -d --force-recreate codex-runner
```

This grants user namespace permission only to the named runner policy; it does not disable Ubuntu's restriction globally or add container capabilities. Docker Desktop and hosts without this restriction can keep `CODEX_RUNNER_APPARMOR=unconfined`. The CI namespace probe tests both outer and nested tool namespaces under the named policy. See [Ubuntu's user namespace restrictions](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/#apparmor-unprivileged-user-namespace-restrictions).

### Docker Desktop / OrbStack: procfs compatibility

A Docker-masked parent `/proc` can prevent Linux from mounting a new private `/proc`, producing `Can't mount proc ... Operation not permitted`. `/health` now executes the real outer and nested tool sandbox, without a model call, and returns HTTP503 if either cannot start. `./scripts/doctor.sh` reports that failure. Jobs never fall back to an unconfined process.

A supported operator-controlled workaround is Docker's runner-only `systempaths=unconfined` option in a hand-written Compose override. It removes Docker's masked/read-only system-path list inside that container, so it is a security relaxation and is **not enabled automatically**. Retain all existing `cap_drop`, read-only root, no-new-privileges, seccomp and AppArmor settings. The job's private mount/PID namespace still creates its own `/proc` and hides shared scratch, runner tokens and parent processes. Do not apply the option to the worker or API. Recreate the runner and require a successful real sandbox health check before scanning. If the host still refuses the sandbox, use Claude Code or an API provider rather than disabling isolation.

Check it: `docker compose ps codex-runner` (healthy), `docker compose logs codex-runner` (one line per job: status and duration, never the prompt or the token). The worker's `provider` log line says `codex-cli` at startup. On Linux, the `codex-scratch` and `codex-runner-home` volumes are owned by uid 1000 like `codex-home` (see [Linux](#linux)).

## Backups

```sh
./scripts/backup.sh                          # backups/<UTC timestamp>/{neo4j.dump or postgres.dump, state.tgz, STORE, SHA256SUMS}
./scripts/restore.sh backups/20261022T120000Z
```

Both scripts read `STORE` from `.env` and back up that store with the worker's `state/`:

- **Neo4j** (the default): Neo4j Community can only dump a stopped database, so the stack stops for the minute a backup takes. Schedule it with cron or launchd at a quiet hour.
- **Postgres** (`STORE=postgres`): `pg_dump --format=custom` takes a consistent snapshot while everything keeps running. With `DATABASE_URL` empty it dumps the bundled `postgres` service (starting it if needed); with `DATABASE_URL` set it dumps your own server, from a throwaway `pgvector/pgvector:0.8.7-pg17` container on the stack's network (the URL is passed through the environment, never on a command line). Your server must be Postgres 17 or older for that `pg_dump`.

`restore.sh` checks the checksums, refuses a backup of the other store (a `postgres.dump` with `STORE=neo4j`, or the reverse), asks you to type `restore` (`FORCE=1` skips that), and replaces the current store and worker state. On Postgres it stops the api and worker, replaces the whole `public` schema in one transaction (so tables a later migration added go too, and a failed restore leaves the database as it was), and starts again what was running. Either script stops with a message, before touching anything, when `.env` is missing, `STORE` is neither `neo4j` nor `postgres`, or `STORE=postgres` has neither `DATABASE_URL` nor `POSTGRES_PASSWORD`.

## Upgrades

```sh
./scripts/backup.sh
git pull && docker compose up -d --build
```

The schema is created idempotently at startup. Read `CHANGELOG.md` for anything that needs a step.

After upgrading to the version with the code map, the worker reads the selected projects' transcripts once more (to record which files each session touched; re-reading is idempotent) and maps each selected project's code. Both run beside ingest; expect the first cycle to take longer.

## Changing the embedding model

The graph records which model embedded it. If you change `OLLAMA_EMBED_MODEL`, the services refuse to start and say so. Re-embed everything:

```sh
docker compose stop worker api
docker compose run --rm worker node src/reembed.ts
docker compose up -d
```

It is resumable: if it stops part way (a crash, Ollama going away), run it again with the same `OLLAMA_EMBED_MODEL` and it embeds only what is left. Running it with a different model starts over.

## Data controls

- **Project selection:** you choose which project folders are read; nothing is read until you do. The choice is stored in the graph (`ProjectSelection`), so it survives restarts and both services see it. The worker lists every project folder under the roots each cycle (`GET /api/settings/projects`): each top-level folder, except that a folder which is not a git repo itself but holds git repos one or two levels down (`~/src/github.com/org/repo`, `~/code/client/app`) offers those repos instead, each a project of its own keyed by its path with `__` between the parts (`github.com__org__repo`). A session belongs to the deepest repo its cwd is in; one that ran in such a folder outside all of its repos belongs to the folder itself, which is then listed too. A top-level folder you already selected (or excluded) as a whole stays one project: unselect it to have its repos listed one by one. For each: whether it exists, is a git repo, its remote, how many Claude Code and Codex sessions ran in it and when it was last active. A Claude Code session counts from its file's first lines; a Codex session counts in every folder it was in, from its first lines and each later cwd switch (only `turn_context` lines are parsed, and only the bytes added since the last pass are scanned). Folders that sessions ran in but that are gone are listed as missing; sessions outside every root are only counted (add a root to make them selectable). Selecting a folder reads its sessions from the next cycle; unselecting stops reading it and keeps its data. The selection gates ingest (Claude Code and Codex, per session, so a Codex session that moved into a selected folder is read from there), memory import, scans, GitHub sync and MCP context. A second clone of a project (an alias folder, or a folder whose remote an existing project already has) follows that project: it is read when that project is selected, ticking it selects that project, and it is never made an alias of a project you have not selected. A folder saved in your selection that has since become a clone, or been excluded, is dropped from the list when you next save (Activity says so) instead of blocking the save.
  - `INGEST_PROJECTS` only seeds the selection on the first start of a version with selection (an install with `INGEST_PROJECTS=demo-shop` keeps reading exactly demo-shop). With it empty, an **upgrade** selects the projects you invested in: those holding approved lessons, confirmed feedback, docs or scans (never one in `EXCLUDE_PROJECTS`), so agents keep getting the lessons you approved; Activity (**projects selected**) lists them and says why. Review the choice in Settings. A new install, or an upgrade with none of those, selects nothing, logs that in Activity, and the header says **no projects selected**. After that `INGEST_PROJECTS` is ignored (the worker logs so if it differs).
  - **Global lessons reach every folder you have not excluded.** An agent working in a folder under a root that is not selected still gets the approved lessons scoped **global** from `get_task_context` and `check_before_done` (and nothing of that folder's own: its sessions are not read, so it has no misses, facts or code map). The answer says the folder is not selected and that it can be selected in Settings. A folder in `EXCLUDE_PROJECTS`, or a clone of an excluded project, gets nothing at all. The other MCP tools answer only for selected projects; outside them they say the folder is not tracked and point to Settings.
  - `EXCLUDE_PROJECTS` is a hard deny on top: an excluded folder is never read, scanned or served, cannot be selected, and an alias of an excluded project is excluded too.
  - **Remove unselected data:** `POST /api/settings/cleanup` with `{"confirm": "remove-unselected"}` (from the UI) deletes everything learned from projects that hold data but are not selected, and logs it; data filed under a clone of a selected project is kept. It is refused until a selection has been made. Cleanup and project delete wait for the worker to finish the transcript it is writing, and the worker checks the selection again before writing each one, so a cycle part way never writes a deleted project back. The worker then forgets which of those folders' transcripts and memory files it read, so selecting one again reads its whole history again (deleting a project that is still selected does not: only new sessions are read).
- **Codex sessions:** `~/.codex/sessions` (or `CODEX_SESSIONS_DIR`) is mounted read-only at `/codex-sessions`. Rollout files are streamed line by line (they can pass 800 MB); a large file that keeps growing is re-read at most every 10 minutes. Sessions run by Codex's own reviewer or sub-agents are skipped. Each session is recorded with `source: codex` and goes through the same redaction, classification, Inbox and post-mortem as a Claude Code session. Agent CLIs (post-mortems, scans) are denied `/codex-sessions` like `/transcripts`.
- **Code map:** for each selected project, the worker parses the code (tree-sitter in the worker, no model, nothing sent anywhere) into files, symbols, import edges, the tests covering each file, and commits per file over 90 days. It runs beside ingest and never holds it up: a project's repo is looked at no more than every five minutes and rebuilt only when it changed (git HEAD, `git status` and the size and mtime of uncommitted files; a folder that is not a git repo is rebuilt every five minutes). Unchanged files are not parsed again. It is bounded by `SCAN_MAX_FILES` and `SCAN_MAX_BYTES`, skips `.gitignore`d, vendor and secret files, never follows symlinks, and stores no source: paths, symbol names and line ranges only. A **Scan** maps its project first. Each build logs a **code mapped** Activity entry with its size and duration.
- **Reading the code map:** the Projects page shows each project's map (files, symbols, edges, last build) and its hotspots, scored `4 × misses + log2(1 + churn) + log2(1 + dependents)` (misses: confirmed misses whose session edited the file; churn: commits in 90 days; dependents: files importing it). Patterns lists the top hotspots across the selected projects. The same data over HTTP, read-only: `GET /api/projects/<key>/codemap/hotspots?limit=50` (`{meta, hotspots}`; `meta` is null before the first build; test files are left out unless `tests=1`), `GET /api/projects/<key>/codemap/graph?limit=60` (the Graph page's Code mode: the top files by score, their neighbours, edges, misses and lessons; `tests=1` too), `GET /api/projects/<key>/codemap/module?path=<repo path>` (404 when the file is not mapped), `GET /api/projects/<key>/codemap/impact?path=<a>&path=<b>&depth=3` (depth 1 to 5) and `GET /api/codemap/hotspots?limit=10[&project=<key>][&tests=1]`. All of them answer for selected projects only: any other key, or one in `EXCLUDE_PROJECTS`, is a 404 that says to choose it in Settings. Agents get it through MCP: `get_module_context`, `impact`, the code map section of `get_task_context` when they pass `files`, and the `files_changed` check of `check_before_done`. Each of those calls is logged in Activity as **context served** (or **pre-done check**) with the tool and paths.
- **Agent reports and the detector:** an agent's `report_feedback` (from `/postmortem`, or a miss the developer did not put in words) and the detector can flag the same miss. A report within 60 minutes of a flagged turn in the same project, whose words mostly match that turn's or that comes from the same session (`session_id`, optional), is merged into one Inbox item: reported after the detector, it is added to the detector's item; reported before, the detector moves the report's item onto the real turn (so the post-mortem sees the whole session) and drops the report's stand-in session. A report you already confirmed or rejected stays as it is, and the detector is recorded as a second source; a detector item you rejected is never merged into. Each Inbox item carries `origins` (`detector`, `agent`, or both) and the agent's `agentReport` (its words, what it had done, when, and its session id).
- **Memory import:** Claude Code feedback memories (`type: feedback` notes in a selected project's memory folder) become project lessons with source `memory`. By default they are **proposed**: they wait in Lessons for your approval and are not served to agents until you approve them. `MEMORY_AUTO_APPROVE=true` approves them on import. A file that changes is imported again and updates its lesson until you edit, approve or reject that lesson; from then on the lesson is yours and a new version of the file never changes it. Each import is logged in Activity as **memory imported**.
- **Instruction files in post-mortems:** a post-mortem reads `CLAUDE.md` and `AGENTS.md` in the project folder and in each parent folder up to the project root it is mounted under (folders above the mount are not visible to the worker), plus the session's Claude Code memory notes. Each is labelled by kind and by whether the session's agent loads it: Claude Code sessions load CLAUDE.md and memory, Codex sessions load AGENTS.md, and that agent's files are listed first. Only a loaded file counts as context the agent had (`context_available_ignored`). Codex's personal `~/.codex/AGENTS.md` is not mounted into the worker, so post-mortems do not see it. AGENTS.md is cited with its own kind (`agents_md`).
- **Files touched by sessions:** ingest records which repo files each session read and edited (from Read, Edit, Write, MultiEdit, NotebookEdit and Codex patch calls), as paths relative to the project folder; paths outside it and secret files are dropped. A miss is linked to the files its session edited, and to where the fix landed (files edited after the feedback). That is what ranks a project's hotspots and scopes a post-mortem's lesson to files.
- **Session summaries:** the worker's summarize stage runs beside ingest (never holding it up) for the selected projects' sessions. Each session keeps a cursor: the index and time of the last turn its summary covers. Once a session has been quiet for `SUMMARY_QUIET_MINUTES` (10), or `SUMMARY_MAX_DELTA_TURNS` (40) turns are waiting, only the turns after the cursor (your words, the agent's replies, its tool names and file paths, never commands; redacted) are sent with the previous summary, and the model (`SUMMARY_LLM`, default the local Ollama model) returns the merged summary, checked against its schema; the cursor moves to the last turn sent (at most 80 per update, so a long backlog takes a few passes). A delta of more than 20 turns is summarized in parts, then merged. An answer that is not a valid summary is asked again once; a second bad answer keeps the previous summary and backs the session off (5 minutes, doubling, up to 6 hours). A model that cannot be asked moves no cursor and costs nothing: the stage waits for the next cycle. Quiet for `SESSION_IDLE_MINUTES` (30) and summarized to its last turn, a session is **idle**; a new turn makes it **active** again and extends the summary. Sessions from before summaries are backfilled newest first, `SUMMARY_BACKFILL_PER_CYCLE` (3) per cycle. Each update is logged in Activity as **session summarized** (the turns it took in, chunks, model calls) and kept in the session's update history. `SUMMARY_LLM=off` turns the stage off. REST: `GET /api/sessions?project=&state=&cursor=` (newest first; `next` is the cursor of the following page), `GET /api/sessions/<id>` (summary, history, the Inbox items from the session and their lessons) and `POST /api/sessions/<id>/resummarize` (yours only, from the UI: rebuild from the first turn; refused when retention already removed turns it would need). MCP: `get_recent_sessions`, and a one-line-each list of the three most recent sessions in `get_task_context`. Summaries come from transcripts, so they are redacted before they are stored and are never part of an export bundle or a team sync; deleting a project deletes them.
- **Retention:** `TURN_RETENTION_DAYS=90` removes the text of classified turns older than 90 days, except in sessions that hold flagged feedback (their post-mortems need every turn). While summaries are on, a turn also keeps its text until its session's summary covers it (and while a rebuild is waiting); summaries themselves are never removed.
- **Export:** Projects page → Export, or `GET /api/export?project=<key>` (`&approved=1` for approved lessons only). A versioned JSON bundle of lessons, misses with their evidence, current facts, document metadata, the code map's file paths with their hotspot numbers (`codeFiles`: churn, misses, dependents, score; no source, symbols or edges) and each project's git remote (`projects: [{key, remote}]`, so clones in differently named folders can be matched). No raw transcripts, no session summaries, no vectors. Readers must ignore fields they do not know: added fields keep `schemaVersion: 1`.
- **Import:** Projects page → **Import bundle**, or `POST /api/import` with the bundle as the JSON body (`?keepApproved=1` keeps approved lessons approved). Yours only, from the UI, like every other write that teaches agents. The bundle must be `format: "feedback-graph-export"` with `schemaVersion: 1` (a newer one is refused with a message; fields this version does not know are ignored), is validated field by field, may be at most 50 MB, and is redacted again before anything is stored. It works across machines and backends:
  - **Lessons** are matched by id and re-embedded with the current `OLLAMA_EMBED_MODEL`. A lesson whose id is already here is left alone, so importing twice changes nothing and never overrides your decision. They arrive **proposed** and reach agents only once you approve them, unless you tick **keep approved** (`?keepApproved=1`): then approved lessons stay approved. Rejected and superseded lessons are not imported.
  - **Facts** go, re-embedded, into a project that has no facts yet (a project scanned here keeps its own). They are attributed to `import:<the model that found them>`, so the first scan here reads every file again and replaces them.
  - **Not imported:** misses (their evidence is the transcript, which a bundle never holds; they come back when the project's sessions are read), document metadata (the bundle has no text; upload the doc again) and the code map (rebuilt from the code). The response counts them.
  - Projects in `EXCLUDE_PROJECTS` are never imported. Each import is logged in Activity as **bundle imported**, with what came in and what was skipped.
- **Projects by git remote:** each project records its `origin` remote, normalized (`github.com/org/repo`, or `local/<name>` for a bare repo on disk; credentials, scheme, port and `.git` dropped). Only a folder that is itself the root of a git repo has one: a folder inside another repo does not inherit it. Existing projects get theirs on the next worker cycle, without re-reading transcripts. A folder that is not yet a project and has the same remote as an existing one is recorded as that project's alias: its sessions, and MCP calls from it, go to the existing project, and Activity logs a **project alias** entry. Projects that already existed separately are never merged. A folder with no remote works as before.
- **Delete:** Projects page → Delete project data (type the name). Removes every session, flag, decision, post-mortem, lesson, fact, code map, document and log entry for the project. Unselect it in Settings (or add it to `EXCLUDE_PROJECTS`) so new sessions are not read again.

## Team sync

Optional and off by default: with `CLOUD_URL` and `CLOUD_TOKEN` unset, no code path sends anything. Set both to
push project knowledge to a Feedback Graph Cloud org.

- **Settings.** `CLOUD_URL` is the cloud's base URL: `https://` (plain `http://` only to `localhost`, `127.0.0.1`
  or `[::1]`; inside Docker that is the container itself, so use https), with no user name or password in it.
  `CLOUD_TOKEN` is a personal access token from the cloud (`fgc_pat_<16 hex>_<43 characters>`, scope `sync`, a
  member role or above); create it in the cloud web app under Access tokens. `SYNC_INTERVAL_MINUTES` (5 or more)
  turns on automatic sync in the worker; empty means only **Sync now** (Settings, which the api runs).
  `SYNC_PROJECTS=a,b` narrows the projects sent; it never adds one: only projects selected in Settings, and never
  one in `EXCLUDE_PROJECTS`. `SYNC_SUGGESTIONS` (`false` by default) decides whether lessons you have not approved
  leave at all (below). All five are checked at startup with every other setting; a bad token is reported without
  being echoed.
- **What is sent.** One `POST <CLOUD_URL>/api/v1/sync` per project, `Authorization: Bearer <token>`, with the export
  bundle of that project (`format: feedback-graph-export`, `schemaVersion: 1`) rebuilt field by field: the project's
  key and normalized git remote, its lessons (below), misses (what was missed, the cause and its
  explanation, but an empty `feedbackText` and context items without their excerpts), current code facts, document
  metadata (title, link, no text) and `codeFiles` (paths and hotspot numbers). Everything passes redaction again on
  the way out. No transcripts, no source, no excerpts, no vectors.
- **Which lessons.** Nothing is shared without your approval. By default a bundle carries the lessons you approved,
  plus, with its current status, any lesson the cloud already received from you (so revoking, superseding or moving
  one back to proposed demotes the team copy). A lesson you never approved (proposed, or rejected before it was ever
  sent) stays on this machine. `SYNC_SUGGESTIONS=true` sends every lesson with its status: proposed ones then arrive
  as suggestions for an admin. The record of what the cloud received is kept in the store (one record per cloud URL
  and token; the token itself is not stored), so it survives restarts and the worker's schedule and the api's Sync now
  share it. Another org, or a new token, starts with no record: nothing it never received is withdrawn from it, and no
  lesson's status is sent to it only because an earlier org had the lesson.
- **Your decisions follow.** Each bundle is the whole project and says `complete: true`: on the cloud, whatever you
  sent for that project before and it leaves out now is withdrawn (kept there, not served). It also lists in
  `withdrawn` the lessons, misses, docs and fact files sent before and gone now. Leaving unapproved lessons out never
  withdraws anything: what was never sent has nothing to withdraw. Approved lessons become team lessons (or wait for
  an admin when the org reviews them), proposed ones (sent because the cloud had them, or with `SYNC_SUGGESTIONS`)
  are suggestions for an admin, and a lesson you reject or that is superseded demotes the team copy. A decision an admin made on the cloud is never overwritten: the
  cloud flags it instead. A selected project that now holds nothing (its data deleted) is sent once as an empty
  complete bundle under its last remote. A project that was synced and is no longer in the sync list (unselected,
  added to `EXCLUDE_PROJECTS`, or left out of `SYNC_PROJECTS`) gets one last empty, complete bundle on the next sync:
  it names only ids already sent and the remote it was filed under, and takes all of it back out of the team graph, so
  the team copy does not linger. It then leaves the record (a failed one is tried again on the next sync); selecting
  the project again later sends it afresh. The cloud files a project with a shareable remote under the
  team; one with no remote, or a `local/` one, stays in your personal space in the org.
- **Retries.** 429 (another sync of the org is running), 5xx and network errors are retried: up to four attempts per
  project, never sooner than `Retry-After` (seconds or a date; a wait longer than a minute fails that project until the
  next run), otherwise 2, 4, 8 seconds. 413 (too large) and 422 (rejected) fail that project and the sync moves on
  to the next; 401 (bad, revoked or expired token) and 403 (no `sync` scope, or a viewer) stop the run. Redirects are
  refused, so the token only goes to `CLOUD_URL`. After a failed scheduled run the next one waits twice as long,
  up to a day, and a success resets it. A scheduled run skips a project whose bundle has not changed since it was
  last sent (re-sending would change nothing on the cloud either); Sync now always sends.
- **What is recorded.** Each run that sent, withdrew or failed something logs one **cloud sync** Activity entry: the
  cloud's host, the projects sent and taken back out, the counts sent, where the cloud filed each project and the
  first error. The worker's
  heartbeat (`/api/status` → `worker.cloudSync`) carries the last scheduled result and the next run; `/api/status`
  → `cloud` says whether sync is on, with the token shown as `[REDACTED]`. The token is never logged, stored in the
  graph or passed to agent CLIs.
- **REST.** `GET /api/cloud` (the card: host, schedule, projects, counts a sync would send, last result) and
  `POST /api/cloud/sync` (Sync now; from the UI only, like other decisions; 409 when sync is off or already running).
- **End-to-end check.** `./scripts/cloud-sync-e2e.sh <cloud repo>` starts the cloud's docker compose under its own
  project name and port, and its own Neo4j and Postgres test containers (never the shared `docker-compose.test.yml`
  ones), makes an org and token through dev login and turns the org's review gate off (a new org reviews synced
  lessons, which would then arrive as suggestions), syncs a seeded project on both backends and checks the lesson
  arrived as a team lesson and is taken back out when the project is unselected, then removes everything it started.

## Agents with the operator token

With `FG_OPERATOR_TOKEN` set in `.env`, `http://localhost:8787/mcp/admin` gives a coding agent the owner decisions
`OPERATOR_ALLOW` names as MCP tools, and the `fg` CLI makes the same calls from a shell. Both send the token as the
Bearer; a bearer that matches neither `FG_OPERATOR_TOKEN` nor `API_TOKEN` is answered 401 on every route, reads included,
and logged as `auth refused` (the token itself is never logged).

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
  `lesson_get`) say `readOnlyHint: true`, so a client may run them without asking. The decisions do not, and
  `inbox_decide` and `lesson_decide` also say `destructiveHint: true`.
- **Lists are paged.** `list_projects`, `inbox_list` and `lessons_list` return 20 compact rows by default (`limit` up to
  200) with `total`, `more` and a note naming the `offset` of the next page. A row leaves out PR descriptions, diffs and
  long rules; `inbox_get` and `lesson_get` give one item in full. Every tool's answer is also in `structuredContent`.
- **Attribution.** Writes made with the token are recorded as `operator:<name>` (the `X-FG-Operator` header, else the
  MCP client's name) on the item itself (Inbox decisions, lessons, fact relevance, links, uploads) and in Activity,
  whose entries also say how the write arrived: `details.via` is `operator`, `browser` or `api`.

## Labelled test runs

Set `FG_RUN` to a unique run id and `FG_SANDBOX=1` in the agent's environment to label hook requests and keep sandbox records scoped to that run. Hooks also forward `FG_RUN_KEY` as `X-FG-Run-Key`; the `fg` CLI uses the same variables. For direct API or MCP calls, send `X-FG-Run`, `X-FG-Sandbox` and `X-FG-Run-Key` headers.

Operator requests that open or write a labelled run require a private random `FG_RUN_KEY` of at least 32 characters. Generate one with `openssl rand -hex 32`, retain it for that run and supply the same key for its cleanup. The operator display name is attribution, not proof of run ownership. Give independent callers different keys; do not put a key in a shared prompt or URL.

`fg cleanup --run <id>` previews cleanup; add `--apply` to remove the run's untouched records. An operator can clean only runs opened with its key. Runs created by an unauthenticated agent, or before caller ownership was recorded, require cleanup by the owner through the browser or owner API token. Records touched outside the run are retained.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Badge says "worker offline" | `docker compose logs worker`: a config error is printed with every problem named. |
| Post-mortems never finish | Inbox → Confirmed: each item says whether it is waiting, failed (with the error) or gave up, with a Retry button. |
| "No approved lessons" for every task | `/api/status` and the logs: an embedding model mismatch stops the services with instructions. |
| Ingest seems stuck on history | It classifies newest first; selecting fewer projects narrows it. Turns the model answers but cannot label are given up after 3 tries; the empty Inbox offers to re-queue them. |
| Badge says "classifier unavailable" | The classifier's model could not be asked (not running, not pulled, unreachable, signed out, rate limited, timed out); the tooltip and `/api/status` give the reason. Classification pauses until it answers again, and no turn is charged a try for it. Fix the model (for Ollama: `ollama pull <model>`); the next cycle carries on. "post-mortem model unavailable" and "scan model unavailable" mean the same for those jobs: a post-mortem is not charged an attempt (and the rest of the batch waits), and a scan goes back in the queue (its error says why) instead of failing, is asked again every two minutes without being charged an attempt, and runs once the model answers. A scan that really fails is retried after 5, then 10 minutes and failed after its third attempt (Projects shows when it retries; asking for the scan again runs it at the next poll). An embedding model that is down counts the same way. "summaries paused" means the summary model (`SUMMARY_LLM`) could not be asked or built: no cursor moves and nothing is charged, and summaries carry on once it answers. |
| An agent hears "not in the code map" | The file is new, ignored, generated, not source, or past `SCAN_MAX_FILES`; the map is rebuilt within five minutes of a repo change. Activity → **code mapped** shows the last build. |
| Cloud sync says error | The card's message names it: 401 means `CLOUD_TOKEN` is wrong, revoked or expired; 403 means it lacks the `sync` scope or you are a viewer; 413 means narrow `SYNC_PROJECTS`. Activity → **cloud sync** has each run. |
| Badge says "no projects selected" | Nothing is being read. Choose the folders to include in Settings. |
| A codex-cli job says "cannot reach the codex runner" or "has not written its token" | The runner is not running: `codex` missing from `COMPOSE_PROFILES`, or it is unhealthy (`docker compose logs codex-runner`). The job waits and is not charged a try. "refused the token": restart both, `docker compose restart codex-runner worker`. |
| Codex answers but says every command failed (`bwrap: No permissions to create a new namespace`) | Codex's sandbox could not start: the runner needs `seccomp=unconfined` and `apparmor=unconfined` (it has them in `docker-compose.yml`; an override may have dropped it), and inside the worker it never can. See [Running codex-cli confined](#running-codex-cli-confined). |
| A folder's sessions are not listed | Its sessions ran outside every project root (Settings suggests their parent folders under Outside the roots), or under a root that is saved but not mounted yet. Add the folder in Settings and run `./scripts/setup.sh` (see Install). |
| Settings says no project folders, or every project is gone after an upgrade | `docker-compose.yml` no longer mounts a default folder (it used to mount `PROJECTS_DIR` or `~/code`, and `./examples`). Run `./scripts/setup.sh`: it picks up `PROJECTS_DIR`/`PROJECTS_DIRS` from `.env` and mounts them through the override. |


## Inbox and Lessons review filters

The Inbox and Lessons pages, `fg inbox list`, `fg lessons list` and their GET APIs accept a PR number and author (`--pr 14194 --author login`, or `?pr=14194&author=login`). Both filters intersect. They match GitHub metadata and explicit PR/login mentions in transcript feedback and preceding agent context. PR tokens are exact: `#14194` does not match `#141940`; authors match complete logins, not substrings. Omitting `status` in either CLI or API lists all statuses; use `--status pending` for the Inbox review queue and `--status proposed` for lesson proposals. The UI opens those queues by default.

Settings → Integrations lets each project specify a GitHub **PR author** login (blank means all authors). The API is `PUT /api/settings/integrations/projects/:key` with `githubAuthor`; `fg integrations project <key> --github-author <login>` sets it. This restricts which PR discussions and PR documents are synced; it does not restrict who can comment on those PRs.

Approval makes a lesson eligible for the next configured cloud sync, which can run immediately if a sync is due; **Sync now** sends it explicitly. A proposed lesson can be rejected during review. **Revoke** withdraws a previously approved lesson and records `revoked` separately; its cloud copy is demoted on the next successful sync. Lessons from a source PR closed without merging are flagged for review; the flag is evidence, not an automatic rejection.

### Label real Claude Code and Codex sessions

Both plugin hooks and its MCP server read `FG_RUN`, `FG_SANDBOX` and `FG_RUN_KEY` from the launched agent's environment. Restart Claude Code after changing them. For an older standalone registration, run `claude mcp remove feedback-graph --scope user` and rerun `./scripts/install-agent.sh claude` once to install the dynamic headers. Codex uses `env_http_headers`; rerun the installer to add that map to an old table (merge its three keys yourself if your table already has a custom map).

```sh
export FG_RUN=review-065 FG_SANDBOX=1
export FG_RUN_KEY="$(openssl rand -hex 32)"
claude  # or: codex
```

Claude Code registers its real `session_id` at SessionStart before transcript ingestion. With Codex, call `get_task_context` with the real session id immediately at session start; labelled MCP calls register it before ingestion. A session already ingested without a run cannot be relabelled: start a fresh session if registration returns409. The persisted binding follows transcript candidates and confirmed feedback into post-mortems; a different run cannot claim the same session. Run cleanup retains the original transcript session and its immutable registry binding for provenance and safe re-ingestion; it removes the run-derived records listed in its dry-run preview.

Keep the key private and retain it for cleanup. Desktop apps need these variables in their launch environment; changing a terminal variable cannot change an already-running app's MCP connection. Do not put a key in a prompt or URL. A labelled request does not promise that an attempted edit of an owner's record creates a sandbox copy. Check the run's Activity before relying on sandbox tests. See [OpenAI's MCP headers](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [Claude Code variable expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).
