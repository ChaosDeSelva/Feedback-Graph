#!/usr/bin/env bash
# Everything CI runs, locally: typecheck, unit + UI tests, the integration suites on both backends (Neo4j and
# Postgres, throwaway containers from docker-compose.test.yml), the UI build.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile >/dev/null
pnpm typecheck
pnpm test
docker compose -f docker-compose.test.yml up -d --wait neo4j-test postgres-test >/dev/null
TEST_STORES=neo4j,postgres pnpm test:int
pnpm -F @fb/ui build >/dev/null
# The CSP (default-src 'self', no font-src) refuses data: fonts: the build must emit every font as a file.
if grep -l 'data:font' packages/ui/dist/assets/*.css >/dev/null 2>&1; then echo "the UI build inlined a font as a data: URL (see packages/ui/build/assets.ts)" >&2; exit 1; fi
# A push publishes the whole history: check the branch that is published (CONTRIBUTING.md, Publishing history).
if git rev-parse --verify -q public >/dev/null; then ./scripts/check-public-history.sh public
else echo "no public branch: history not checked (see CONTRIBUTING.md, Publishing history)"; fi
echo "all checks passed"
