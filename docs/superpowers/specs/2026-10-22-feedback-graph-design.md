# Feedback Graph: design + build plan

Working name `feedback_tool` (dir `~/code/feedback_tool`, currently empty, not a git repo).

## Context

When the owner pushes back on Claude's work ("not good enough", "you missed X"), the lesson lives only in that one session. The next session (same or another project) can repeat the miss, and Claude often says "done" when it isn't.

This tool is a **local visibility and support tool**. It does a post-mortem on every miss: what was asked, what Claude did, what context it had, why it missed, and what context would have prevented it. It then actively hunts for that context and stores the whole evidence chain in a knowledge graph. Coding agents query that graph (MCP + a skill) so they start tasks with better context and check their work against past misses before claiming done. A UI makes all of it visible.

It does not train or change models. It is evidence-grounded project memory.

**Success, ranked (the owner's call):**
1. Fewer repeat corrections: the same kind of feedback stops recurring.
2. Better "done" claims: a pre-done check catches the gaps.
3. Seeing the why: browse blind spots and patterns across projects.

**Anti-goals:** lessons reaching the graph without the owner's confirmation; overgeneralising a scoped fix into a global rule; bloating CLAUDE.md; anything leaving the machine except calls to Claude (subscription) and the GitHub/Linear APIs.

## Grounding (verified on this machine)

- `~/.claude/projects/` has **222 project dirs and 3,213 session transcripts** (JSONL). Each record carries `cwd`, `gitBranch`, `sessionId` and `timestamp`, plus `user` / `assistant` / tool_use / tool_result content. This is the primary source, and months of history give a backfill on day one.
- **220 existing `memory/*.md` files**, many `type: feedback`. These are hand-curated lessons, used as seed data and as a format the agents already read.
- `docker`, `ollama` (with `gemma4:latest` already pulled) and the `claude` CLI are installed.
- Project repos are under `~/code/*`, so git history can be correlated by `cwd` plus the session time window.

## Decisions

**Owner's calls:**
- Runs locally in Docker: graph DB, API and UI from one `docker compose up`.
- Neo4j is the knowledge graph.
- Heavy reasoning uses his **Claude subscription**, not a paid API key.
- A free local model classifies facts cheaply.
- Detection: **auto-detect pushback, the owner confirms** in the UI before anything enters the graph, plus a manual `/postmortem` command for misses it didn't catch.
- Integrations: GitHub PRs, Linear tickets, uploaded docs, local sessions.
- Delivery to agents: an MCP server plus a skill that knows when to call it.
- The UI covers all four areas: review inbox, graph explorer, context uploads and integrations, patterns dashboard.

**My calls (flag any you disagree with):**
- **TypeScript monorepo** (pnpm workspaces): `api` (Hono + neo4j-driver + zod), `worker` (same codebase, separate process), `ui` (React + Vite + Tailwind), `mcp` (MCP SDK, exposed over HTTP from the api container).
- **Ollama runs on the host, not in Docker.** Docker on macOS can't use the Metal GPU, so containers reach `host.docker.internal:11434`. Model: `gemma4` for classification, `nomic-embed-text` for embeddings. ("jev" in your message read to me as this local-model slot. Tell me if you meant a specific tool.)
- **Claude via headless CLI:** the worker image installs `@anthropic-ai/claude-code` and authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, so it bills your subscription). Calls are `claude -p --output-format json` with a zod-validated JSON contract in the prompt, read-only tools only (`--allowedTools Read,Grep,Glob`), and cwd set to the mounted repo.
- **Storage:** Neo4j 5 holds both the graph and the vectors (its native vector index), so there's no second vector DB. A SQLite file in a volume holds ingest cursors and the job queue. Raw transcripts stay where they are (mounted read-only) and act as the immutable evidence, referenced by `sessionId` and line number.
- **Mounts (read-only):** `~/.claude/projects`, `~/code`, `~/.claude/projects/*/memory`.
- Approved lessons are **not** written into CLAUDE.md automatically. An optional "export as memory file" button in the UI comes later.

