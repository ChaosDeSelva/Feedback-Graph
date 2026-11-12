#!/usr/bin/env bash
# Coverage over every test project: unit + ui, then the integration contract suites on each backend in TEST_STORES
# (needs the test databases: docker-compose.test.yml, or NEO4J_TEST_URL / TEST_PG_URL), merged into one report in
# coverage/ and held to the floor in vitest.config.ts. Every stage runs even when an earlier one fails, so the
# report is whole; the exit code is non-zero when any test or the floor fails.
set -uo pipefail
cd "$(dirname "$0")/.."
rm -rf .vitest-reports
status=0
pnpm exec vitest run --project unit --project ui --coverage --reporter=default --reporter=blob --outputFile.blob=.vitest-reports/unit.json || status=1
pnpm exec vitest run --project integration --no-file-parallelism --coverage --reporter=default --reporter=blob --outputFile.blob=.vitest-reports/int.json || status=1
FG_COVERAGE_GATE=1 pnpm exec vitest run --merge-reports --coverage --reporter=dot || status=1
exit "$status"
