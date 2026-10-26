---
name: feedback-graph
description: Use at the start of any non-trivial coding task in a project tracked by Feedback Graph, before changing a file you do not know well, and again before telling the developer a task is done. Pulls lessons learned from the developer's past feedback (what earlier agents missed and why) and the project's code map from the local Feedback Graph via MCP, and checks finished work against them.
---

# Feedback Graph

The developer runs a local Feedback Graph that learns from every time they pushed back on an agent's work: what was missed, why, and what context would have prevented it. It also keeps a map of each project's code (files, symbols, imports, tests, churn) tied to those misses. Approved lessons and the map are served through the `feedback-graph` MCP server.

## Before you start work

Call `get_task_context` with your current working directory (`cwd`), a one or two sentence description of the task, and, when you know them, the `files` you expect to read or change. Lessons tied to those files come first, and a short code map shows who imports each file, which tests cover it and its last miss. For a quick check mid-task, pass `brief: true`: lessons, misses on those files, their importers and tests, and PR discussions, in about 1,500 characters. Pass `session_id` when you know it, so facts from your own change this session are labelled as such. Facts come from the code scan and from documents and images the developer uploaded (labelled by document), ranked by how often everyday coding needs them. A "From linked projects" section brings the best lessons, misses and facts of projects the developer linked to this one (an app and its backend, say): use them for how the two fit together.

- Treat **approved lessons** as project rules for this task. They come from real corrections.
- Read **similar past misses** as "this is what went wrong last time". Avoid repeating them.
- **Recent sessions** say what earlier sessions in this project did and left open. When you are picking up or continuing earlier work, call `get_recent_sessions` with `cwd` for their full summaries. They are summaries a model wrote: check anything that matters against the code.
- If the tool says the directory is not a tracked project, carry on normally.

## When the developer pastes a prompt from Ask

A prompt copied from the Feedback Graph's Ask page ends with its sources and a "Feedback Graph MCP" section. Treat the
sources as where to look, not as proven: read the files it names before relying on them, and follow the MCP steps it
lists (they are the same as the steps below).

## Before you change a file

- A file you do not know well: call `get_module_context` with `cwd` and its `path`. It says what the file is, its exported symbols, who imports it, what it imports, the tests that cover it, and the lessons and past misses tied to it.
- A file other code depends on (an exported function, a shared module, a type): call `impact` with `cwd` and the `paths` you will change. It lists every file that depends on them, the tests to run, and lessons and misses on all of them. Check those dependents and run those tests.

## When you write tests or do QA

Use the test-from-feedback skill: it turns the lessons and past misses for the code you touched into test cases.

## Before you say "done"

Call `check_before_done` with `cwd`, the task, a summary of what you built **and how you verified it**, `files_changed`: the files you changed, and `diff`: your change as `git diff <commit you started from>` (staged, unstaged and committed in one; `git add -N` new files first). Without a start commit, pass `git diff HEAD` plus the commits you made. Pass it whole: over about 30 KB the judge reads the files most related to the lessons first, then `files_changed` in order, and the answer names the files it did not read. With no `diff`, the server reads the diff of `files_changed` from the repo itself.

- The judge reads the diff, not just your summary: each gap cites the diff lines it rests on. A lesson listed under **Cannot tell from the diff** applies but the diff did not show it either way: check it yourself; it is not a pass. If the answer says the diff was cut, check the files it names as not shown.
- If it lists gaps, address each one, or tell the developer plainly why it does not apply.
- For each changed file it names importers and tests you did not touch: make sure the importers still work and run those tests. If a past miss there applies, make sure it did not happen again.
- Do not claim the work is finished while a listed gap is unaddressed and unexplained.

## When the developer says you missed something

If the developer pushes back ("not good enough", "you missed X", "this is still broken"), fix the work first. You do not need to report it: Feedback Graph reads this session's transcript and flags pushback the developer typed on its own.

Call `report_feedback` only when:

- the developer runs `/postmortem` (see the postmortem skill), or
- a miss was not stated in words, so the transcript will not show it: for example the developer fixed or reverted your change themselves, or you found out on your own that earlier work in this session was wrong.

Pass `cwd`, the feedback in the developer's words (or a plain description of the miss), a short note of what you had built, and `session_id` when you know your session id. A report that matches pushback already flagged from the transcript is merged into the same Inbox item, so one miss is never reviewed twice.

Skip `report_feedback` for ordinary new requests, and for questions that don't judge the previous work.

## Running headless

`claude -p` never shows a permission prompt: a tool that is not allowed is denied, and the Stop hook then says the check did not run. Allow the Feedback Graph tools and the git commands the check asks for:

```sh
claude -p "..." \
  --allowedTools "mcp__plugin_feedback-graph_fg" "Bash(git diff *)" "Bash(git add -N *)"
```

- The plugin's MCP server is named `fg`, so its tools are `mcp__plugin_feedback-graph_fg__<tool>` (for example `mcp__plugin_feedback-graph_fg__check_before_done`); the bare server name `mcp__plugin_feedback-graph_fg` allows all of them. Installed with `scripts/install-agent.sh claude` instead of the plugin, the server is `feedback-graph`: allow `mcp__feedback-graph`.
- The tools are read-only except `report_feedback`, which only queues an Inbox item for the developer. To allow less, list them one by one: `get_task_context`, `check_before_done`, `get_module_context`, `impact`, `search_graph`, `get_recent_sessions`, `report_feedback`.
- The hooks need no permission (they are not tool calls), but they need `node` on the PATH, `FEEDBACK_GRAPH_URL` (default `http://localhost:8787`) and, when the API has a token, `FEEDBACK_GRAPH_TOKEN` in the environment; the MCP server reads the same two. They also read `git rev-parse HEAD` once per session to know where the session started. `--bare` skips plugin hooks, so nothing asks for the check: call `check_before_done` yourself.
- A plugin that is not installed can be loaded for one run with `--plugin-dir <path to this plugin folder>`.

## If the MCP server is unavailable

Continue normally and mention once that the Feedback Graph was unreachable (the developer can start it with `docker compose up -d` in the Feedback Graph folder).
