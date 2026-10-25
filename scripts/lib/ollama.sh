# shellcheck shell=bash
# Sourced by setup.sh and doctor.sh: checks of the Ollama on this machine that a /api/tags call cannot make.

# One real schema-constrained /api/chat call (a `format` JSON schema, as the classifier sends), because a server can list
# its models and still refuse every structured call (Homebrew's ollama formula ships its MLX runner without the grammar
# library: HTTP 501 "structured output is unavailable"). It sends what the workers send: think:false (so a thinking model
# answers in content, not in its reasoning) and num_ctx (the third argument, else 16384). Sets PROBE (ok | unsupported |
# notjson | thinking | error | timeout) and PROBE_DETAIL (the server's words, one line). The first call loads the model,
# so it can take a minute.
ollama_structured_probe() {
  local url="$1" model="$2" ctx="${3:-16384}" think='"think":false,' out rc code body
  case "$ctx" in '' | *[!0-9]*) ctx=16384 ;; esac
  while :; do
    rc=0
    out="$(curl -sS --max-time "${OLLAMA_PROBE_SECONDS:-180}" -H 'content-type: application/json' \
      -d "$(printf '{"model":"%s","stream":false,%s"messages":[{"role":"user","content":"Reply with a JSON object whose ok field is true."}],"format":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]},"options":{"num_predict":64,"temperature":0,"num_ctx":%s}}' "$model" "$think" "$ctx")" \
      -w '\n%{http_code}' "$url/api/chat" 2>&1)" || rc=$?
    code="$(printf '%s' "$out" | tail -n 1)"
    body="$(printf '%s' "$out" | sed '$d' | tr '\n' ' ' | cut -c1-300)"
    # An Ollama from before thinking existed may refuse the field: ask once more without it, as the workers do.
    if [ "$code" = 400 ] && [ -n "$think" ] && printf '%s' "$body" | grep -qi 'think'; then think=''; continue; fi
    break
  done
  PROBE_DETAIL="$body"
  if [ "$rc" = 28 ]; then PROBE=timeout; PROBE_DETAIL="no answer within ${OLLAMA_PROBE_SECONDS:-180}s"; return; fi
  case "$code" in
    200)
      # The answer's content must be the JSON object itself: "content":"{...". Empty content with the text in
      # "thinking" means the model spent its answer reasoning, which is what think:false is there to stop.
      if printf '%s' "$body" | grep -qE '"content":[[:space:]]*"[[:space:]]*\{'; then PROBE=ok
      elif printf '%s' "$body" | grep -qE '"content":[[:space:]]*""' && printf '%s' "$body" | grep -qE '"thinking":[[:space:]]*"[^"]'; then PROBE=thinking
      else PROBE=notjson; fi
      ;;
    501) PROBE=unsupported ;;
    *)
      if printf '%s' "$body" | grep -qi 'structured output'; then PROBE=unsupported
      else PROBE=error; [ -n "$body" ] || PROBE_DETAIL="no answer (curl exit $rc)"; fi
      ;;
  esac
}

# What to do when the probe's model answered only in its thinking.
ollama_thinking_fix() {
  echo "  The model ignored think:false and wrote its reasoning instead of the JSON, so classifications would come back empty."
  echo "  Update Ollama (think:false needs 0.9 or later), or choose a model or tag without thinking for OLLAMA_MODEL or"
  echo "  CLASSIFY_LLM (for example ollama:<model> of a non-thinking tag)."
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
