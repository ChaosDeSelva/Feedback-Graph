# Install Feedback Graph

Install Docker with the Compose plugin (Docker Desktop or OrbStack on macOS), git and Ollama. Clone the repository and run `./scripts/setup.sh` from its folder:

- `--demo` tries it on the bundled demo project first: it adds `examples/` as a project folder, selects demo-shop, seeds its demo lessons and prints `fg demo context`, `fg demo check` and `fg activity` commands that show a lesson served and a violation caught, with no agent session.
- `--small` selects the supported 1.5 GiB Neo4j profile ([Memory profiles](#memory-profiles)).
- `--yes` answers yes to every question, for a run without a terminal; `./scripts/setup.sh --help` lists every flag.

Running Feedback Graph needs neither Node nor pnpm: the scripts use the host's Node when there is one, else the Node image the services are built from, and `./scripts/fg` runs inside the api container. Node 26.5+ and pnpm 11 are for development (tests, typechecks, `./scripts/fg` on the host). Use pnpm through Corepack (`corepack enable && corepack prepare pnpm@11 --activate`); on a Node release without Corepack, use `npx -y pnpm@11 <command>` instead of assuming a global `pnpm`.

Choose project folders deliberately. They are mounted read-only, but the selected projects' transcripts hold the conversations and file contents of those sessions. Review the generated `.env` in the folder you cloned before starting a shared installation. The API binds to loopback by default.

## Signing in

On a fresh install, setup writes `API_TOKEN`, `FG_OWNER_TOKEN` and `FG_OPERATOR_TOKEN` to that private `.env` (in a terminal it asks first; `--yes` says yes). To sign in as the owner, run `./scripts/fg signin` and open the link it prints: it signs this machine's browser in once, within 60 s, at localhost only (the API keeps only a hash of it, in memory). Or open the localhost URL setup prints and paste `FG_OWNER_TOKEN` into the sign-in card. Agents get `API_TOKEN`, which cannot approve lessons, change settings or delete owner data.

A read-only install is one without tokens, such as an older install upgraded. Behind Docker's published port the API cannot tell your browser from another program, so owner actions are refused: the UI shows a read-only banner and disables Inbox decisions, lesson edits, scans, Ask, imports and Settings. An open tab notices tokens added or removed within 30 s, or as soon as you return to it. Any program on this machine can still read the API, other containers included (OrbStack and Docker Desktop route them through the gateway). Never expose or proxy a read-only install.

To enable owner actions:

1. Run `./scripts/setup.sh --yes --enable-auth` (or `./scripts/setup.sh` in a terminal, answering yes). It adds the missing API, owner and operator tokens and restarts the stack. Without a terminal, `--enable-auth` needs `--yes`, or it fails and changes nothing.
2. Sign in with `./scripts/fg signin`.
3. Rerun `./scripts/install-agent.sh` if setup did not (it offers to, unless `--skip-agents`): agents registered without a token get 401 until it does.

Plain `--yes` never adds tokens to an existing read-only `.env`; on an install that already has `API_TOKEN` it adds a missing `FG_OWNER_TOKEN`.

## A trial without your transcripts

For a local-only trial without your real transcripts or agent registration:

```sh
./scripts/setup.sh --yes --skip-agents --no-transcripts --projects /absolute/path/to/test-projects
./scripts/fg doctor
./scripts/fg status
```

`--skip-agents` holds with `--yes` too. `--no-transcripts` writes empty install-local Claude and Codex transcript folders (in `.host/`, which no container can write) to `.env`; it does not delete or change your real histories. To opt in later, set `CLAUDE_PROJECTS_DIR` and `CODEX_SESSIONS_DIR`, recreate the worker and select the projects in Settings.

## Codex

Setup does not find or mount your Codex login. Keep `CODEX_AUTH_FILE` empty for Ollama and Claude providers. To use `codex-cli`, set `CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json` and `CODEX_RUNNER_URL=http://codex-runner:8790`, and add `codex` to `COMPOSE_PROFILES`. The login is mounted read-only: refresh it with Codex on the host, then recreate the runner if needed. Never set `ALLOW_UNCONFINED_CODEX` to get past onboarding. See [runner compatibility and its security trade-off](operations.md#docker-masked-system-paths-procfs-compatibility).

## A second install

Use a separate clone; never copy a live `.env` or `state/`. A first setup in a folder whose install name (`FG_INSTANCE`, default `feedback-graph`) another folder's install already uses writes `FG_INSTANCE=feedback-graph-<folder>` and ports of its own. To choose the name yourself:

```sh
unset FEEDBACK_GRAPH_URL
FG_INSTANCE=feedback-graph-pilot ./scripts/setup.sh --yes --skip-agents --no-transcripts --projects /absolute/path/to/pilot-projects
```

A new named install moves every port it publishes 10 or more apart from the defaults, to the first set no running container publishes and no other install's `.env` sets: `API_PORT` (8787), `NEO4J_HTTP_PORT` (7476), `NEO4J_BOLT_PORT` (7689), `POSTGRES_PORT` (5434) and `OLLAMA_PORT` (11435, the bundled `ollama` profile). Read them in the generated `.env`. A port exported in your shell when you run setup is written to `.env` too, so `fg`, doctor and install-agent reach what Compose started. An existing `.env` keeps its choices: changing `FG_INSTANCE` alone there moves no ports.

Each install registers its folder in `~/.local/state/feedback-graph/` (`$XDG_STATE_HOME/feedback-graph` when set), so a new install skips the names and ports another install's `.env` reserves, even while that install is stopped. Setups in different folders run side by side; a second setup in the same folder waits for the first. No lock is held while models are pulled or the stack is built.

The scripts act only on this folder's install:

- Once `.env` exists, its `FG_INSTANCE` alone names the install. `FG_INSTANCE` in your shell names only a new one; setup, doctor, backup, restore, `fg` and `install-agent.sh` stop when it names another install.
- They ignore a `COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` in your shell and name this folder's Compose project in every `docker compose` call.
- Setup will not start containers another folder's install runs under the same name, and `backup.sh` and `restore.sh` refuse to stop, dump or load them. Doctor fails on them and checks nothing inside them (or the api answering for them). They read the folder from the install's service containers only, so a one-off container a killed backup or restore left cannot hide another install.

Run `./scripts/install-agent.sh --dry-run` from the new folder before registering it. `install-agent.sh` refuses a folder that is not set up (no `.env`) unless `FEEDBACK_GRAPH_URL` names an install. `FEEDBACK_GRAPH_URL` in your shell overrides this folder's address for agent registration and host `fg`; the scripts and doctor warn when it differs, so unset it to use this install. Each `FG_INSTANCE` gets its own MCP server name (`feedback-graph-<name>`). Codex's guidance block in `AGENTS.md` names the server of the install that wrote it, and only that install updates it. A block from before 0.7.6 names none: it belongs to `feedback-graph`, or, when no `feedback-graph` server is registered, to the next install that runs install-agent.

## Memory profiles

The default Neo4j container has a 3 GiB limit, a 512 MiB initial and 1 GiB maximum heap, and a 512 MiB page cache. Starting below the maximum avoids committing a full gigabyte while idle; the heap grows when work needs it. Transaction memory counts against the heap, not as an extra reserve, and the JVM, threads and mapped pages still need native headroom. Leave Docker VM memory for the worker, API, OS and any local model. `fg status` and doctor show container memory, headroom and swap when Docker's cgroup counters are available. `fg status --watch` labels its first host measurement a snapshot; rerun `fg status` for a fresh one. No Docker socket is exposed to the API.

For a small pilot, `./scripts/setup.sh --small` selects the checked-in small override before the first start. To select it by hand, add it after the base file and the generated project mounts:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.small.yml
```

It sets a 1.5 GiB container limit, a 256 MiB initial and 512 MiB maximum heap, a 128 MiB page cache and a 128 MiB transaction pool (32 MiB per transaction). The earlier 1 GiB profile left no native-memory headroom and is not supported. Less memory trades throughput for headroom: start with few concurrent requests. Keep any runner compatibility override you chose in the list. Run `docker compose config --quiet`, recreate Neo4j, then run doctor. If swap reaches 1 MiB or headroom falls below 15%, reduce load or raise the Docker VM or container budget; raising the heap alone can make host pressure worse. A few KiB of swap is the kernel paging out idle memory: both tools show it in KiB, without a warning.

## Tests on the host

Run `pnpm install` on the host before `pnpm test`; do not reuse the Linux containers' `node_modules` on macOS. To run one database contract suite, use `pnpm exec vitest run --project integration --no-file-parallelism <test-file>`. The contract suites need their disposable test databases, never your live one. See [CONTRIBUTING](../CONTRIBUTING.md).
