#!/usr/bin/env bash
# End to end: this repo's cloud sync against a real Feedback Graph Cloud.
#
#   ./scripts/cloud-sync-e2e.sh [path to the cloud repo]     (default ../feedback-graph-cloud, or CLOUD_REPO)
#
# Everything it uses is its own and thrown away on exit, pass or fail, images it built included: the cloud's docker
# compose under a project name of its own (dev login on, billing off, a throwaway database volume), and its own Neo4j
# and Postgres test containers
# (tmpfs, on ports of their own), never docker-compose.test.yml's shared ones or your real stack. It creates an org
# and a sync+read token through dev login, turns the org's review gate off (a new org reviews synced lessons, so they
# would arrive as "suggested"; the cloud's own e2e covers the gate), then runs the cloud sync contract test
# (packages/core/src/cloud.int.test.ts): a seeded project's approved lesson arrives as a team lesson, and unselecting
# the project takes it back out. Not part of check.sh: the open-source gate never needs the hosted service.
#
# Ports: CLOUD_E2E_PORT (cloud, 18788), CLOUD_E2E_NEO4J_PORT (17697), CLOUD_E2E_PG_PORT (15443).
set -euo pipefail
cd "$(dirname "$0")/.."
CLOUD_REPO="$(cd "${1:-${CLOUD_REPO:-../feedback-graph-cloud}}" && pwd)"
PORT="${CLOUD_E2E_PORT:-18788}"
NEO4J_PORT="${CLOUD_E2E_NEO4J_PORT:-17697}"
PG_PORT="${CLOUD_E2E_PG_PORT:-15443}"
PROJECT="fg-sync-e2e-$$"
NEO4J_NAME="${PROJECT}-neo4j"
PG_NAME="${PROJECT}-postgres"
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
  compose down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
  docker rm -f -v "$NEO4J_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  docker logs "$1" 2>&1 | tail -20
  echo "$1 did not become healthy" >&2
  exit 1
}

echo "starting this run's test stores ($NEO4J_NAME on :$NEO4J_PORT, $PG_NAME on :$PG_PORT)"
docker run -d --name "$NEO4J_NAME" --tmpfs /data -e NEO4J_AUTH=neo4j/testpassword -p "127.0.0.1:${NEO4J_PORT}:7687" \
  --health-cmd 'wget -qO- http://localhost:7474 >/dev/null || exit 1' --health-interval 3s --health-retries 40 \
  neo4j:5.26-community >/dev/null
docker run -d --name "$PG_NAME" --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=fg -e POSTGRES_PASSWORD=fg -e POSTGRES_DB=fg_test \
  -p "127.0.0.1:${PG_PORT}:5432" --health-cmd 'pg_isready -U fg -d fg_test' --health-interval 2s --health-retries 40 \
  pgvector/pgvector:0.8.7-pg17 >/dev/null

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
# The review gate: off for this org, so an approved lesson becomes a team lesson at once.
GATE="$(curl -fsS -b "$JAR" "${H[@]}" -H "x-csrf-token: $CSRF" -X PUT "$URL/api/v1/orgs/e2e/sync-settings" -d '{"teamLessonApproval":false}' | json teamLessonApproval)"
[ "$GATE" = false ] || { echo "could not turn the review gate off (teamLessonApproval=$GATE)" >&2; exit 1; }

echo "running the sync against it"
wait_healthy "$NEO4J_NAME"
wait_healthy "$PG_NAME"
CLOUD_E2E_URL="$URL" CLOUD_E2E_TOKEN="$TOKEN" CLOUD_E2E_ORG=e2e \
  NEO4J_TEST_URL="bolt://127.0.0.1:${NEO4J_PORT}" TEST_PG_URL="postgres://fg:fg@localhost:${PG_PORT}/fg_test_cloud_e2e" \
  TEST_STORES="${TEST_STORES:-neo4j,postgres}" \
  pnpm vitest run --project integration --no-file-parallelism packages/core/src/cloud.int.test.ts
echo "cloud sync end to end passed"
