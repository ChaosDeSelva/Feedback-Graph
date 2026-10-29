#!/usr/bin/env bash
# Checks every commit reachable from a ref (default HEAD) before it is pushed to the public repository: a push
# publishes the whole history, not only the files at the tip, and nothing pushed can be pulled back from clones.
#   ./scripts/check-public-history.sh [ref]          (run inside the repository to check)
# Fails on: a home folder that is not a placeholder (/Users/<name>, or Claude Code's -Users-<name>- folder names),
# anything ever added under docs/strategy/ (private planning), and any line of the private names file
# (PRIVATE_NAMES_FILE, default .git/info/private-names: one fixed string per line, # for comments; it lives inside
# .git, so it is never committed). Prints the commit and what matched, never the surrounding text.
set -euo pipefail
ref="${1:-HEAD}"
git rev-parse --verify -q "$ref^{commit}" >/dev/null || { echo "no such ref: $ref" >&2; exit 2; }
names_file="${PRIVATE_NAMES_FILE:-$(git rev-parse --git-path info/private-names)}"
# Kept in step with PLACEHOLDER_USERS in packages/core/src/publicTree.test.ts.
placeholders='you me j a x dev H test'

found=0
report() { echo "$1"; found=1; }

# One "commit <sha>" line per commit, then its author, message and patch.
log() { git log --no-color --format='commit %H%nauthor %an <%ae>%n%B' -p --full-history "$ref"; }

while IFS=$'\t' read -r sha match; do
  user="${match#*Users}"; user="${user#[/-]}"; user="${user%-}"
  case " $placeholders " in *" $user "*) ;; *) report "$sha: home folder $match" ;; esac
done < <(log | awk '
  /^commit [0-9a-f]{40}$/ { sha = substr($2, 1, 12); next }
  {
    line = $0
    while (match(line, /\/Users\/[A-Za-z0-9_.-]+|-Users-[A-Za-z0-9_.]+-/)) {
      print sha "\t" substr(line, RSTART, RLENGTH)
      line = substr(line, RSTART + RLENGTH)
    }
  }' | sort -u)

while IFS= read -r line; do
  report "private planning document in history: $line"
done < <(git log --no-color --format= --name-only --full-history "$ref" -- docs/strategy | sort -u)

if [ -f "$names_file" ]; then
  while IFS= read -r name || [ -n "$name" ]; do
    case "$name" in '' | '#'*) continue ;; esac
    n="$(log | grep -c -F -- "$name" || true)"
    [ "$n" = 0 ] || report "private name #$(grep -n -x -F -- "$name" "$names_file" | head -n 1 | cut -d: -f1) of $names_file: $n line(s)"
  done <"$names_file"
fi

if [ "$found" = 1 ]; then
  echo "the history of $ref is not fit to publish (see above); publish a fresh history instead (CONTRIBUTING.md)" >&2
  exit 1
fi
echo "history of $ref: no private paths, planning documents or names"
