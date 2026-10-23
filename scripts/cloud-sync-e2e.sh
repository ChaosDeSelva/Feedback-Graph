#!/usr/bin/env bash
# End to end: this repo's cloud sync against a real Feedback Graph Cloud.
#
#   ./scripts/cloud-sync-e2e.sh [path to the cloud repo]     (default ../feedback-graph-cloud, or CLOUD_REPO)
#
# Starts the cloud's docker compose under its own project name and port (dev login on, billing off, a throwaway
# database volume), creates an org and a sync+read token through dev login, then runs the cloud sync contract test
# (packages/core/src/cloud.int.test.ts) on throwaway test stores (docker-compose.test.yml), never your real stack. The
# test syncs a seeded project and checks its approved lesson arrived. The cloud project and its volumes are removed
# on exit, pass or fail. Not part of check.sh: the open-source gate never needs the hosted service.
set -euo pipefail
cd "$(dirname "$0")/.."
CLOUD_REPO="$(cd "${1:-${CLOUD_REPO:-../feedback-graph-cloud}}" && pwd)"
PORT="${CLOUD_E2E_PORT:-18788}"
PROJECT="fg-sync-e2e-$$"
URL="http://localhost:${PORT}"
WORK="$(mktemp -d)"

[ -f "$CLOUD_REPO/docker-compose.yml" ] || { echo "no docker-compose.yml in $CLOUD_REPO" >&2; exit 2; }

# Our own env file, so the cloud repo's .env (if any) is never read.
cat > "$WORK/env" <<EOF
POSTGRES_PASSWORD=e2e-$(openssl rand -hex 12)
PUBLIC_URL=${URL}
SECRETS_KEY=$(openssl rand -base64 32)
NODE_ENV=development
DEV_LOGIN=1
API_PORT=${PORT}
BILLING_DISABLED=0
EOF

compose() { docker compose -p "$PROJECT" --env-file "$WORK/env" -f "$CLOUD_REPO/docker-compose.yml" "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "starting the cloud ($PROJECT on :$PORT)"
compose up -d --build >/dev/null
for _ in $(seq 1 90); do
  curl -fsS "$URL/api/ready" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$URL/api/ready" >/dev/null || { compose logs api | tail -40; echo "the cloud did not become ready" >&2; exit 1; }

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const k=process.argv[1].split(".");let x=v;for(const p of k)x=x?.[p];if(x===undefined){console.error(s);process.exit(1)}console.log(x)})' "$1"; }
JAR="$WORK/cookies"
H=(-H "origin: ${URL}" -H 'content-type: application/json')

CSRF="$(curl -fsS -c "$JAR" "${H[@]}" -X POST "$URL/auth/dev/login" -d '{"email":"e2e-owner@example.com"}' | json csrfToken)"
curl -fsS -b "$JAR" "${H[@]}" -H "x-csrf-token: $CSRF" -X POST "$URL/api/v1/orgs" -d '{"slug":"e2e","name":"Sync E2E"}' >/dev/null
TOKEN="$(curl -fsS -b "$JAR" "${H[@]}" -H "x-csrf-token: $CSRF" -X POST "$URL/api/v1/orgs/e2e/tokens" -d '{"name":"sync e2e","scopes":["sync","read"]}' | json token)"

echo "running the sync against it"
docker compose -f docker-compose.test.yml up -d --wait neo4j-test postgres-test >/dev/null
CLOUD_E2E_URL="$URL" CLOUD_E2E_TOKEN="$TOKEN" CLOUD_E2E_ORG=e2e \
  TEST_STORES="${TEST_STORES:-neo4j,postgres}" TEST_PG_URL="${TEST_PG_URL:-postgres://fg:fg@localhost:5433/fg_test_cloud_e2e}" \
  pnpm vitest run --project integration --no-file-parallelism packages/core/src/cloud.int.test.ts
echo "cloud sync end to end passed"
