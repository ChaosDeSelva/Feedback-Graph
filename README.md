# Feedback Graph

**Your coding agent keeps making the same mistakes. Feedback Graph remembers the corrections.**

![How Feedback Graph works: sessions and reviews become lessons you confirm and then approve (or the learning loop does, once it has earned it), agents read them before work and before "done", and the learning loop tidies the graph with every change audited](docs/architecture.svg)

Every time you tell Claude Code or Codex "that's not good enough" or "you missed X", the lesson dies with the session. Feedback Graph runs on your machine, reads the sessions of the project folders you choose, finds the moments you pushed back, works out what was missed and why, and, once the lesson is approved (by you, or by the learning loop once it has earned it), hands it to the next agent session before it starts and again before it says "done".

- **Local first.** Runs in Docker with a local model (Ollama) by default. Nothing leaves your machine unless you configure a provider.
- **You decide what is learned.** Every flagged moment waits for your confirmation, and every lesson for your approval, unless your own verdicts have earned the learning loop the right to approve that kind of lesson. The loop runs in `auto` by default; see [The learning loop](#the-learning-loop).
- **Evidence, not vibes.** Each lesson links back to the feedback, the miss, its cause, the code it touched and the fix.
- **Works with your agents** through MCP and a skill: context before a task, a check before "done".

Apache-2.0 · [Operations](docs/operations.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Editions](docs/editions.md) · [Guide](docs/guide.md)

## Quickstart

You need Docker, git and [Ollama](https://ollama.com) on the host. Node and pnpm are not needed to run it: the scripts use Node when it is there, else Docker's Node image, and `./scripts/fg` runs inside the api container (Node and pnpm are for [developing it](#develop)). [Claude Code](https://code.claude.com/docs) or Codex is needed for the agent hookup in the last step. Start Ollama first (the app, or `ollama serve`): `ollama pull` talks to the running server.

```sh
git clone https://github.com/ChaosDeSelva/Feedback-Graph.git feedback-graph
cd feedback-graph
ollama pull gemma4 && ollama pull nomic-embed-text   # with Ollama running
./scripts/setup.sh          # asks which folders hold your projects, writes .env with generated passwords, checks Ollama,
                            # then offers to start the stack (docker compose up -d --build) and to connect Claude Code and Codex
./scripts/fg signin         # prints a one-time link that signs your browser in to the Dashboard (http://localhost:8787 unless API_PORT moves it)
```

In the Dashboard's **Settings**, add project folders and choose the projects to read. If you declined setup's start, run `docker compose up -d --build`; if you declined connecting agents, run `./scripts/install-agent.sh` (see [Connect your agents](#connect-your-agents); `--dry-run` shows what it would change).

### First value in ten minutes, with no history

You do not need past sessions or pushback to see it work. `--demo` adds this repo's `examples/` folder as a project folder, selects `demo-shop`, starts the stack and seeds demo-shop's demo lessons (`fg demo seed`, all marked demo):

```sh
./scripts/setup.sh --yes --demo
./scripts/fg demo context                       # the lessons an agent is given before it edits demo-shop's routes
./scripts/fg demo check                         # check_before_done catches a console.log a lesson forbids, citing the line
./scripts/fg activity --project demo-shop --limit 5   # what was served and checked, and why
```

`./scripts/fg demo remove` takes the demo lessons back. Your own first lesson, in a project you selected, takes four steps and no history either:

1. In your agent (connected by setup or `install-agent.sh`), say what it got wrong and the rule, e.g. *"record a miss: you added a route without a cross-tenant test; every route needs one"*, or type `/postmortem ...` in Claude Code. The agent calls `report_feedback`.
2. **Inbox**: confirm the item. The post-mortem runs (a minute or so with the local model).
3. **Lessons**: read the proposed lesson, edit it if needed, and approve it.
4. Ask the agent for work on those files: `get_task_context` serves the lesson, and `check_before_done` checks the finished work against it.

Pushback you type in a session is picked up from its transcript on its own; the Inbox then holds it for step 2.

Something not working? `./scripts/doctor.sh` checks Docker, ports, Ollama (including that structured output works: on macOS install the Ollama app, not the Homebrew formula), the mounts, the Codex login and GitHub and Linear, and says how to fix each failure. For an unattended install: `./scripts/setup.sh --yes --pull-models --projects ~/code [--github-token-file F] [--linear-key-file F] [--claude-token-file F]`.

`setup.sh` asks first for *Project folders, comma-separated*. There is no default: Enter mounts none, and you add them later in Settings. On a first run it then asks which projects to read, and offers the models, a `claude setup-token` (its shape checked before it is saved), the API, owner and operator tokens, the stack start and agent registration. It says every `.env` value it changes. On an existing install, `--yes` adds only a missing owner token, and only when `API_TOKEN` is set. A tokenless install is a **read-only install** for owner actions: `./scripts/setup.sh --yes --enable-auth` adds all three tokens (outside a terminal `--enable-auth` needs `--yes`), then re-run `./scripts/install-agent.sh` so agents get the API token.

**Sign in** with `./scripts/fg signin`. It prints a one-time link that signs this machine's browser in as the owner: it works once, for 60 s, and only at localhost, so the owner token never leaves `.env`. Pasting `FG_OWNER_TOKEN` into the sign-in card works too. A sign-out survives API restarts, a restore from backup signs every browser out, and rotating `FG_OWNER_TOKEN` ends all browser sessions.

To change folders later, use **Settings** and rerun setup. To see the whole loop without your own projects, [try the demo project](#try-it-on-the-demo-project).

- `setup.sh` suggests the folders your Claude Code sessions ran in (`PROJECTS_DIRS=~/code,~/work ./scripts/setup.sh` answers it ahead). `docker-compose.yml` mounts no project folder: `setup.sh` writes a generated `docker-compose.override.yml` with exactly the folders you chose (none is fine: everything starts, with nothing to read), so `docker-compose.yml` stays as shipped. It also creates `./state`, `~/.claude/projects` (or `CLAUDE_PROJECTS_DIR`) and `~/.codex/sessions` (or `CODEX_SESSIONS_DIR`) if missing (Docker would create them owned by root); an empty `~/.codex/sessions` does not count as Codex being installed. On Linux it sets `HOST_UID`/`HOST_GID` so the containers run as you; see [docs/operations.md](docs/operations.md#linux) for that and Ollama's `OLLAMA_HOST`.
- Port 8787 taken? Set `API_PORT` in `.env`: the UI is then at `http://localhost:<API_PORT>` and the MCP server at `http://localhost:<API_PORT>/mcp`. `setup.sh` prints the right address, and `install-agent.sh` registers it (re-run it after a change, removing the old registration as it tells you).
- The scripts (`setup.sh`, `doctor.sh`, `fg`, `backup.sh`, `restore.sh`, `install-agent.sh`) act only on this checkout's install. Once `.env` exists, its `FG_INSTANCE` names the install: they stop when `FG_INSTANCE` in your shell names another one, and they ignore a shell's `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE`. A second install on one machine: [docs/install.md](docs/install.md#a-second-install).
- Neo4j browser: http://localhost:7476, bolt on 7689 (`NEO4J_HTTP_PORT` and `NEO4J_BOLT_PORT` in `.env` move them; both bound to 127.0.0.1).
- Transcripts (`~/.claude/projects` and Codex's `~/.codex/sessions`) and the project folders you chose are mounted read-only; nothing else from your home folder. The bundled `./examples` folder is a project root only if you add it (`setup.sh --demo` does).
- **Nothing is read until you choose which project folders to include** (Settings). The worker lists every folder under your project roots with how many Claude Code and Codex sessions ran in it, and reads only the ones you select. A folder that is not a git repo but holds repos (`~/src/github.com/org/repo`, `~/code/client/app`) lists each repo as its own project (`github.com__org__repo`); sessions belong to the deepest repo they ran in.
- Secrets are redacted before anything is stored or sent to a model, and secret files are never read (see [SECURITY.md](SECURITY.md)).
- Health, backups, upgrades, running it behind TLS with a token: [docs/operations.md](docs/operations.md).

## Mac app

On a Mac, a small menu bar app can watch and drive your install: a dot shows whether Feedback Graph is running (green), starting or stopping (orange), stopped (grey) or has a problem (red, with what is wrong), and its menu and window start, stop and restart it, open the dashboard signed in, pause or resume the learning loop and show the proposals waiting, run a health check (`./scripts/doctor.sh`, beside the Docker engine and Ollama as its last status check saw them), back up, show logs and upgrade. It needs macOS 13 or newer and the same Docker engine (OrbStack, Docker Desktop or Colima) and Ollama as the stack; it bundles neither. Build it from a checkout (the Xcode Command Line Tools, macOS 14 or newer to build):

```sh
./scripts/build-mac-app.sh   # dist/Feedback Graph.app
./scripts/build-dmg.sh       # dist/Feedback-Graph-<version>.dmg: open it and drag the app to Applications
```

It uses the folder you chose (Choose Install Folder…) or that Get Feedback Graph… cloned (it clones this repository and opens Terminal on `./scripts/setup.sh`); with neither, `~/Code/feedback-graph` when that folder is an install. A saved folder that is no longer an install leaves it with none until you choose again. Quitting it leaves Feedback Graph running. What it runs, what it reads and how to sign a build to share: [docs/install.md](docs/install.md#mac-app).

## Connect your agents

### Claude Code plugin (recommended for Claude Code)

The plugin in [`plugin/`](plugin/README.md) bundles the MCP server, the skills and hooks that use the graph without being asked:

```
/plugin marketplace add ChaosDeSelva/Feedback-Graph
/plugin install feedback-graph@feedback-graph
```

- **On each request** that asks for a change, the task's approved lessons, the past misses on the files it names and the AGENTS.md and CLAUDE.md files on their path are added to the prompt, in about 1,500 characters (a longer lesson is shown whole). The first time in a session it adds them all; after that, only a lesson, miss or instructions file not yet shown.
- **Before the first edit of a file**, that file's lessons and past misses, when it has any.
- **Before it stops**, once: if it changed files and has not run `check_before_done` since, it is asked to.
- **After `/clear` or a compaction**, what was shown is forgotten, so it is shown again.
- **Skills:** `feedback-graph`, `/postmortem`, and `test-from-feedback`, which turns lessons and past misses into test cases for QA.

Hooks only act in folders you selected in Settings and stay silent when the Feedback Graph is unreachable. Set `FEEDBACK_GRAPH_URL` and `FEEDBACK_GRAPH_TOKEN` (your `API_TOKEN`) in your shell for a non-default install; `FEEDBACK_GRAPH_HOOKS=off` turns the hooks off. Use the plugin **or** `install-agent.sh claude`, not both. With the plugin installed, `install-agent.sh` registers no second server for the default install (another `FG_INSTANCE` still gets its own, `feedback-graph-<name>`, beside the plugin's): it writes this install's URL and `API_TOKEN` into the plugin's environment in `~/.claude/settings.json` (restart Claude Code). Switching to the plugin from an earlier `install-agent.sh` setup: `claude mcp remove feedback-graph --scope user` and `rm ~/.claude/skills/{feedback-graph,postmortem,test-from-feedback}` first.

### install-agent.sh (Codex, or Claude Code without hooks)

`./scripts/install-agent.sh` sets up every coding agent it finds; `./scripts/install-agent.sh claude` or `... codex` sets up one. It registers `http://localhost:<API_PORT>/mcp` from `.env` (8787 by default); point it at another install with `FEEDBACK_GRAPH_URL=https://feedback.example.com`. Without that it refuses a checkout that is not set up (no `.env`, or `FEEDBACK_GRAPH_ENV` naming a missing file), which would register the default port and repoint the skills at an unconfigured folder, and one whose install name (`FG_INSTANCE`) another folder's running containers use. When `.env` sets `API_TOKEN`, the MCP server is registered with it as a Bearer header. A second install on this machine (its own `FG_INSTANCE`) is registered as `feedback-graph-<name>` and leaves the first install's skill links alone.

- **Claude Code** (`claude` on your PATH): the `feedback-graph` MCP server at user scope (`claude mcp add --transport http`), and the `feedback-graph`, `postmortem` and `test-from-feedback` skills linked into `~/.claude/skills`. Type `/postmortem what it missed` to record a miss. The skills are symlinks into this folder, so a `git pull` updates them; if you move or delete this folder, re-run the script (or remove the links).
- **Codex** (`codex` on your PATH, or a `config.toml` or `auth.json` in `~/.codex`; `CODEX_HOME` is respected): a `[mcp_servers.feedback-graph]` table in `~/.codex/config.toml` with the streamable HTTP `url` (and `http_headers` carrying the token, after which the file is made readable by you only), and the same guidance as the skill in `~/.codex/AGENTS.md` between `<!-- BEGIN feedback-graph -->` and `<!-- END feedback-graph -->` markers. Ask Codex to record a miss for the post-mortem path.

`codex exec` (Codex without a person to approve) refuses MCP tool calls unless the server allows them: `./scripts/install-agent.sh codex --codex-auto-approve` adds `default_tools_approval_mode = "approve"` to the table (in a terminal it asks); a mode you set to another value is kept, and it says so. `--dry-run` prints what it would change and changes nothing; `--help` lists the options. Re-running refreshes this install's registration with its current URL and token, rewrites the marked guidance only when needed, and backs up a Codex config once before changing it (a linked config.toml or AGENTS.md is written through; a link loop or a link into a missing folder is refused), keeping any other headers you added. It changes nothing and exits 1 when config.toml declares this install's server other than as a `[mcp_servers.<name>]` table, or would not parse after the change (checked with python3's `tomllib`, 3.11+; without it, a config.toml with multi-line strings or arrays is refused, and an edit of one without says it was not checked), or when a guidance BEGIN marker has no END marker of its own; a skill folder of your own in `~/.claude/skills` is left alone and reported as skipped.

### Agents and scripts

The MCP tools only read and report. Decisions (choosing projects, scanning, confirming Inbox items, approving lessons) are yours in the UI. To let an agent or a script make some of them, set `FG_OPERATOR_TOKEN` in `.env` (`openssl rand -hex 24`) and restart. A request carrying it as a bearer may make the decisions `OPERATOR_ALLOW` lists; by default that leaves out deciding lessons, choosing which projects are read, deleting data (links included), settings, imports, integration keys, asking in Ask (which spends your subscription), and deciding on or configuring the learning loop (`loop_decide`, `loop_settings`), so what agents learn stays yours. It may clean up the runs it opened itself (`fg cleanup --run <id>`). Writes made with it show in Activity as `operator:<name>`.

`./scripts/fg` is a small CLI for it. It runs on the host's Node (22.18+ or 23.6+, after `pnpm install`), else inside the api container (`docker compose exec api`), and only in a checkout that is set up and runs its own containers:

```bash
./scripts/fg status --watch          # what the worker is doing, models, connections
./scripts/fg projects select --key shop,api
./scripts/fg scan --all
./scripts/fg inbox list              # pending items; inbox confirm|reject <id>... [--reason ...]
./scripts/fg lessons list            # lessons approve|reject <id> needs lesson_decide in OPERATOR_ALLOW
./scripts/fg loop status             # the learning loop; loop pause|resume|mode needs loop_settings
./scripts/fg decisions list          # its audit log; approve|reject|keep|rollback|note need loop_decide
```

`--json` prints raw answers; `--as <name>` names the agent in Activity. Reading works without the token. `fg status --watch` follows the live event stream. `./scripts/fg --help` lists every command (status, pipeline, projects, scan, inbox, lessons, demo, map rebuild|drop, links, facts, docs, activity, sessions, evidence, cleanup, loop, decisions, cloud, integrations, signin, doctor, setup); `fg help <command>` shows one command's options. `fg decisions rollback <id>` is a preview (what else it undoes, what blocks it) until you add `--apply`; `fg decisions rollback --since 24h --apply` rolls back every decision applied in that time, newest first.

**From inside an agent session:** with `FG_OPERATOR_TOKEN` set, a second MCP endpoint, `http://localhost:<API_PORT>/mcp/admin`, gives a coding agent the same decisions as tools: `pipeline_status`, `list_projects`, `select_projects`, `scan_projects`, `inbox_list`, `inbox_get`, `inbox_decide`, `lessons_list`, `lesson_get`, `lesson_decide`, `link_decide`, `set_fact_relevance`, `cloud_sync_now`, `run_cleanup`, `session_evidence`, `rebuild_code_map`, `demo_seed`, `demo_remove`, and for the learning loop `decisions_list`, `decision_get`, `loop_status`, `decision_decide`, `decision_rollback`, `decision_note` and `loop_pause`. It answers only to the operator token (send it as the Bearer when you register the server). Each write tool needs its `OPERATOR_ALLOW` verb; the demo tools need only the operator token for demo-shop. Its lists are paged at 20 rows and its read tools are marked read-only, so Codex does not ask before each one; export `FG_OPERATOR_TOKEN` in the shell you start Codex from (see [docs/operations.md](docs/operations.md#agents-with-the-operator-token)). The regular `/mcp` endpoint stays read-and-report only. **Headless Claude Code** (`claude -p`) denies, never prompts, a tool it was not allowed: pass `--allowedTools "mcp__plugin_feedback-graph_fg" "Bash(git diff *)"` (with `install-agent.sh claude` instead of the plugin, `mcp__feedback-graph`). **Testers:** label requests with `x-fg-run: <id>` (add `x-fg-sandbox: 1` to keep them away from real agents), then `fg evidence <session>` shows what the tool decided and `fg cleanup --run <id>` takes back what the run wrote. A wrong bearer is refused (401) on reads as well as writes.

**For scripts:** `GET /api/openapi.json` describes the whole local API (OpenAPI 3.1), including which routes are owner-only and which `OPERATOR_ALLOW` verb unlocks each. `GET /api/events` streams changes as server-sent events (`stage`, `pipeline`, `scan`, `chat`, `activity`), so a watcher does not have to poll.

## How it works

1. **Ingest:** reads the Claude Code and Codex session transcripts of the folders you selected and maps each to its project folder, with the repo files each session read and edited. A project is also identified by its git remote (`origin`, normalized to e.g. `github.com/org/repo`, credentials dropped): a second clone of a known repo in another folder is recorded under the existing project.
2. **Code map:** each selected project's code is parsed (tree-sitter, no model) into files, symbols, imports, the tests covering each file and 90 days of churn, and kept current as the repo changes. Misses are linked to the files their session edited, so the graph can say which modules agents keep getting corrected on, and why.
3. **Detect:** a keyword prefilter, then a classifier (gemma4 by default), flags pushback. It handles the newest feedback first.
4. **Inbox:** you confirm or reject each flagged moment. Nothing is learned without your confirmation. Agents can also report a miss (`report_feedback`, e.g. from `/postmortem`); a report of pushback the detector already flagged becomes part of that same Inbox item, with both sources kept.
5. **Post-mortem:** works out what was missed, why (a typed cause), and which context would have prevented it. The context hunt covers code facts, uploaded docs, PR reviews and Linear tickets. The proposed lesson is scoped to the files the fix touched when the evidence supports it, and gets **lesson triggers**: path globs, added-line patterns and symbols, worked out from the miss and the lesson's words. It also reads the instruction files the agent had: CLAUDE.md and AGENTS.md in the repo and each parent folder up to your project root, and Claude Code's memory notes, each labelled with whether that session's agent loads it (Claude Code: CLAUDE.md and memory; Codex: AGENTS.md).
6. **Lessons:** you approve, edit (triggers included) or reject them. Only approved lessons reach agents.
7. **Agents** use MCP. Only `report_feedback` writes; the other tools are marked read-only.
   - `get_task_context` serves approved lessons, past misses, code facts and doc excerpts. Given the files the agent will touch, it puts the lessons tied to those files first, adds a short code map of them (importers, tests, last miss) and lists the AGENTS.md and CLAUDE.md files on their path, nearest first. A lesson whose triggers match the files or the task's words is served too, saying which trigger fired.
   - A past miss is served or judged only when it shares a file with the work or is at least `MISS_MIN_SIMILARITY` (0.85) similar to it.
   - `get_module_context` describes one file (facts, exported symbols, importers, imports, tests, and the lessons and misses tied to it); `impact` lists what depends on a set of files, the tests to run, and the lessons and misses there. A file past the code map's cap (`SCAN_MAX_FILES`) is answered in full too, its symbols parsed on demand.
   - `check_before_done` has the judge (`CHECK_LLM`) check finished work against those lessons and against lessons whose triggers fire on the diff's added lines or changed files. A lesson with no verdict counts as a gap. When a lesson requires a change to a file it names (a test, a doc) and the change leaves that file out, the gap says so ("you forgot X"). Given `files_changed`, it also names the importers and tests of those files the change did not touch, and what the last misses there were about.
   - `search_graph` finds lessons, misses, facts and docs by meaning; `get_recent_sessions` returns session summaries (step 8); `report_feedback` records a miss (step 4).
8. **Session summaries:** each session of the selected projects gets a running summary (goal, what was done and decided, open threads, pushback, files touched, outcome). The worker keeps a cursor per session, the last turn the summary covers: once a session has been quiet for `SUMMARY_QUIET_MINUTES` (or `SUMMARY_MAX_DELTA_TURNS` turns are waiting), only the turns after the cursor are sent, with the previous summary, and the model returns the merged one (a big delta is summarized in parts, then merged). Quiet for `SESSION_IDLE_MINUTES` and summarized to its last turn, a session is **idle** ("complete for now"); a new turn makes it active again and the summary is extended. Sessions from before this are summarized a few per cycle, newest first. Agents get them through `get_recent_sessions`, and `get_task_context` lists the three most recent; post-mortems read the summary of the session they look at. Summaries are redacted, and never exported or synced.
9. **Activity:** every fact, code map build, flag, decision, post-mortem, summary update, served context and check is logged with who or what did it and why.
10. **Learning loop:** the worker reads the Activity log into each lesson's track record (served, judged, caught a gap, repeated) and your verdicts on its decisions into how far it may trust itself, then links repeated misses, merges duplicate lessons, re-ranks, retires, rewords, narrows and approves lessons, by the mode you choose. Every decision is on the **Decisions** page with what it changed and why, and can be rolled back.

### The learning loop

It runs in `auto` by default. In `auto`, housekeeping (linking repeated misses, merging duplicates, re-ranking, retiring lessons that never help) applies on its own. A change to what agents are told (approving, rejecting, rewording or narrowing a lesson, turning one into a fact) applies on its own only once your own verdicts on that type's proposals have earned it, counted per type and per confidence band (one of 5, by the call's score): at least 20 of them in the call's band, with that band's lower bound at the type's bar τ or above (0.9 for `approve_lesson`, which **approves a proposed lesson without you**), and then at most 5 such changes a day, 2 per project. Until then it proposes, and you approve or reject on the Decisions page. An operator token's verdicts never count. `observe` records what it would do and changes nothing; `propose` asks you about everything; `off` stops it. Set the mode in Settings > Learning loop or with `fg loop mode propose`; `LOOP_MODE` in `.env` seeds it on the first start only, and `LOOP_DISABLED=1` stops it whatever Settings says. **Upgrading to 0.8.0** with `API_TOKEN` or `FG_OWNER_TOKEN` set, the first start seeds `auto`, so housekeeping starts applying on its own: to start more cautiously, put `LOOP_MODE=observe` or `LOOP_MODE=propose` in `.env` before that first start. An install with neither token only observes.

## Knowledge intake (0.9.0, opt-in)

Hand Feedback Graph what people said, a call transcript (txt, md, vtt, srt) or notes, and it breaks it into **claims**
(facts, decisions, plans, commitments and opinions, each with who said it, when and the quote) and the **questions** it
left open, for you to review on the **Intake** page. It also checks claims, facts and approved lessons against each
other and flags **conflicts**: two things agents may be told that disagree, shown side by side for you to say which is
true. Agents only ever see the claims you accept (an accepted opinion stays attributed and is never given to them),
and each conflict you settle is a decision on the Decisions page that you can roll back.

It is **off by default**. To turn it on, set `INTAKE_ENABLED=1` in `.env` and run `docker compose up -d`; **Intake**
then appears in the sidebar's Review group. Add a source with **Add a source** on its Sources tab (paste it or pick a
`.txt`, `.md`, `.vtt` or `.srt` file), `POST /api/intake` or the admin MCP tool `intake_submit`; an agent can hand you its notes with `submit_notes`. It reads on the local model by default
(`INTAKE_LLM`), and only Ollama or `claude-cli` unless you widen `INTAKE_PROVIDER_ALLOW`.

Privacy: credentials and contact details are redacted before anything is stored or sent to a model, and speakers reach
the model only as S1, S2, ... (names spoken inside the text do reach it). Transcript text, quotes, questions and
sources are never served to agents, exported or synced, and claim facts leave for the cloud only with `SYNC_CLAIMS=true`.

How to use the page: [docs/guide.md](docs/guide.md#intake). Settings, privacy, deleting and cost:
[docs/operations.md](docs/operations.md#knowledge-intake).

## UI

| Page | What |
|---|---|
| Dashboard | The landing page: a **Getting started** list until its steps are done, what the worker is doing, model health, pipeline counts, repeat and catch rates, projects, hotspots, recent activity, and an Ask box |
| Ask | Chat about one project, one conversation per topic ("I want to add a modal", "where would feature X go?"). Answers cite the lessons, misses, facts, docs and code they come from, show existing examples and where they are used, and end with a **prompt for your agent** to copy into Claude Code or Codex, with the Feedback Graph tools to use. Runs on Claude, Codex or the local model (`CHAT_LLM`; switch per chat). The model gets only the question and that context, up to 16 KB of code from the project with secret files never read |
| Inbox | Flagged feedback to confirm or reject (`j`/`k`, `c`, `r`), from sessions (Claude, Codex) and from GitHub and Linear comments, filterable by source |
| Lessons | Evidence chain per lesson, edit (rule, scope, triggers) and approve, plus its history |
| Graph | Clickable map from feedback to miss, cause, lesson, context and fix commits; **Code** mode draws a project's code map (hotspot files, imports, tests, and the misses and lessons on them), and a file opens its module panel |
| Patterns | Misses by cause, repeated misses, weekly trend, pre-done catch rate, where agents struggle (top hotspots) |
| Sessions | Each session's running summary (filter by project and active/idle), its update history, files touched, the Inbox items and lessons from it, and **Rebuild summary** |
| Projects | Pin a project (pinned ones come first in every list), link it to the projects it belongs with (the worker suggests links from what is in them; you confirm), code map (stats, sortable hotspots with an include-tests toggle, a module panel per file linking to its lessons and Inbox items), scan code into facts (choose the model), browse facts by relevance with "how was this created?" and set a fact's relevance, upload docs and images that the worker reads into facts |
| Decisions | The learning loop's audit log: every decision with its before and after, evidence and rationale; approve, reject, keep or roll back (with what else a rollback undoes), notes, JSON and CSV export |
| Learning loop | The loop at work: its mode and Pause, this round, live events, each type's bar and earned confidence, recent decisions, a lesson's track record and the holdout comparison |
| Activity | The provenance log, filterable by project and kind |

How to read each page, with screenshots: [docs/guide.md](docs/guide.md).

The sidebar shows whether the worker is running, and a connections list (GitHub, Linear, Claude, Codex, Ollama, cloud sync) with each one's state and a link to where it is set. Projects also has **Export** (a versioned JSON bundle), **Import bundle** (its lessons arrive proposed unless you keep them approved; revoked ones stay revoked) and **Delete project data**. Settings has five tabs: **Projects** (the project folders to read), **Integrations** (GitHub and Linear), **Cloud sync** (always shown; it says how to turn team sync on until `CLOUD_URL` and `CLOUD_TOKEN` are set), **Learning loop** (its mode, per-type modes and bars, budget and Pause) and **Clean up**.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PROJECTS_DIRS` | The project folders that are mounted, comma-separated. `setup.sh` keeps it in step with the folders you add in Settings (editing it here and re-running `setup.sh` also works). No default. |
| `POLL_SECONDS`, `CLASSIFY_BATCH`, `SCAN_MAX_FILES`, `SCAN_MAX_BYTES`, `CODE_MAP_MAX_BYTES` | Worker pace and bounds: seconds between cycles (30); turns classified per cycle (50); files per project the code map keeps (empty: 40% of the files worth mapping, from 400 to 4000, source and the files your sessions edited first) and changed files a scan reads per run (empty: 400; a number sets both); the largest file a scan reads, in bytes (80000); and the largest source file the code map parses (1000000). Empty: the default. |
| `SCAN_CONCURRENCY` | Scans run at once, beside the worker cycle (2). Agentic scans (`codex-cli`, `claude-cli`) run one at a time. |
| `OLLAMA_NUM_PREDICT`, `OLLAMA_NUM_CTX`, `OLLAMA_REPEAT_PENALTY`, `OLLAMA_TIMEOUT_SECONDS` | Sent with every Ollama call: the most tokens an answer may take (empty: each job's own budget, classify 256, relevance 1024, Ask 6144, post-mortems 3072, the learning loop's rewrites 1024, its rewrite judge 256 and its replay judge 512, others 2048), the context window (16384; one value for every call, so the model is not reloaded), the repeat penalty (1.1), and how long one call may take (empty: each job's own limit). Structured calls also send `think: false`, and are streamed so an answer that turns into 200 whitespace characters in a row is cut there and asked again at once. |
| `MISS_MIN_SIMILARITY` | How close (0 to 1, default 0.85) a past miss must be to the work for `get_task_context` to serve it or `check_before_done` to judge it when it shares no file with it. |
| `CHECK_CONCURRENCY`, `CHECK_WAIT_SECONDS` | The judge's calls at once (2; the rest wait in line), and how long one check's judge call may run, waiting included (300). A response comes back within 50 s either way, "queued" while the call runs; the same check again joins it. A call still unanswered at the limit is cancelled and the check answers "not judged" with the lessons to check by hand. |
| `CHAT_LLM` | The model that answers Ask questions (same forms as the other jobs). Empty: `claude-cli` when a Claude token is set (`anthropic:` with only `ANTHROPIC_API_KEY`), else `codex-cli` when Codex may run, else the local model. Each chat can switch between Claude, Codex and the local model. |
| `INGEST_PROJECTS` | Seeds the project selection on the very first start only (e.g. `demo-shop`); after that, the selection in Settings decides. Empty: nothing is read until you choose (an upgrade selects the projects that already hold your approved lessons, confirmed feedback, docs or scans). Global lessons reach every folder under a root that is not excluded, selected or not. |
| `EXCLUDE_PROJECTS` | Never read, scan or serve these projects, whatever is selected. Settings shows them as excluded and cannot select them. |
| `CLAUDE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR` | Session transcripts on the host: Claude Code's (default `~/.claude/projects`, where its memory notes are too) and Codex's (default `~/.codex/sessions`; if it does not exist the worker carries on without Codex). |
| `FG_INSTANCE` | The Docker Compose name of this install: its containers, network and volumes. Empty: `feedback-graph`. `setup.sh` sets a distinct one (and ports 10 or more apart) for a second checkout; see [docs/install.md](docs/install.md#a-second-install). |
| `API_PORT`, `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`, `POSTGRES_PORT`, `OLLAMA_PORT` | Host ports: the UI, API and MCP server (8787, on `API_BIND`), and on 127.0.0.1 the Neo4j browser (7476), Neo4j bolt (7689), the bundled Postgres (5434) and the bundled Ollama (11435, `--profile ollama`). |
| `HOST_UID`, `HOST_GID` | Linux: the uid and gid the worker, api and codex-runner run as (default 1000). `setup.sh` sets them to yours. |
| `TURN_RETENTION_DAYS` | Remove the text of unflagged turns older than this. Empty keeps everything. While summaries are on, a turn keeps its text until its session summary covers it; summaries are never removed. |
| `SUMMARY_LLM`, `SUMMARY_QUIET_MINUTES`, `SUMMARY_MAX_DELTA_TURNS`, `SESSION_IDLE_MINUTES`, `SUMMARY_BACKFILL_PER_CYCLE` | Session summaries: the model (same specs as below; empty: the local model; `off`: no summaries), the quiet time before new turns are summarized (10), the waiting turns that are summarized at once (40), the quiet time after which a summarized session is idle (30), and older sessions summarized per cycle (3). |
| `LOOP_MODE`, `LOOP_DISABLED` | The learning loop. `LOOP_MODE` seeds its mode on the first start only (`off`, `observe`, `propose`, or `auto`, the default: housekeeping applies on its own, changes to what agents are told only once your reviews earned it); after that Settings > Learning loop decides. `LOOP_DISABLED=1` stops it whatever Settings says. An install with neither `API_TOKEN` nor `FG_OWNER_TOKEN` runs it at most in `observe`. See [The learning loop](#the-learning-loop). |
| `LOOP_LLM`, `LOOP_LLM_CALLS_PER_DAY`, `LOOP_AUTO_PER_DAY`, `LOOP_AUTO_PER_PROJECT`, `LOOP_SYNC_HOLD_DAYS`, `LOOP_HOLDOUT`, `LOOP_TYPES` | The loop's model (same forms as the other jobs; empty: the local model) and its model calls a day (40); agent-facing changes it applies on its own a day (5) and per project (2); days a lesson it changed is still shared with the cloud as it was before (7); the share of lessons it never changes, to compare against (0.2, at most 0.5); and the decision types that run (comma-separated; empty: all). |
| `MEMORY_AUTO_APPROVE` | `false` (default): Claude Code feedback memories (`type: feedback`) are imported as proposed lessons that you approve in Lessons. `true`: they are approved on import. Either way, once you edit, approve or reject one, re-importing its file never changes it. |
| `FG_OPERATOR_TOKEN`, `OPERATOR_ALLOW` | Let agents and scripts (the `fg` CLI) make owner decisions without a browser. Empty: none can. `OPERATOR_ALLOW` names what the token may do; empty means everything except deciding lessons (`lesson_decide`), choosing projects (`select_projects`), deleting a project, an uploaded document, a chat or a link (`links_delete`), settings (roots and cleanup), imports, integration keys, asking in Ask (`chat`), and the learning loop's decisions (`loop_decide`) and mode (`loop_settings`). A list replaces those defaults rather than adding to them, so list the defaults with the verb you add: a refused request prints that whole line. See [Agents and scripts](#agents-and-scripts). |
| `GITHUB_BOT_LOGINS`, `GITHUB_AGENT_LOGINS` | GitHub logins whose comments are a bot's (skipped) or an AI agent's (kept and labelled), comma-separated. Accounts GitHub marks as bots are skipped anyway. |
| `API_TOKEN`, `FG_OWNER_TOKEN`, `PUBLIC_HOSTS`, `API_BIND` | Reach the API from other machines: agents use `API_TOKEN`; people sign in to the browser with the separate `FG_OWNER_TOKEN`, which must never be given to an agent. Without tokens it is a read-only install: owner actions are refused and the API answers only this machine, but anything on it can read it, other containers included (OrbStack and Docker Desktop route them through the gateway), and an `API_BIND` other than 127.0.0.1 refuses to start. `./scripts/setup.sh --yes --enable-auth` adds all three tokens (API, owner and operator). |
| `CODEX_RUNNER_URL` | `http://codex-runner:8790`, with `codex` in `COMPOSE_PROFILES`: `codex-cli` runs confined in the codex-runner container, which holds only the Codex CLI, your Codex login and the job's copy of the repository ([docs/operations.md](docs/operations.md#running-codex-cli-confined)). |
| `ALLOW_UNCONFINED_CODEX` | Without `CODEX_RUNNER_URL`: set to `1` to let `codex-cli` run inside the worker, where it can read everything the worker can (SECURITY.md); `claude-cli` is confined to the project folder. |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Post-mortems then run on your Claude subscription (otherwise the local model, `OLLAMA_MODEL`, default gemma4). |
| `CLASSIFY_LLM`, `POSTMORTEM_LLM`, `SCAN_LLM`, `CHECK_LLM`, `DOCS_LLM` | Model per job: `ollama:<model>`, `claude-cli`, `codex-cli`, `openai:<model>`, `openrouter:<model>`, `groq:<model>`, `anthropic:<model>`, `jev` (classification only). `CHECK_LLM` (the `check_before_done` judge, which runs in the api) takes neither CLI. `DOCS_LLM` reads your uploads into facts (default `SCAN_LLM`); images need a model with vision (`ollama:gemma4`, `claude-cli`, `anthropic:`, `openai:`, `openrouter:`). The scan model also scores the relevance of facts stored before relevance existed, a batch at a time when nothing else is waiting. `SCAN_PROVIDER_ALLOW` (comma-separated, e.g. `ollama,openai`) limits which providers a scan request may switch to; empty allows any configured one. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` | Bring-your-own keys |
| `GITHUB_TOKEN`, `LINEAR_API_KEY` | GitHub and Linear tokens. Optional: you can paste them in Settings instead. A token saved in Settings wins; the one in `.env` is used when none is saved there. See [GitHub and Linear](#github-and-linear-optional). |
| `GITHUB_REPOS` | Optional override of the repository a project's PR comments come from (`demo-shop=me/demo-shop,other=me/other`). Without it, each selected project's github.com remote is used. |
| `LINK_SCAN_MINUTES` | Minutes between rounds of looking for links between the selected projects (30). No model: package manifests, mentions of another project's repository, and its name in several files. |
| `INTEGRATION_SYNC_MINUTES`, `GITHUB_SYNC_HOURS` | How often each project's review comments and Linear comments are read into the Inbox (10), and how often PR discussions are refreshed as context (6). |
| `STORE`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `COMPOSE_PROFILES` | Storage backend: `neo4j` (default) or `postgres`. With the bundled Postgres, `COMPOSE_PROFILES=postgres` includes it in every `docker compose` command. See [Storage](#storage). |
| `CLOUD_URL`, `CLOUD_TOKEN`, `SYNC_INTERVAL_MINUTES`, `SYNC_PROJECTS`, `SYNC_SUGGESTIONS` | Optional team sync to a Feedback Graph Cloud org. Off unless the first two are set. See [Team sync](#team-sync-optional). |
| `INTAKE_ENABLED`, `INTAKE_LLM`, `INTAKE_PROVIDER_ALLOW`, `INTAKE_LLM_CALLS_PER_DAY`, `INTAKE_ARCHIVE`, `CONFLICT_LLM`, `CONFLICT_LLM_CALLS_PER_DAY`, `CONFLICT_SWEEP_MINUTES`, `SYNC_CLAIMS`, `SYNC_PEOPLE` | Knowledge intake, off unless `INTAKE_ENABLED=1`. See [Knowledge intake](#knowledge-intake-090-opt-in) and [docs/operations.md](docs/operations.md#knowledge-intake). |

The Codex provider uses your ChatGPT login: `CODEX_AUTH_FILE` (only that file is mounted). It explores a copy of the repository without secret files, in the codex-runner container when `CODEX_RUNNER_URL` is set.

`OLLAMA_EMBED_MODEL` is recorded in the graph; changing it later needs `pnpm reembed` (the services tell you).

## GitHub and Linear (optional)

Pushback does not only happen in a session: reviewers push back in pull request reviews, and in comments on Linear issues.
Connect GitHub or Linear and those comments are read into the **Inbox** like pushback in a transcript: the same classifier
labels each one, and pushback or a correction becomes an Inbox item marked **GitHub** or **Linear**, with the author, a link
to the comment, the PR or issue title, and for a review comment the file, line and diff lines. You confirm or reject it as usual;
a confirmed one gets a post-mortem.

1. **Settings > Integrations.** Paste a token and press **Connect**: it is checked with one read-only call (the account it
   belongs to is shown) and saved only if it works. Or set `GITHUB_TOKEN` / `LINEAR_API_KEY` in `.env` (shown
   as "set in .env"); a token saved in Settings wins over it, so you can replace a `.env` key without editing the file.
   **Test connection** checks it again; **Disconnect** (after a confirm) deletes a token saved in the app and goes back to the
   `.env` one, if any.
   - GitHub: a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to
     only your projects' repositories, and **Pull requests** and **Issues** set to **Read-only**. Nothing is ever written to GitHub.
   - Linear: a personal API key from [Settings, Security and access](https://linear.app/settings/account/security).
2. **Repositories are found for you.** Each selected project whose origin is on github.com is linked to that repository
   (`GITHUB_REPOS` overrides it). Turn one off in the project table. For Linear, choose the team for each project.
3. **What is read.** Every `INTEGRATION_SYNC_MINUTES` (10), per project: review comments, review bodies and conversation
   comments on pull requests updated since the last sync, and comments on the mapped team's issues. Bots and integrations are
   skipped. The first sync reads the last 14 days only. Only selected projects are read.
4. **The work behind a comment.** A comment is linked to the agent session that most likely did the work: a session of that
   project on the PR's head branch (or the Linear issue's branch) that started before the comment; else, of the sessions active in the
   seven days before it, the one that edited the most of the PR's files (the commented file, for a review comment). Being
   nearest in time is never enough, and a tie is no match. Its post-mortem then reads that session (its turns, edited files and summary) beside the
   comment; with no session found it works from the comment and the diff lines alone.

A token pasted in Settings is kept in `state/api-settings/integrations.json` (mode 600, `INTEGRATIONS_FILE`): never in the
database, never returned by the API, logged, exported or synced. Comment text is redacted before it is stored or sent to a
model, and calls go only to `api.github.com` and `api.linear.app`. A rejected token (revoked or expired) pauses that service
until you replace it, and a rate limit pauses it until the limit lifts; both show in Settings and in the sidebar's
connections list, which shows GitHub, Linear, Claude, Codex, Ollama and cloud sync at a glance. PR discussions are also kept
as project context for post-mortems and `get_task_context`, as before.

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

Everything the tool learns is stored in **Neo4j** by default, which also gives you the Neo4j browser to explore the graph.

It can run on **Postgres with pgvector** instead, with the same code: every repository is an interface (`packages/core/src/store.ts`) with a Neo4j and a Postgres implementation (`packages/store-postgres`), and one contract test suite runs against both in CI. Redaction, Activity entries, export and delete behave the same on either.

```sh
# in .env: STORE=postgres, POSTGRES_PASSWORD=<letters and digits> (setup.sh generates one) and COMPOSE_PROFILES=postgres
docker compose up -d --build
```

The `postgres` profile adds a pgvector/Postgres 17 container (`127.0.0.1:5434`, volume `postgres-data`). To use your own Postgres 17 server with the `vector` extension available (pgvector 0.8.0 or newer; an older one is refused at startup), set `DATABASE_URL=postgres://user:password@host:5432/db` and leave the profile off. The schema is migrated at startup. `/api/status` and `/api/ready` report which store is in use. Switching backend starts empty: to carry your lessons and code facts over, Export on the old one and **Import bundle** on the new one's Projects page (see [docs/operations.md](docs/operations.md#data-controls)). Backups in Postgres mode use `pg_dump` (`./scripts/backup.sh` does it for you).

## Try it on the demo project

`examples/demo-shop` is a small multi-tenant API with rules in its CLAUDE.md.

`./scripts/setup.sh --demo` adds this repo's examples folder as a project folder and selects demo-shop (on an install whose selection was already made in Settings, select demo-shop there too); with the stack started it seeds the demo lessons, and [`fg demo context` and `fg demo check`](#first-value-in-ten-minutes-with-no-history) show them at work. To see the whole loop from a real session instead, with a [Claude Code](https://code.claude.com/docs) login:

```sh
node scripts/demo-probe.mjs prepare --apply --configure --api-url http://localhost:8787   # a dedicated, selected copy of demo-shop
./scripts/demo-pushback.sh   # a real Claude session there plus a pushback turn; its edits stay in the copy
```

The copy goes to `~/Code/demo-shop` (`--folder` and `FG_PROBE_DIR` move it), which must lie under a mounted project folder; [docs/demo-probe.md](docs/demo-probe.md) has the details.

Then open the Inbox, confirm the flagged pushback, wait for the post-mortem, and approve the lesson. Ask for context on a similar task (an invoices list) and run `check_before_done` with a summary that skips the sort order: the lesson and the gap both show up. `node scripts/demo-probe.mjs restore --apply` puts the project selection back afterwards.

## Develop

```sh
pnpm install
pnpm test                                                  # unit + ui
docker compose -f docker-compose.test.yml up -d --wait     # the test Neo4j and Postgres
TEST_STORES=neo4j,postgres pnpm test:int                   # contract suites on both backends
TEST_STORES=neo4j,postgres pnpm test:coverage:all          # every suite with coverage, held to the floor in vitest.config.ts
./scripts/check.sh                                         # lint, typecheck, the coverage gate, the uid check, the UI build;
                                                           # the history check only when a `public` branch exists
```

CI runs lint, typecheck, the coverage gate and the UI build too, always checks the pushed history, and builds both Docker images; it skips the uid check.

See the [installation guide](docs/install.md) for a fresh installation, a second local instance and the small memory profile.
