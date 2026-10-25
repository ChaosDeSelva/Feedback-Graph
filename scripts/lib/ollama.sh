# shellcheck shell=bash
# Sourced by setup.sh and doctor.sh: checks of the Ollama on this machine that a /api/tags call cannot make.

# One real schema-constrained /api/chat call (a `format` JSON schema, as the classifier sends), because a server can list
# its models and still refuse every structured call (Homebrew's ollama formula ships its MLX runner without the grammar
# library: HTTP 501 "structured output is unavailable"). Sets PROBE (ok | unsupported | notjson | error | timeout) and
# PROBE_DETAIL (the server's words, one line). The first call loads the model, so it can take a minute.
ollama_structured_probe() {
  local url="$1" model="$2" out rc=0 code body
  local payload
  payload="$(printf '{"model":"%s","stream":false,"messages":[{"role":"user","content":"Reply with a JSON object whose ok field is true."}],"format":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]},"options":{"num_predict":64,"temperature":0}}' "$model")"
  out="$(curl -sS --max-time "${OLLAMA_PROBE_SECONDS:-180}" -H 'content-type: application/json' -d "$payload" -w '\n%{http_code}' "$url/api/chat" 2>&1)" || rc=$?
  code="$(printf '%s' "$out" | tail -n 1)"
  body="$(printf '%s' "$out" | sed '$d' | tr '\n' ' ' | cut -c1-300)"
  PROBE_DETAIL="$body"
  if [ "$rc" = 28 ]; then PROBE=timeout; PROBE_DETAIL="no answer within ${OLLAMA_PROBE_SECONDS:-180}s"; return; fi
  case "$code" in
    200)
      # The answer's content must be the JSON object itself: "content":"{...".
      if printf '%s' "$body" | grep -qE '"content":[[:space:]]*"[[:space:]]*\{'; then PROBE=ok; else PROBE=notjson; fi
      ;;
    501) PROBE=unsupported ;;
    *)
      if printf '%s' "$body" | grep -qi 'structured output'; then PROBE=unsupported
      else PROBE=error; [ -n "$body" ] || PROBE_DETAIL="no answer (curl exit $rc)"; fi
      ;;
  esac
}

# How to get an Ollama with structured output, printed after a failed probe.
ollama_structured_fix() {
  echo "  The classifier sends every request with a JSON schema; this Ollama cannot honour one, so nothing gets classified."
  if [ "$(uname -s)" = Darwin ]; then
    echo "  On macOS install the official Ollama app (https://ollama.com/download, or: brew install --cask ollama-app),"
    echo "  not the Homebrew formula. Stop the formula's server first so the two do not race for port 11434:"
    echo "    brew services stop ollama && brew uninstall ollama    # then open the Ollama app"
  else
    echo "  Install Ollama from https://ollama.com/download (the official build), restart it, and run this again."
  fi
  echo "  Or run the classifier elsewhere: CLASSIFY_LLM=claude-cli (or another provider) in .env."
}
