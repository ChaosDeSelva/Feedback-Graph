#!/usr/bin/env bash
# Source from setup.sh. Only API-owned configuration moves; archives keep their separate encrypted directory.
prepare_api_settings() (
  set -eu
  root="${1:-.}"
  old="$root/state/settings"
  target="$root/state/api-settings"
  for path in "$root/state" "$old" "$target" "$old/redaction-archive"; do
    [ ! -L "$path" ] || { echo "Refusing symlinked settings directory: $path" >&2; exit 1; }
    mkdir -p "$path"
    chmod 700 "$path"
  done
  mkdir "$target/.migration-lock" 2>/dev/null || { echo 'Another settings migration is running; retry setup after it finishes.' >&2; exit 1; }
  trap 'rmdir "$target/.migration-lock"' EXIT
  for name in project-roots.json integrations.json .run-key-salt; do
    source="$old/$name" destination="$target/$name"
    [ ! -L "$source" ] && [ ! -L "$destination" ] || { echo "Refusing symlinked API setting: $name" >&2; exit 1; }
    if [ -f "$source" ]; then
      if [ -e "$destination" ]; then
        cmp -s "$source" "$destination" || { echo "Conflicting API setting $name; reconcile the two local files before retrying setup." >&2; exit 1; }
        rm "$source"
      else
        mv "$source" "$destination"
      fi
    fi
    [ ! -f "$destination" ] || chmod 600 "$destination"
  done
)
