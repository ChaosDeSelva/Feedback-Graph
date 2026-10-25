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
| MCP server `fg` (tools appear as `mcp__plugin_feedback-graph_fg__<tool>`) | always | `get_task_context`, `get_module_context`, `impact`, `check_before_done`, `search_graph`, `get_recent_sessions`, `report_feedback` |
| Hook: prompt | each request of 20+ characters (not `/commands`, `!` shell, or a question that asks for no change) | the task's approved lessons and the past misses on the files the request names (about 1,500 characters; the rest is one `get_task_context` call away), added as context. Once per session, then only when a lesson not yet shown applies |
| Hook: edit | before the first `Edit`/`Write`/`MultiEdit`/`NotebookEdit` of a file in the session | the file's lessons and past misses, when it has any |
| Hook: stop | when Claude is about to finish | once: if it changed files (or committed) and has not called `check_before_done` since, it is asked to, with the files it edited, and to address or explain each gap |
| Hook: session | after `/clear` or a compaction | forgets what was shown, so it is shown again |
| Skill `feedback-graph` | non-trivial tasks | when to call each tool |
| Skill `postmortem` | `/postmortem what it missed` | records a miss for the Inbox |
| Skill `test-from-feedback` | writing tests, QA | one test case per lesson and past miss on the code you touched, run, and reported with the lesson it guards |

## Settings (environment)

- `FEEDBACK_GRAPH_URL`: default `http://localhost:8787`.
- `FEEDBACK_GRAPH_TOKEN`: the Feedback Graph's `API_TOKEN`, when it has one.
- `FEEDBACK_GRAPH_HOOKS=off`: no hooks (the MCP server and skills stay).

## Boundaries

- Hooks act only in project folders you selected in the Feedback Graph's Settings (`GET /api/agent/project`), and say nothing anywhere else.
- They only read: no hook confirms, approves or reports anything. Those decisions stay yours, in the Feedback Graph UI.
- If the Feedback Graph is down or slow, each hook gives up within its timeout and says nothing; it never blocks your work. The stop hook blocks at most once per stop.
- Needs `node` on your PATH (any current LTS).

Use the plugin **or** `scripts/install-agent.sh claude`, not both: both register the same MCP tools (with the plugin installed, `install-agent.sh` skips Claude Code). Switching from `install-agent.sh`: `claude mcp remove feedback-graph --scope user` and `rm ~/.claude/skills/{feedback-graph,postmortem,test-from-feedback}`, then install the plugin. Codex has no plugin; use `install-agent.sh codex`.
