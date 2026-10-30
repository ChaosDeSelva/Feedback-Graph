# Install Feedback Graph

Install Docker (Desktop/OrbStack on macOS), Node 26.5+ and pnpm 11. Clone the repository, run `pnpm install`, then run `./scripts/setup.sh`. Choose project roots deliberately: mounted project folders are read-only, but selected transcripts contain the conversations and file access from those sessions. Review `.env` before starting a shared installation. The API binds to loopback by default.

For a local-only trial without your real transcripts or agent registration:

```sh
./scripts/setup.sh --yes --skip-agents --no-transcripts --projects /absolute/path/to/test-projects
./scripts/fg doctor
./scripts/fg status
```

`--skip-agents` also applies with `--yes`. `--no-transcripts` saves empty install-local Claude and Codex transcript directories in `.env`; it does not delete or modify your real histories. To opt in later, set `CLAUDE_PROJECTS_DIR` and `CODEX_SESSIONS_DIR` deliberately, recreate the worker, and select the intended projects in Settings.

Setup does not discover or mount your real Codex login automatically. Keep `CODEX_AUTH_FILE` empty for Ollama/Claude providers. When you choose `codex-cli`, explicitly set `CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json`, `CODEX_RUNNER_URL=http://codex-runner:8790`, and add `codex` to `COMPOSE_PROFILES`. The login is mounted read-only; refresh it using Codex on the host, then recreate the runner if needed. Never use `ALLOW_UNCONFINED_CODEX` as an onboarding workaround. See [runner compatibility and its security tradeoff](operations.md#docker-masked-system-paths-procfs-compatibility).

## A second install

Use a separate clone, state directory, Compose name and ports. Do not copy a live `.env` or `state/`. On a fresh checkout, an explicit instance name also allocates unused port offsets:

```sh
unset FEEDBACK_GRAPH_URL
FG_INSTANCE=feedback-graph-pilot ./scripts/setup.sh --yes --skip-agents --no-transcripts --projects /absolute/path/to/pilot-projects
```

Read the generated `.env` for `API_PORT`, `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`, `POSTGRES_PORT` and `OLLAMA_PORT`. Existing `.env` files keep their choices; changing `FG_INSTANCE` alone on an existing install does not move its ports. Setup refuses to start containers belonging to another checkout under the same name.

Run `./scripts/install-agent.sh --dry-run` from the new checkout before registering it. `FEEDBACK_GRAPH_URL` in your shell overrides this checkout's address for both agent registration and host `fg`; the scripts and doctor warn when it differs. Unset the override to use this installation. Register agents only when ready; each `FG_INSTANCE` gets its own MCP server name.

## Memory profiles

The default Neo4j container has a 3 GiB limit, 1 GiB heap and 512 MiB page cache. Transaction memory is part of heap accounting, not an additional reserve; native JVM, threads and mapped pages still need headroom. Reserve additional Docker VM memory for the worker, API, OS and any local model. `fg status` and doctor show container memory, remaining headroom and swap when host Docker cgroup counters are available. `status --watch` labels its startup host measurement as a snapshot; rerun status for a fresh measurement. No Docker socket is exposed to the API.

For a small pilot, add the checked-in small override after the base file and generated project mounts:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.small.yml
```

This sets a 1 GiB container limit, 512 MiB heap, 128 MiB page cache and 128 MiB transaction pool (32 MiB per transaction). Smaller memory trades throughput for headroom; start with low concurrent requests. Preserve any separately chosen runner compatibility override in the list. Run `docker compose config --quiet`, recreate Neo4j, then check doctor. If swap is nonzero or headroom falls below 15%, reduce load or increase the Docker VM/container budget; increasing heap alone can make host pressure worse.

## Tests on the host

Run `pnpm install` on the host before `pnpm test`. Do not reuse Linux container `node_modules` on macOS. For a single database contract, use `pnpm exec vitest run --project integration --no-file-parallelism <test-file>` for a single database contract. The contract suites require their disposable test database, never your live database. See [CONTRIBUTING](../CONTRIBUTING.md).