## Architecture

```
~/.claude/projects (JSONL) ─┐
~/code/* git history ───────┤
GitHub PRs / Linear ────────┼─► worker: ingest → detect → post-mortem → context hunt
uploaded docs ──────────────┘          (Ollama: classify/embed)  (claude -p: reason)
                                                 │
                                              Neo4j  ◄──► api ──► ui (inbox, graph, uploads, patterns)
                                                             └──► MCP ──► Claude Code / Codex + skill
```

### Graph model

Nodes: `Project`, `Session`, `Task` (a feature or request), `Feedback`, `Change` (commit or file edit), `Miss` (the post-mortem), `Cause`, `Lesson`, `ContextItem` (code ref, doc, PR, ticket, session excerpt, memory file), `Outcome`.

Edges: `Session-WORKED_ON->Task`, `Feedback-CRITICIZES->Task`, `Change-ADDRESSES->Feedback`, `Outcome-RESOLVES->Feedback`, `Miss-EXPLAINS->Feedback`, `Miss-CAUSED_BY->Cause`, `ContextItem-WOULD_HAVE_PREVENTED->Miss`, `ContextItem-WAS_AVAILABLE_IN->Session` (it existed but was ignored), `Lesson-DERIVED_FROM->Miss`, `Lesson-APPLIES_TO->Project|Task-kind|path-glob`, `Lesson-SUPERSEDES->Lesson`.

All nodes carry `validFrom` / `validTo` timestamps so history is kept and nothing is silently deleted.

- Feedback status: `open → addressed → verified → approved`, plus `rejected | reopened | superseded | unknown`.
- Lesson status: `proposed → approved` (only the owner approves) `→ superseded`.
- Feedback status and task approval are tracked separately.

### Pipeline (worker)

1. **Ingest.** Tail the JSONL files incrementally (cursor per file). Build `Session`s and turns. Extract tool calls (files read and edited, commands run), map `cwd` to a `Project`, and correlate git commits in `~/code/<project>` within the session window.
2. **Detect** (Ollama). Run a cheap keyword prefilter, then classify each user turn that follows assistant work as `pushback | correction | approval | neutral`. Pushback becomes an **inbox candidate**. Approvals and later turns feed the resolution state.
3. **Post-mortem** (Claude, after the owner confirms the candidate). Input: the feedback, the work before it (diffs and tool calls), the context Claude had loaded (CLAUDE.md, memory, files read), the fix turns and the outcome. Output (JSON):
   - what was missed
   - cause: `context_missing | context_available_ignored | requirement_unstated | verification_gap | implementation_error`
   - scope
   - a proposed lesson
   - **context-gap queries**
4. **Context hunt.** Run those queries against the repo (`claude -p` with read-only tools), other sessions (vector search), GitHub PRs (`gh` / REST), Linear (GraphQL API key) and uploaded docs. Attach the hits as `ContextItem`s with `WOULD_HAVE_PREVENTED` edges.
5. **Review.** In the inbox, the owner approves, edits (scope or wording) or rejects the post-mortem and its lesson. Only approved lessons are served to agents.
6. **Patterns** (nightly). Cluster `Miss` embeddings and surface recurring causes across tasks and projects (for example, "missing auth checks ×5").

### MCP tools and skill

- `get_task_context(project, task)`: approved lessons, plus relevant past misses and context items for this kind of task, with citations.
- `check_before_done(project, task, summary, diff?)`: checks the work against past misses for similar tasks and returns a gap list with citations.
- `report_feedback(text)`: the manual `/postmortem` path. It queues a candidate.
- `search_graph(query)`.

A skill (`~/.claude/skills/feedback-graph/SKILL.md`) tells agents to call `get_task_context` before non-trivial work and `check_before_done` before claiming completion. It also ships the `/postmortem` command.

