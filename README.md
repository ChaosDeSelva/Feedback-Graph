# Feedback Graph

**Your coding agent keeps making the same mistakes. Feedback Graph remembers the corrections.**

Every time you tell Claude Code or Codex "that's not good enough" or "you missed X", the lesson dies with the session. Feedback Graph runs on your machine, reads the sessions of the project folders you choose, finds the moments you pushed back, works out what was missed and why, and, once you approve it, hands that lesson to the next agent session before it starts and again before it says "done".

- **Local first.** Runs in Docker with a local model (Ollama) by default. Nothing leaves your machine unless you configure a provider.
- **You decide what is learned.** Every flagged moment and every lesson waits for your confirmation.
- **Evidence, not vibes.** Each lesson links back to the feedback, the miss, its cause, the code it touched and the fix.
- **Works with your agents** through MCP and a skill: context before a task, a check before "done".

Apache-2.0 · [Operations](docs/operations.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Editions](docs/editions.md) · Design: `docs/superpowers/specs/2026-10-22-feedback-graph-design.md`

## Quickstart

You need Docker, git and [Ollama](https://ollama.com) on the host; Node is not needed (the scripts use it when it is there, else Docker's Node image). [Claude Code](https://code.claude.com/docs) or Codex is needed for the agent hookup in the last step. Start Ollama first (the app, or `ollama serve`): `ollama pull` talks to the running server.

```sh
git clone https://github.com/ChaosDeSelva/Feedback-Graph.git feedback-graph
cd feedback-graph
ollama pull gemma4 && ollama pull nomic-embed-text   # with Ollama running
./scripts/setup.sh                             # asks one question (your projects folders), writes .env with generated passwords, checks Ollama
docker compose up -d --build
open http://localhost:8787                     # 8787 unless you set API_PORT (setup.sh prints the address); Settings: choose the project folders to read
./scripts/install-agent.sh                     # connect Claude Code and Codex (see below); --dry-run shows what it would change
```

`setup.sh` asks only one thing: *Project folders, comma-separated*, with its best guess in brackets (Enter takes it). It asks on a first run in a terminal; when `PROJECTS_DIRS` or `PROJECTS_DIR` is already set (in the environment or `.env`), or there is no terminal, it uses that or its guess without asking, and it ends by printing the next commands. It never overwrites an existing `.env`: to change the folders later, edit `PROJECTS_DIRS` in `.env` (comma-separated) and re-run `./scripts/setup.sh`, which regenerates the mounts. Then work as usual: push back on your agent when it misses something, confirm the flagged moment in the Inbox, and approve the lesson. To see the whole loop without your own projects, [try the demo project](#try-it-on-the-demo-project).

- `setup.sh` suggests the folders your Claude Code sessions ran in (`PROJECTS_DIRS=~/code,~/work ./scripts/setup.sh` answers it ahead on a first run). Several folders are mounted through a generated `docker-compose.override.yml`, so `docker-compose.yml` stays as shipped. It also creates `./state`, `~/.claude/projects` (or `CLAUDE_PROJECTS_DIR`) and `~/.codex/sessions` (or `CODEX_SESSIONS_DIR`) if missing (Docker would create them owned by root); an empty `~/.codex/sessions` does not count as Codex being installed. On Linux it sets `HOST_UID`/`HOST_GID` so the containers run as you; see [docs/operations.md](docs/operations.md#linux) for that and Ollama's `OLLAMA_HOST`.
- Port 8787 taken? Set `API_PORT` in `.env`: the UI is then at `http://localhost:<API_PORT>` and the MCP server at `http://localhost:<API_PORT>/mcp`. `setup.sh` prints the right address, and `install-agent.sh` registers it (re-run it after a change, removing the old registration as it tells you).
- Neo4j browser: http://localhost:7476, bolt on 7689 (`NEO4J_HTTP_PORT` and `NEO4J_BOLT_PORT` in `.env` move them; both bound to 127.0.0.1).
- Transcripts (`~/.claude/projects` and Codex's `~/.codex/sessions`), your projects folders and `./examples` are mounted read-only.
- **Nothing is read until you choose which project folders to include** (Settings). The worker lists every folder under your project roots with how many Claude Code and Codex sessions ran in it, and reads only the ones you select. A folder that is not a git repo but holds repos (`~/src/github.com/org/repo`, `~/code/client/app`) lists each repo as its own project (`github.com__org__repo`); sessions belong to the deepest repo they ran in.
- Secrets are redacted before anything is stored or sent to a model, and secret files are never read (see [SECURITY.md](SECURITY.md)).
- Health, backups, upgrades, running it behind TLS with a token: [docs/operations.md](docs/operations.md).

## Connect your agents

`./scripts/install-agent.sh` sets up every coding agent it finds; `./scripts/install-agent.sh claude` or `... codex` sets up one. It registers `http://localhost:<API_PORT>/mcp` from `.env` (8787 by default); point it at another install with `FEEDBACK_GRAPH_URL=https://feedback.example.com`; when `.env` sets `API_TOKEN`, the MCP server is registered with it as a Bearer header.

- **Claude Code** (`claude` on your PATH): the `feedback-graph` MCP server at user scope (`claude mcp add --transport http`), and the `feedback-graph` and `postmortem` skills linked into `~/.claude/skills`. Type `/postmortem what it missed` to record a miss. The skills are symlinks into this folder, so a `git pull` updates them; if you move or delete this folder, re-run the script (or remove the two links).
- **Codex** (`codex` on your PATH, or a `config.toml` or `auth.json` in `~/.codex`; `CODEX_HOME` is respected): a `[mcp_servers.feedback-graph]` table in `~/.codex/config.toml` with the streamable HTTP `url` (and `http_headers` carrying the token, after which the file is made readable by you only), and the same guidance as the skill in `~/.codex/AGENTS.md` between `<!-- BEGIN feedback-graph -->` and `<!-- END feedback-graph -->` markers. Ask Codex to record a miss for the post-mortem path.

`--dry-run` prints what it would change and changes nothing; `--help` lists the options. Re-running is safe: a server already registered is left alone, the guidance block is rewritten only when it changed (the rest of your AGENTS.md is untouched), and a Codex file is copied to `<file>.bak.<time>` before it changes. To change the URL or token, remove the server (`claude mcp remove feedback-graph --scope user`, or delete the table from config.toml) and re-run.

## How it works

1. **Ingest:** reads the Claude Code and Codex session transcripts of the folders you selected and maps each to its project folder, with the repo files each session read and edited. A project is also identified by its git remote (`origin`, normalized to e.g. `github.com/org/repo`, credentials dropped): a second clone of a known repo in another folder is recorded under the existing project.
2. **Code map:** each selected project's code is parsed (tree-sitter, no model) into files, symbols, imports, the tests covering each file and 90 days of churn, and kept current as the repo changes. Misses are linked to the files their session edited, so the graph can say which modules agents keep getting corrected on, and why.
3. **Detect:** a keyword prefilter, then a classifier (gemma4 by default), flags pushback. It handles the newest feedback first.
4. **Inbox:** you confirm or reject each flagged moment. Nothing is learned without your confirmation. Agents can also report a miss (`report_feedback`, e.g. from `/postmortem`); a report of pushback the detector already flagged becomes part of that same Inbox item, with both sources kept.
5. **Post-mortem:** works out what was missed, why (a typed cause), and which context would have prevented it. The context hunt covers code facts, uploaded docs, PR reviews and Linear tickets. The proposed lesson is scoped to the files the fix touched when the evidence supports it. It also reads the instruction files the agent had: CLAUDE.md and AGENTS.md in the repo and each parent folder up to your project root, and Claude Code's memory notes, each labelled with whether that session's agent loads it (Claude Code: CLAUDE.md and memory; Codex: AGENTS.md).
6. **Lessons:** you approve, edit or reject them. Only approved lessons reach agents.
7. **Agents** use MCP. `get_task_context` serves lessons, past misses, code facts and doc excerpts; given the files the agent will touch, it puts the lessons tied to those files first and adds a short code map of them (importers, tests, last miss). `get_module_context` describes one file (facts, exported symbols, importers, imports, tests, lessons and misses tied to it) and `impact` lists what depends on a set of files, the tests to run, and lessons and misses there. `check_before_done` judges finished work against those lessons (a lesson with no verdict counts as a gap); given `files_changed`, it also names the importers and tests of those files the change did not touch and what the last misses there were about.
8. **Session summaries:** each session of the selected projects gets a running summary (goal, what was done and decided, open threads, pushback, files touched, outcome). The worker keeps a cursor per session, the last turn the summary covers: once a session has been quiet for `SUMMARY_QUIET_MINUTES` (or `SUMMARY_MAX_DELTA_TURNS` turns are waiting), only the turns after the cursor are sent, with the previous summary, and the model returns the merged one (a big delta is summarized in parts, then merged). Quiet for `SESSION_IDLE_MINUTES` and summarized to its last turn, a session is **idle** ("complete for now"); a new turn makes it active again and the summary is extended. Sessions from before this are summarized a few per cycle, newest first. Agents get them through `get_recent_sessions`, and `get_task_context` lists the three most recent; post-mortems read the summary of the session they look at. Summaries are redacted, and never exported or synced.
9. **Activity:** every fact, code map build, flag, decision, post-mortem, summary update, served context and check is logged with who or what did it and why.

## UI

| Page | What |
|---|---|
| Inbox | Flagged feedback to confirm or reject (`j`/`k`, `c`, `r`) |
| Lessons | Evidence chain per lesson, edit and approve, plus its history |
| Graph | Clickable map from feedback to miss, cause, lesson, context and fix commits; **Code** mode draws a project's code map (hotspot files, imports, tests, and the misses and lessons on them), and a file opens its module panel |
| Patterns | Misses by cause, repeated misses, weekly trend, pre-done catch rate, where agents struggle (top hotspots) |
| Sessions | Each session's running summary (filter by project and active/idle), its update history, files touched, the Inbox items and lessons from it, and **Rebuild summary** |
| Projects | Code map (stats, sortable hotspots with an include-tests toggle, a module panel per file linking to its lessons and Inbox items), scan code into facts (choose the model), browse facts with "how was this created?", upload docs |
| Activity | The provenance log, filterable by project and kind |

The header shows whether the worker is running. Projects also has **Export** (a versioned JSON bundle), **Import bundle** (its lessons arrive proposed unless you keep them approved) and **Delete project data**. Settings picks the project folders to read and, when team sync is configured, shows the **Cloud sync** card.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PROJECTS_DIR`, `PROJECTS_DIRS`, `FEEDBACK_TOOL_DIR` | Host folders: your projects folder (or several, comma-separated in `PROJECTS_DIRS`; re-run `setup.sh` after changing it), and this repo (for the examples). `setup.sh` fills them in. |
| `POLL_SECONDS`, `CLASSIFY_BATCH`, `SCAN_MAX_FILES`, `SCAN_MAX_BYTES` | Worker pace and bounds: seconds between cycles (30), turns classified per cycle (50), files per project (400) and bytes per file (80000) the code map and scans read. Empty: the default. |
| `INGEST_PROJECTS` | Seeds the project selection on the very first start only (e.g. `demo-shop`); after that, the selection in Settings decides. Empty: nothing is read until you choose (an upgrade selects the projects that already hold your approved lessons, confirmed feedback, docs or scans). Global lessons reach every folder under a root that is not excluded, selected or not. |
| `EXCLUDE_PROJECTS` | Never read, scan or serve these projects, whatever is selected. Settings shows them as excluded and cannot select them. |
| `CLAUDE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR` | Session transcripts on the host: Claude Code's (default `~/.claude/projects`, where its memory notes are too) and Codex's (default `~/.codex/sessions`; if it does not exist the worker carries on without Codex). |
| `API_PORT`, `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`, `POSTGRES_PORT` | Host ports: the UI, API and MCP server (8787, on `API_BIND`), and on 127.0.0.1 the Neo4j browser (7476), Neo4j bolt (7689) and the bundled Postgres (5434). |
| `HOST_UID`, `HOST_GID` | Linux: the uid and gid the worker, api and codex-runner run as (default 1000). `setup.sh` sets them to yours. |
| `TURN_RETENTION_DAYS` | Remove the text of unflagged turns older than this. Empty keeps everything. While summaries are on, a turn keeps its text until its session summary covers it; summaries are never removed. |
| `SUMMARY_LLM`, `SUMMARY_QUIET_MINUTES`, `SUMMARY_MAX_DELTA_TURNS`, `SESSION_IDLE_MINUTES`, `SUMMARY_BACKFILL_PER_CYCLE` | Session summaries: the model (same specs as below; empty: the local model; `off`: no summaries), the quiet time before new turns are summarized (10), the waiting turns that are summarized at once (40), the quiet time after which a summarized session is idle (30), and older sessions summarized per cycle (3). |
| `MEMORY_AUTO_APPROVE` | `false` (default): Claude Code feedback memories (`type: feedback`) are imported as proposed lessons that you approve in Lessons. `true`: they are approved on import. Either way, once you edit, approve or reject one, re-importing its file never changes it. |
| `API_TOKEN`, `PUBLIC_HOSTS`, `API_BIND` | Reach the API from other machines: every call then needs the token. Without one, only localhost: an `API_BIND` other than 127.0.0.1 without `API_TOKEN` refuses to start. |
| `CODEX_RUNNER_URL` | `http://codex-runner:8790`, with `codex` in `COMPOSE_PROFILES`: `codex-cli` runs confined in the codex-runner container, which holds only the Codex CLI, your Codex login and the job's copy of the repository ([docs/operations.md](docs/operations.md#running-codex-cli-confined)). |
| `ALLOW_UNCONFINED_CODEX` | Without `CODEX_RUNNER_URL`: set to `1` to let `codex-cli` run inside the worker, where it can read everything the worker can (SECURITY.md); `claude-cli` is confined to the project folder. |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Post-mortems then run on your Claude subscription (otherwise gemma4). |
| `CLASSIFY_LLM`, `POSTMORTEM_LLM`, `SCAN_LLM`, `CHECK_LLM` | Model per job: `ollama:<model>`, `claude-cli`, `codex-cli`, `openai:<model>`, `openrouter:<model>`, `groq:<model>`, `anthropic:<model>`, `jev` (classification only). `CHECK_LLM` (the `check_before_done` judge, which runs in the api) takes neither CLI. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` | Bring-your-own keys |
| `GITHUB_TOKEN`, `GITHUB_REPOS` | PR discussions as context: `GITHUB_REPOS=demo-shop=me/demo-shop,other=me/other` |
| `LINEAR_API_KEY` | Linear tickets searched during post-mortems |
| `STORE`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `COMPOSE_PROFILES` | Storage backend: `neo4j` (default) or `postgres`. With the bundled Postgres, `COMPOSE_PROFILES=postgres` includes it in every `docker compose` command. See [Storage](#storage). |
| `CLOUD_URL`, `CLOUD_TOKEN`, `SYNC_INTERVAL_MINUTES`, `SYNC_PROJECTS`, `SYNC_SUGGESTIONS` | Optional team sync to a Feedback Graph Cloud org. Off unless the first two are set. See [Team sync](#team-sync-optional). |

The Codex provider uses your ChatGPT login: `CODEX_AUTH_FILE` (only that file is mounted). It explores a copy of the repository without secret files, in the codex-runner container when `CODEX_RUNNER_URL` is set.

`OLLAMA_EMBED_MODEL` is recorded in the graph; changing it later needs `pnpm reembed` (the services tell you).

## Team sync (optional)

The tool is complete on its own and sends nothing anywhere by default. Feedback Graph Cloud is a separate, hosted
team product built on this core: a shared team graph, single sign-on, a team MCP endpoint and pull request checks.
If your team uses it, the sync client in this repo pushes your project knowledge to your org:

1. In the cloud web app, create an access token with the `sync` scope.
2. Set `CLOUD_URL=https://<your cloud>` and `CLOUD_TOKEN=fgc_pat_...` in `.env`, then `docker compose up -d`.
3. Press **Sync now** on the Cloud sync card in Settings, or set `SYNC_INTERVAL_MINUTES=60` to sync on a schedule.
   `SYNC_PROJECTS=a,b` narrows which selected projects are sent.

What is sent, per selected project: its key and git remote, its approved lessons, misses (what was missed and why),
current code facts, document titles and links, and the code map's paths with their hotspot numbers. Only lessons you
approved leave: they become the team's (or wait for an admin, if your org reviews them). A proposed lesson stays on
this machine until you approve it; `SYNC_SUGGESTIONS=true` sends proposed ones too, as suggestions for an admin. A
lesson you reject or move back to proposed, or anything you delete, is taken back out of the team graph on the next
sync, and so is everything sent for a project you stop syncing (unselected, excluded, or left out of `SYNC_PROJECTS`):
it gets one last, empty bundle. What the cloud last accepted is kept in the store, so this holds across restarts.
Never sent: transcripts (including the feedback you typed), session summaries, source code, excerpts, document text, embeddings, or
anything new from an unselected or excluded project (its last bundle names only what was already sent). Every sync is logged in Activity. Details:
[docs/operations.md](docs/operations.md#team-sync).

## Storage

Everything the tool learns is stored in **Neo4j** by default, which also gives you the Neo4j browser to explore the graph. Nothing changes for existing installs.

It can run on **Postgres with pgvector** instead, with the same code: every repository is an interface (`packages/core/src/store.ts`) with a Neo4j and a Postgres implementation (`packages/store-postgres`), and one contract test suite runs against both in CI. Redaction, Activity entries, export and delete behave the same on either.

```sh
# in .env: STORE=postgres, POSTGRES_PASSWORD=<letters and digits> (setup.sh generates one) and COMPOSE_PROFILES=postgres
docker compose up -d --build
```

The `postgres` profile adds a pgvector/Postgres 17 container (`127.0.0.1:5434`, volume `postgres-data`). To use your own Postgres 17 server with the `vector` extension available (pgvector 0.8.0 or newer; an older one is refused at startup), set `DATABASE_URL=postgres://user:password@host:5432/db` and leave the profile off. The schema is migrated at startup. `/api/status` and `/api/ready` report which store is in use. Switching backend starts empty: to carry your lessons and code facts over, Export on the old one and **Import bundle** on the new one's Projects page (see [docs/operations.md](docs/operations.md#data-controls)). Backups in Postgres mode use `pg_dump` (`./scripts/backup.sh` does it for you).

## Try it on the demo project

`examples/demo-shop` is a small multi-tenant API with rules in its CLAUDE.md.

```sh
# select demo-shop in Settings (or, on a fresh install, set INGEST_PROJECTS=demo-shop in .env first), then: docker compose up -d
./scripts/demo-pushback.sh   # a real Claude session plus a pushback turn; demo-shop is restored afterwards
```

Then open the Inbox, confirm the flagged pushback, wait for the post-mortem, and approve the lesson. Ask for context on a similar task (an invoices list) and run `check_before_done` with a summary that skips the sort order: the lesson and the gap both show up.

## Develop

```sh
pnpm install
pnpm test                                                                 # unit + ui
docker compose -f docker-compose.test.yml up -d --wait && TEST_STORES=neo4j,postgres pnpm test:int   # contract suites on both backends
./scripts/check.sh                                                        # everything CI runs
```
