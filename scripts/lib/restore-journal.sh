# shellcheck shell=bash
# The journal of a restore in progress (.restore/journal: the backup, the services it stopped, its pid and how far it
# got). restore.sh writes it; a restore killed part-way leaves it, so the next restore, backup or doctor run says so
# instead of the store and the worker state silently coming from different backups. Sourced from the repo root.

restore_dir=.restore
restore_journal="$restore_dir/journal"
# In the live state/ from the moment the store is being replaced until the restored state/ (which has none) takes its
# place: while it is there the worker refuses to start (packages/worker/src/main.ts), so a mismatched pair never runs.
restore_marker=state/.restore-incomplete

journal_get() { [ ! -f "$restore_journal" ] || sed -n "s/^$1=//p" "$restore_journal" | tail -n 1; }
journal_set() { printf '%s=%s\n' "$1" "$2" >>"$restore_journal"; }
proc_start() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null || true; }

# untouched (still unpacking the worker state: no service stopped, by it or by a restore interrupted before it), before
# (nothing replaced yet, but services may be stopped) or replacing (the store or the worker state may already be the
# backup's while the other is not; also while a restore that follows such an interrupted one has not replaced both yet).
# Empty without a journal.
restore_phase() {
  [ -f "$restore_journal" ] || return 0
  case "$(journal_get step)" in
    replacing | state) echo replacing ;;
    *) if [ -n "$(journal_get unsettled)" ]; then echo replacing
      elif [ "$(journal_get step)" = unpacking ] && [ -z "$(journal_get running)" ]; then echo untouched
      else echo before; fi ;;
  esac
}
# Why the journal is not one restore.sh wrote (a key it never writes, or a value of a form it never writes), empty when
# it is. A journal that fails this is never acted on: its values name a process to wait for and services to start.
journal_problem() {
  [ -f "$restore_journal" ] || return 0
  if LC_ALL=C grep -q '[[:cntrl:]]' "$restore_journal"; then echo "holds a control character"; return 0; fi
  LC_ALL=C awk '
    function bad(why) { print "line " NR " " why; exit }
    { i = index($0, "="); k = substr($0, 1, i - 1); v = substr($0, i + 1) }
    i == 0 { bad("is not key=value") }
    k == "pid" { if (v !~ /^[1-9][0-9]*$/ || length(v) > 10 || v == 1) bad("pid is not a process id above 1"); next }
    k == "started" { if (v !~ /^[A-Za-z0-9: ]*$/) bad("started is not a process start time"); next }
    k == "src" || k == "unsettled" { if (length(v) > 4096) bad(k " is too long"); next }
    k == "store" { if (v != "neo4j" && v != "postgres") bad("store is neither neo4j nor postgres"); next }
    k == "running" { if (v !~ /^([a-z0-9][a-z0-9_-]*( [a-z0-9][a-z0-9_-]*)*)?$/) bad("running is not a list of service names"); next }
    k == "step" { if (v !~ /^(unpacking|stopping|loading|replacing|state)$/) bad("step is not a step restore.sh takes"); next }
    { bad("has a key restore.sh never writes") }
  ' "$restore_journal"
}
# What a journal restore.sh did not write means, and what to do.
restore_damaged() {
  echo "the restore journal ($restore_journal) is not one restore.sh wrote ($(journal_problem)), so nothing here acts on it."
  echo "  Next: check that no restore is running here, then remove $restore_dir and run ./scripts/doctor.sh (a restore it recorded may have left the store and state/ from different backups: restore a backup if unsure)."
}
# none, running (its restore is still at work), damaged (restore_damaged), or the phase a killed restore stopped in.
restore_status() {
  local pid
  [ -f "$restore_journal" ] || { echo none; return 0; }
  [ -z "$(journal_problem)" ] || { echo damaged; return 0; }
  pid="$(journal_get pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$(proc_start "$pid")" = "$(journal_get started)" ]; then echo running; return 0; fi
  restore_phase
}

# What an interrupted restore left and what to run next, for its phase (untouched, before or replacing).
restore_interrupted() {
  local src store from
  src="$(journal_get src)" store="$(journal_get store)"
  if [ "$1" = untouched ]; then
    echo "a restore from $src was interrupted while unpacking the backup, before it stopped or replaced anything: the $store store, the worker state and the stack are as they were."
    echo "  Next: ./scripts/restore.sh --abandon removes what it left (or restore a backup)."
  elif [ "$1" = before ]; then
    echo "a restore from $src was interrupted before anything was replaced: the $store store and the worker state are as they were, but the stack was left stopped."
    echo "  Next: ./scripts/restore.sh --abandon removes what it left and starts the stack again (or restore a backup)."
  else
    from="$(journal_get unsettled)"
    case "$(journal_get step)" in replacing | state) from="$src" ;; esac
    echo "a restore from $from was interrupted while replacing the $store store and the worker state: the store may be that backup's while the worker state is the previous one, so the worker will not start."
    echo "  Next: finish it with ./scripts/restore.sh $src (or restore another backup)."
  fi
}
