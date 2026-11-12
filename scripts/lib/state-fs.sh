# shellcheck shell=bash
# Host-side reads and writes under state/, sourced from the repo root. The worker mounts ./state read-write (the api and
# the runner mount folders of it), so any path under state/ may be a link, a FIFO or a folder that a compromised
# container left there for a host script to write through, or to read a host file into state/ with. So no path under
# it is opened by name:
#   - a folder is made one level at a time, never through a link, and the commands that act in it run inside it, after
#     checking that the folder entered is the one named (pwd -P), so no link on the way can move them elsewhere;
#   - a file is written in .host/ (in the checkout, which no container can write) and hard-linked into place with ln -n,
#     which neither follows nor replaces what is there;
#   - a file is read, or its mode changed, through a hard link made in .host/ first (ln -P links a link itself, not its
#     target), and only when that is a plain file.

FG_HOST_DIR=.host

# A new empty file in .host/ (mode 600); prints its path.
host_tmp() { { [ -d "$FG_HOST_DIR" ] || mkdir -m 700 "$FG_HOST_DIR"; } && mktemp "$FG_HOST_DIR/tmp.XXXXXX"; }

# state_dir <dir>: <dir> (under state/) and each folder above it made if missing; fails, saying why, when one of them is
# a link or not a folder.
state_dir() {
  local path="" part parts=()
  IFS=/ read -r -a parts <<<"$1"
  for part in "${parts[@]}"; do
    path="${path:+$path/}$part"
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
      echo "$path is a link or not a folder (a container may have put it there): remove it, then run this again" >&2
      return 1
    fi
    [ -d "$path" ] || mkdir "$path" || return 1
  done
}

# in_state_dir <dir> <command> [args...]: the command run inside <dir> (made if missing), once that is checked to be the
# folder named. FG_STATE_ROOT is then the checkout (physical), where .host/ is.
in_state_dir() {
  local dir="$1"
  shift
  state_dir "$dir" || return 1
  (
    cd -P . && FG_STATE_ROOT="$PWD" && cd -P "$dir" 2>/dev/null && [ "$PWD" = "$FG_STATE_ROOT/$dir" ] ||
      { echo "$dir was replaced while it was in use (a container may have done it): run this again" >&2; exit 1; }
    "$@"
  )
}

# state_write <file> [mode]: stdin as <file> (mode 600 unless given), replacing a file, link or FIFO there, never a folder.
state_write() {
  local tmp status
  tmp="$(host_tmp)" || return 1
  if cat >"$tmp" && chmod "${2:-600}" "$tmp"; then
    in_state_dir "${1%/*}" state_place_ "$tmp" "${1##*/}"
    status=$?
  else status=1; fi
  rm -f "$tmp"
  return "$status"
}
# ln -n neither follows nor replaces what is at <name>; rm -f before it removes a link itself, and fails on a folder.
state_place_() { rm -f -- "$2" && ln -n -- "$FG_STATE_ROOT/$1" "$2"; }

# state_rm <file>: removes <file> (a link itself, not its target); a folder is left, and that fails.
state_rm() { [ ! -e "$1" ] && [ ! -L "$1" ] || in_state_dir "${1%/*}" rm -f -- "${1##*/}"; }

# state_grab <file>: when <file> is a plain file, prints the path of a hard link to it in .host/ (the caller removes
# it); fails otherwise (missing, a link, a FIFO, a folder). Its content is the container's to change, its kind is not.
state_grab() {
  local tmp
  [ -e "$1" ] || [ -L "$1" ] || return 1
  tmp="$(host_tmp)" && rm -f "$tmp" || return 1
  if in_state_dir "${1%/*}" state_link_out_ "${1##*/}" "$tmp" 2>/dev/null && [ -f "$tmp" ] && [ ! -L "$tmp" ]; then
    printf '%s' "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}
# ln -P links <name> itself, a link included, never its target.
state_link_out_() { ln -P -- "$1" "$FG_STATE_ROOT/$2"; }

# state_read <file> [max bytes]: at most max (default 64 KiB) bytes of <file>, when it is a plain file; fails otherwise.
state_read() {
  local tmp
  tmp="$(state_grab "$1")" || return 1
  head -c "${2:-65536}" "$tmp"
  rm -f "$tmp"
}
