#!/usr/bin/env bash
# Install only the runner's explicit userns policy; never disable host AppArmor or userns restrictions.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(id -u)" != 0 ]; then echo "Run: sudo ./scripts/install-runner-apparmor.sh" >&2; exit 1; fi
command -v apparmor_parser >/dev/null || { echo "Install the host's AppArmor tools first (Ubuntu: apt install apparmor)." >&2; exit 1; }
install -m 0644 "$here/scripts/apparmor/feedback-graph-codex-runner" /etc/apparmor.d/feedback-graph-codex-runner
apparmor_parser -r /etc/apparmor.d/feedback-graph-codex-runner
echo "Loaded feedback-graph-codex-runner. Set CODEX_RUNNER_APPARMOR=feedback-graph-codex-runner in .env."
