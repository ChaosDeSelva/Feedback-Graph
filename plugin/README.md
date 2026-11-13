# Feedback Graph plugin for Claude Code

Puts the lessons from your own pushback in front of Claude Code at the moments they matter, from a local [Feedback Graph](../README.md).

```
/plugin marketplace add ChaosDeSelva/Feedback-Graph
/plugin install feedback-graph@feedback-graph
```

Or, from a clone: `claude --plugin-dir ./plugin`.

## What it adds

| Piece | When | What |
|---|---|---|
| MCP server `fg` (tools appear as `mcp__plugin_feedback-graph_fg__<tool>`) | always | `get_task_context`, `get_module_context`, `impact`, `check_before_done`, `search_graph`, `get_recent_sessions` (all marked read-only) and `report_feedback`; with knowledge intake on (`INTAKE_ENABLED`), also `what_do_we_know` and `find_contradictions` (read-only) and `submit_notes` |
| Hook: prompt | each request of 20+ characters (not `/commands`, `!` shell, or a question that asks for no change) | the task's approved lessons, the past misses on the files the request names and the AGENTS.md / CLAUDE.md files on their path (about 1,500 characters, though a single longer approved lesson is shown whole; the rest is one `get_task_context` call away), added as context. Once per session, then only when a lesson, miss or instructions file not yet shown applies. After a `get_task_context` that failed slowly (a hanging model), no prompt waits on it for 2 minutes |
| Hook: edit | before the first `Edit`/`Write`/`MultiEdit`/`NotebookEdit` of a file in the session | when the file has lessons or past misses, its whole module context (`get_module_context`: what the file is, its symbols, importers, imports and tests, its lessons and past misses), cut between lines at 9,000 characters, under Claude Code's 10,000 limit, saying so |
| Hook: stop | when Claude is about to finish | once: if it changed files (or committed) and has not called `check_before_done` since, it is asked to, with the files it edited, and to address or explain each gap. A check whose judge failed, or one still queued after 3 rounds, is said once not to have run, and the stop goes through until the session changes something again |
| Hook: session | at session start or resume, and after `/clear` or a compaction | with `FG_RUN` set, registers the session with that labelled run (and warns when that fails); then forgets what was shown, so it is shown again |
| Skill `feedback-graph` | non-trivial tasks | when to call each tool |
| Skill `postmortem` | `/postmortem what it missed` | records a miss for the Inbox |
| Skill `test-from-feedback` | writing tests, QA | one test case per lesson and past miss on the code you touched, run, and reported with the lesson it guards |

## Settings (environment)

- `FEEDBACK_GRAPH_URL`: default `http://localhost:8787`.
- `FEEDBACK_GRAPH_TOKEN`: the Feedback Graph's `API_TOKEN`, when it has one.
- `FEEDBACK_GRAPH_HOOKS=off`: no hooks (the MCP server and skills stay).
- `FG_RUN`, `FG_SANDBOX=1`, `FG_RUN_KEY`: label this session's requests as a test run (see [docs/demo-probe.md](../docs/demo-probe.md)).

## Boundaries

- Hooks act only in project folders you selected in the Feedback Graph's Settings (`GET /api/agent/project`), and say nothing anywhere else. The one exception is the session hook with `FG_RUN` set: it registers the run, and warns when that fails, in any folder.
- They only read (the session hook's run registration aside): no hook confirms, approves or reports anything. Those decisions stay yours, in the Feedback Graph UI.
- If the Feedback Graph is down or slow, each hook gives up within its timeout and says nothing; it never blocks your work. The stop hook blocks at most once per stop.
- Needs `node` on your PATH (any current LTS).

Use the plugin **or** `scripts/install-agent.sh claude`, not both: both register the same MCP tools. With the plugin installed, `install-agent.sh` registers no second server for the default install; it writes that install's URL and `API_TOKEN` into `env` in `~/.claude/settings.json` as `FEEDBACK_GRAPH_URL` and `FEEDBACK_GRAPH_TOKEN` (restart Claude Code). A second install still gets its own server, `feedback-graph-<name>`, beside the plugin's. Switching from `install-agent.sh`: `claude mcp remove feedback-graph --scope user` and `rm ~/.claude/skills/{feedback-graph,postmortem,test-from-feedback}`, then install the plugin. Codex has no plugin; use `install-agent.sh codex`.
