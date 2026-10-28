# Sourced by setup.sh; no host settings are changed here.
runner_apparmor_check() {
  local restricted="$1" profiles="$2" selected="$3"
  [ -r "$restricted" ] && [ "$(cat "$restricted")" = 1 ] || return 0
  if [ -n "$selected" ] && [ "$selected" != unconfined ]; then
    # Kernel profile inventories are often root-only. Docker validates an explicit profile when starting it.
    [ -r "$profiles" ] || return 0
    if grep -Fxq "$selected (enforce)" "$profiles"; then return 0; fi
  fi
  echo "not starting the Codex runner: this Linux host restricts unprivileged user namespaces."
  echo "  Run: sudo ./scripts/install-runner-apparmor.sh"
  echo "  Set CODEX_RUNNER_APPARMOR=feedback-graph-codex-runner in .env, then rerun ./scripts/setup.sh."
  echo "  The named profile must be loaded on the Docker host; no global kernel restriction is changed."
  return 1
}
