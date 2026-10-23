# Contributing

Thanks for helping. Bug reports, redaction patterns and transcript-format fixes are especially welcome.

## Set up

Node 26.5+ (native TypeScript, no build step), pnpm 11, Docker.

```sh
pnpm install
pnpm test                                                           # unit + UI
docker compose -f docker-compose.test.yml up -d --wait && pnpm test:int   # Neo4j integration
pnpm test:int:postgres                                              # the same contract suites on Postgres
./scripts/check.sh                                                  # everything CI runs
```

## Conventions

- **Tests first.** A change in behavior comes with a test that failed before it. Integration tests (`*.int.test.ts`) run against throwaway databases (docker-compose.test.yml); never against your real graph.
- **Storage goes through the `Store` interfaces** (`packages/core/src/store.ts`), never a backend class. Integration tests are contract suites (`describeStores`) that run once per backend in `TEST_STORES` (default `neo4j`); check what is stored with the test probe, not Cypher or SQL. See `packages/store-postgres/README.md`.
- **TypeScript runs natively**, so only erasable syntax: no enums, no parameter properties, no namespaces. Import with the `.ts` extension.
- **Anything that reaches a model or the graph goes through redaction** (`redactSecrets` / `redactDeep`). Anything shown to an agent that came from outside (docs, PRs, tickets, model output) is fenced as data.
- **Provenance.** If your change creates or changes knowledge (facts, lessons, decisions), record an Activity entry saying who or what did it and why.
- Keep comments for the why, not the what.

## Publishing history

A push publishes every commit, not only the files at the tip, and what is pushed cannot be pulled back from clones.
`./scripts/check-public-history.sh <ref>` checks the whole history of a ref for a contributor's real home folder,
anything ever under `docs/strategy/`, and the names in `.git/info/private-names` (one per line; it is inside `.git`,
so it is never committed). CI runs it on every push. When a history fails it, publish a fresh one instead of
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
