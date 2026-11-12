#!/usr/bin/env bash
# Source from setup.sh. Only API-owned configuration moves; archives keep their separate
# encrypted directory. Docker follows a link at a mount source, and a container can write state/: a link (or anything
# but a folder) where a mounted folder belongs is refused, and the files are moved without following one.
. "$(dirname "${BASH_SOURCE[0]}")/state-fs.sh"
prepare_api_settings() (
  set -eu
  cd "${1:-.}"
  old=state/settings
  target=state/api-settings
  # The files move only into a new state/api-settings, once, from an install from before it: the worker writes
  # state/settings, so a project-roots.json found there later may be its, naming host folders for this setup to mount.
  legacy=0
  [ -e "$target" ] || [ -L "$target" ] || legacy=1
  for path in state "$old" "$target" "$old/redaction-archive"; do
    [ ! -L "$path" ] || { echo "Refusing symlinked settings directory: $path" >&2; exit 1; }
    state_dir "$path"
    in_state_dir "$path" chmod 700 .
  done
  in_state_dir "$target" mkdir .migration-lock 2>/dev/null || { echo 'Another settings migration is running; retry setup after it finishes.' >&2; exit 1; }
  trap 'in_state_dir "$target" rmdir .migration-lock' EXIT
  for name in project-roots.json integrations.json .run-key-salt; do
    source="$old/$name" destination="$target/$name"
    if [ "$legacy" = 1 ]; then
      [ ! -L "$source" ] || { echo "Refusing symlinked API setting: $name" >&2; exit 1; }
      if from="$(state_grab "$source")"; then
        # Moved: linked into its new place, then dropped from the old one.
        in_state_dir "$target" state_place_ "$from" "$name"
        rm -f "$from"
        state_rm "$source"
      elif [ -e "$source" ]; then
        echo "Refusing API setting $name: $source is not a file" >&2; exit 1
      fi
    fi
    if to="$(state_grab "$destination")"; then chmod 600 "$to"; rm -f "$to"; fi
  done
)