### UI (priority order, all four in scope)

1. **Inbox:** candidate misses showing feedback, surrounding turns, the post-mortem and found context. Approve, edit or reject.
2. **Graph explorer:** per-project evidence chains (react-force-graph), plus Lesson detail with provenance.
3. **Context:** upload docs, connect GitHub and Linear, choose which projects to ingest.
4. **Patterns dashboard:** recurring causes, repeat-feedback rate over time (success metric #1), and pre-done catch rate (#2).

## Milestones (ordered by the success ranking)

1. **Skeleton + ingest + detect + inbox.** Compose file (neo4j, api, worker, ui). Backfill ~/code sessions. Inbox lists candidates. Baseline: repeat-feedback rate across your history.
2. **Post-mortem + context hunt + lessons + MCP `get_task_context` + skill.** Delivers success #1.
3. **`check_before_done`** plus the skill hook-in. Delivers #2.
4. **Graph explorer, patterns dashboard, uploads, GitHub and Linear.** Delivers #3. Seed lessons from the existing `memory/` feedback files.

At the first build step, set up git.

## Layout

```
feedback_tool/
  docker-compose.yml   .env.example (CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN, LINEAR_API_KEY)
  packages/core/       graph schema, zod contracts, neo4j repo layer
  packages/worker/     ingest/, detect/, postmortem/, hunt/, patterns/
  packages/api/        REST for UI + MCP endpoint
  packages/ui/
  skill/feedback-graph/SKILL.md
  prompts/             postmortem.md, hunt.md, check-before-done.md
  fixtures/            anonymised sample transcripts for tests
```

Decisions for the owner to shape when we build them: the pushback/approval classification heuristics, and the cause taxonomy in `packages/worker/detect` and `postmortem`.

## Verification

- **Unit:** the JSONL parser against fixture transcripts (including tool_use and tool_result pairs), the status state machine, and zod contracts on Claude output.
- **Detection quality:** after the backfill, hand-label about 30 inbox candidates and report precision. Tune the prefilter and prompt until precision is at least 0.7.
- **End to end:** `docker compose up`, then confirm a real past miss from a ~/code project. Check that the post-mortem and context items appear in the graph explorer. Approve the lesson. In a fresh Claude Code session in that project, confirm `get_task_context` returns it with a citation, and that `check_before_done` flags the same gap on a deliberately repeated mistake.
- **Metric:** the patterns dashboard shows the repeat-feedback baseline from milestone 1, to compare against over the following weeks.

## Addendum (2026-10-22, the owner's requests mid-build)

**Local code scanning.** Any local directory under a configured root can be scanned (no GitHub needed). The scan extracts many small, durable **facts** about the codebase (conventions, invariants, public APIs, gotchas, config, dependencies), each tied to a file/lines, into the graph: `(:Fact)-[:ABOUT]->(:CodeFile)-[:IN]->(:Project)`. It is incremental by file hash; facts from changed files are closed (`validTo`) rather than deleted. Facts feed `get_task_context` and the post-mortem prompt.

**Pluggable model providers per job (BYOK + subscriptions + free local).** Each job (classify, scan, post-mortem, pre-done check) picks a provider by spec string:
`ollama:<model>` (free, host or Docker), `claude-cli[:model]` (Claude subscription), `codex-cli[:model]` (ChatGPT/Codex subscription), `openai:<model>` / `openrouter:<model>` / any OpenAI-compatible base URL (BYOK), `anthropic:<model>` (BYOK).
Agentic providers (claude-cli, codex-cli) explore the repo themselves with read-only tools; API/local providers scan file by file.

**Free Docker option.** Optional compose profile `ollama` runs Ollama in a container (CPU on macOS; GPU on Linux). On macOS the host Ollama is the default.

**Demo project.** `examples/demo-shop` is a small app with a planted convention, used to test scanning, post-mortems and the pre-done check end to end.
