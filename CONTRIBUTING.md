# Contributing

Thanks for helping. Bug reports, redaction patterns and transcript-format fixes are especially welcome.

## Set up

Node 26.5+ (native TypeScript, no build step), pnpm 11 (CI pins Node 26.5.0 and pnpm 11.13.1) and Docker.

```sh
pnpm install
pnpm lint                                                       # ESLint correctness checks (not formatting)
pnpm typecheck
pnpm test                                                       # unit + UI
docker compose -f docker-compose.test.yml up -d --wait          # throwaway Neo4j (port 7688) and Postgres (5433)
pnpm test:int                                                   # integration contract suites on Neo4j
pnpm test:int:postgres                                          # the same suites on Postgres
TEST_STORES=neo4j,postgres pnpm test:coverage:all              # everything with coverage, held to the floor in vitest.config.ts
./scripts/check.sh                                              # CI's checks plus the uid check, starting the test databases itself
```

`check.sh` checks the history only when a `public` branch exists (see Publishing history), and CI also builds both Docker images.

`NEO4J_TEST_URL` and `TEST_PG_URL` point the integration suites at other test databases; a Postgres database name must contain `test`, because the suites wipe it. `test:coverage:all` (`scripts/coverage-all.sh`) runs every stage even when one fails, merges the reports into `coverage/`, and only that merged report is held to the floor. When coverage rises, raise the floor in `vitest.config.ts`.

## Conventions

- **Tests first.** A change in behavior comes with a test that failed before it. Integration tests (`*.int.test.ts`) run against the throwaway databases in `docker-compose.test.yml`, never against your real graph.
- **Tests never reach your install.** Every test project drops your shell's `FEEDBACK_*`, `FG_*` (except `FG_TEST_*`), `API_TOKEN`, `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` and `DOCKER_HOST` before it runs. Timing assertions use fake timers or CPU time, never wall-clock sleeps.
- **Storage goes through the `Store` interfaces** (`packages/core/src/store.ts`), never a backend class. Integration tests are contract suites (`describeStores`) that run once per backend in `TEST_STORES` (default `neo4j`); check what is stored with the test probe, not Cypher or SQL. See `packages/store-postgres/README.md`.
- **TypeScript runs natively**, so only erasable syntax: no enums, no parameter properties, no namespaces. Import with the `.ts` extension.
- **Anything that reaches a model or the graph goes through redaction** (`redactSecrets` / `redactDeep`). Anything shown to an agent that came from outside (docs, PRs, tickets, model output) is fenced as data.
- **Provenance.** If your change creates or changes knowledge (facts, lessons, decisions), record an Activity entry saying who or what did it and why.
- Keep comments for the why, not the what.

## Publishing history

A push publishes every commit, not only the files at the tip, and what is pushed cannot be pulled back from clones.
`./scripts/check-public-history.sh <ref>` checks the whole history of a ref for a contributor's real home folder,
anything ever under `docs/strategy/`, and the names in `.git/info/private-names` (one per line; it is inside `.git`,
so it is never committed). CI runs it on every push to `main` and on every pull request. When a history fails it, publish a fresh one instead of
rewriting it in place: `git branch public $(git commit-tree HEAD^{tree} -m "Feedback Graph <version>")`, check it
(`./scripts/check-public-history.sh public`; `./scripts/check.sh` does this whenever a `public` branch exists), and
push only that branch.

## Sign your work (DCO)

Every commit needs a `Signed-off-by` line certifying the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or have the right to submit it under the project's license.

```sh
git commit -s -m "fix: ..."
```

## License

By contributing you agree your contribution is licensed under the Apache License 2.0 (see `LICENSE`).
