#!/usr/bin/env bash
# CI's checks, locally: lint, typecheck, unit + UI tests and the integration suites on both backends (Neo4j and
# Postgres, throwaway containers from docker-compose.test.yml) with the coverage floor, and the UI build; plus the worker
# image as another uid, which CI skips. CI also builds both Docker images and always checks the pushed history; here
# the history check runs only on a `public` branch.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile >/dev/null
pnpm lint
pnpm typecheck
docker compose -f docker-compose.test.yml up -d --wait neo4j-test postgres-test >/dev/null
TEST_STORES=neo4j,postgres pnpm test:coverage:all
# The images run as a host uid other than 1000 (Linux, HOST_UID), checked in Docker.
./scripts/check-uid.sh >/dev/null
pnpm -F @fb/ui build >/dev/null
# The CSP (default-src 'self', no font-src) refuses data: fonts: the build must emit every font as a file.
if grep -l 'data:font' packages/ui/dist/assets/*.css >/dev/null 2>&1; then echo "the UI build inlined a font as a data: URL (see packages/ui/build/assets.ts)" >&2; exit 1; fi
# A push publishes the whole history: check the branch that is published (CONTRIBUTING.md, Publishing history).
if git rev-parse --verify -q public >/dev/null; then ./scripts/check-public-history.sh public
else echo "no public branch: history not checked (see CONTRIBUTING.md, Publishing history)"; fi
echo "all checks passed"
