#!/usr/bin/env bash
# Creates a real Claude Code session in examples/demo-shop with a pushback turn, for an end-to-end test
# of Feedback Graph. Uses your Claude subscription via the local `claude` CLI. Edits are reverted at the end.
set -euo pipefail
. "$(dirname "$0")/lib/json.sh"
cd "$(dirname "$0")/../examples/demo-shop"
tools="Read,Edit,Write,Glob,Grep"

first=$(claude -p "Add a GET /orders endpoint that lists the caller's orders. Add an orders table to src/db.ts with a few seed rows (id, orgId, createdAt, totalCents). Keep it minimal." \
  --output-format json --permission-mode acceptEdits --allowedTools "$tools" < /dev/null)
sid=$(printf '%s' "$first" | json_field session_id)
echo "session: $sid"

claude -p --resume "$sid" "This isn't good enough. Orders must come back newest first, and you didn't add a test for the endpoint. Every list endpoint here needs a sort order and a cross-tenant test." \
  --output-format json --permission-mode acceptEdits --allowedTools "$tools" < /dev/null > /dev/null
echo "pushback sent on session $sid"

# Leave the example as committed so the demo can be re-run.
git checkout -- . && git clean -fdq .
echo "demo-shop restored"
