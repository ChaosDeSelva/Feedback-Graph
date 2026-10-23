# M1: Ingest + Detect + Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose up` ingests every Claude Code session in your project folder into Neo4j, flags likely pushback with a keyword prefilter plus local Ollama, and shows the flagged turns in a web inbox where the owner confirms or rejects them.

**Architecture:** A pnpm TypeScript monorepo with four packages:
- `core`: types and the Neo4j repository.
- `worker`: a polling ingest + detect loop.
- `api`: Hono REST, which also serves the built UI.
- `ui`: React + Vite + Tailwind.

The worker re-parses any transcript whose size or mtime changed and upserts it idempotently by record uuid. Ollama runs on the host. Neo4j, the worker and the api run in Docker.

**Tech Stack:** Node 26 (built-in `node:sqlite`), pnpm 11, TypeScript 5, vitest, zod, neo4j-driver 5, Hono 4, React 18 + Vite 6 + Tailwind 4, Neo4j 5 community image, Ollama (`gemma4`).

**Spec:** `docs/superpowers/specs/2026-10-22-feedback-graph-design.md` (milestone 1).

## Global Constraints

- Everything is local. The only network calls are to Ollama at `OLLAMA_URL` (default `http://host.docker.internal:11434`). No Claude calls in M1.
- Transcript and repo mounts are **read-only**. The worker never writes outside its SQLite volume and Neo4j.
- Nothing becomes `Feedback` without the owner's explicit confirm in the UI.
- Env vars: `NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`, `TRANSCRIPTS_DIR` (container path of `~/.claude/projects`), `PROJECT_ROOTS` (comma-separated container paths, default `/vibe`), `HOST_PROJECT_ROOTS` (matching host paths, default `/Users/you/code`, needed because transcripts record host `cwd`), `OLLAMA_URL`, `OLLAMA_MODEL` (default `gemma4`), `STATE_DB` (default `/state/worker.sqlite`), `POLL_SECONDS` (default `30`).
- Git: commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Transcript noise counted as human feedback:** skill bodies, `<bash-input>`/`<bash-stdout>`, `<local-command-caveat>`, `<command-name>`, `<task-notification>`, `isMeta`, `isSidechain`, `isCompactSummary` and tool_result-only records must never become human turns. Tested in Task 3.
2. **Malformed or half-written JSONL lines** (a file being appended mid-read) must be skipped, not crash the cycle. Tested in Task 3.
3. **Sessions whose `cwd` is outside every project root** (`/private/tmp`, scratchpads, `~/Codex`) must be skipped silently. Tested in Task 4.
4. **Ollama down or returning junk** must leave the turn unclassified so the next cycle retries, without blocking ingest of other files. Tested in Task 6.
5. **Re-ingesting a changed file** must not duplicate turns or candidates, and must not reset a decided candidate. Tested in Tasks 5 and 7.

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore` (`node_modules`, `dist`, `.env`, `state/`), `.env.example`, `vitest.workspace.ts`
- Create: `packages/{core,worker,api,ui}/package.json` + `tsconfig.json`
- Test: `packages/core/src/smoke.test.ts`

- [ ] **Step 1:** `git init -b main` in `~/code/feedback_tool`.
- [ ] **Step 2:** Write the workspace files. Root scripts: `test` = `vitest run`, `test:int` = `vitest run --project integration`, `build` = `pnpm -r build`. Use ESM (`"type": "module"`) everywhere, `moduleResolution: "bundler"`, `strict: true`.
- [ ] **Step 3:** Write the smoke test `expect(1 + 1).toBe(2)` and run `pnpm install && pnpm test`. Expected: 1 passed.
- [ ] **Step 4:** Commit `chore: scaffold pnpm monorepo` (include `docs/`).

### Task 2: Core types

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/index.ts`

**Interfaces (Produces):**
```ts
export type ToolCall = { name: string; ts: string; filePath?: string; command?: string };
export type HumanTurn = {
  uuid: string; sessionId: string; ts: string; index: number; text: string;
  precedingAssistantText: string;   // last assistant text before this turn, trimmed to 2,000 chars
  precedingToolCalls: ToolCall[];   // tool calls since the previous human turn
};
export type ParsedSession = {
  sessionId: string; sourceFile: string; cwd: string; gitBranch: string | null;
  startedAt: string; endedAt: string; turns: HumanTurn[]; toolCalls: ToolCall[];
};
export type Project = { key: string; name: string; repoPath: string };   // key = top-level dir name under a root
export type Commit = { sha: string; ts: string; subject: string };
export type TurnLabel = 'pushback' | 'correction' | 'approval' | 'neutral';
export type Classification = { label: TurnLabel; confidence: number; summary: string; signals: string[] };
export type CandidateStatus = 'pending' | 'confirmed' | 'rejected';
export type Candidate = {
  id: string; turnUuid: string; sessionId: string; projectKey: string;
  classification: Classification; status: CandidateStatus;
  createdAt: string; decidedAt: string | null; note: string | null;
};
```
Types only, so there is no test step. Commit `feat(core): domain types`.

### Task 3: Transcript parser

**Files:**
- Create: `packages/worker/src/ingest/parseTranscript.ts`
- Create: `fixtures/transcripts/basic.jsonl`, `fixtures/transcripts/noise.jsonl`. Hand-write them in the real record shapes (`type`, `uuid`, `sessionId`, `cwd`, `gitBranch`, `timestamp`, `isMeta`, `isSidechain`, `message.content` as a string or an array of `text` / `tool_use` / `tool_result` / `thinking` parts). No real transcript content.
- Test: `packages/worker/src/ingest/parseTranscript.test.ts`

**Interfaces (Produces):** `parseTranscript(text: string, sourceFile: string): ParsedSession[]` (one entry per `sessionId` in the file).

- [ ] **Step 1: Write failing tests:**
  - `basic`: 2 human turns. `turns[1].precedingToolCalls` equals `[{name:'Edit', filePath:'/x/a.ts',…}, {name:'Bash', command:'pnpm test',…}]`, and `turns[1].precedingAssistantText` is the last assistant `text` part.
  - `noise`: records with `isMeta:true`, `isSidechain:true`, `isCompactSummary:true`, tool_result-only content, and strings starting with `<bash-input>`, `<bash-stdout>`, `<local-command-caveat>`, `<command-name>`, `<task-notification>` give **0** turns.
  - `<system-reminder>…</system-reminder>` blocks are stripped from turn text. A turn that is empty after stripping is dropped.
  - A truncated final line and a non-JSON line are skipped, and the other turns still parse.
  - Tool-call mapping: `Edit|Write|MultiEdit|NotebookEdit|Read` → `filePath = input.file_path ?? input.notebook_path`, and `Bash` → `command = input.command`.
- [ ] **Step 2:** Run `pnpm vitest run parseTranscript`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement. Do a single pass over the lines in file order, keeping per-session state `{lastAssistantText, pendingToolCalls}`. `startedAt`/`endedAt` are the min/max `timestamp` of any record. `cwd`/`gitBranch` come from the first record that has them.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(worker): transcript parser`.

### Task 4: Project mapping + git commits

**Files:**
- Create: `packages/worker/src/ingest/projects.ts`, `packages/worker/src/ingest/git.ts`
- Test: `projects.test.ts`, `git.test.ts` (same dir)

**Interfaces (Produces):**
- `projectFromCwd(cwd: string, roots: {host: string; container: string}[]): Project | null`
- `commitsInWindow(repoPath: string, from: string, to: string): Promise<Commit[]>`

- [ ] **Step 1: Write failing tests:**
  - `/Users/you/code/GameX_1.2.0/source` → `{key:'GameX_1.2.0', repoPath:'/vibe/GameX_1.2.0'}`.
  - The root itself (`/Users/you/code`) → `null`.
  - `/private/tmp/x` → `null`.
  - git: in a temp repo created in the test with 2 commits at fixed `GIT_COMMITTER_DATE`s, a window that covers only the second commit returns exactly that commit. A non-repo path returns `[]` (does not throw).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Run git with `execFile('git', ['-C', repoPath, 'log', '--since', from, '--until', to, '--format=%H%x09%cI%x09%s'])` and return `[]` on a non-zero exit.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(worker): project mapping and git window`.

### Task 5: Neo4j repository

**Files:**
- Create: `packages/core/src/graph/{driver.ts,schema.ts,repo.ts}`
- Create: `docker-compose.test.yml` (`neo4j:5-community` on port 7688, auth `neo4j/testpassword`)
- Test: `packages/core/src/graph/repo.int.test.ts` (vitest project `integration`)

**Interfaces (Produces):** `class GraphRepo` with:
- `static connect(url, user, pw): Promise<GraphRepo>`
- `ensureSchema()`: uniqueness constraints on `Project.key`, `Session.id`, `Turn.uuid`, `Commit.sha`, `Candidate.id`
- `upsertSession(project: Project, s: ParsedSession, commits: Commit[]): Promise<void>`. MERGE semantics. Writes `(:Project)<-[:IN]-(:Session)-[:HAS_TURN]->(:Turn)`, `(:Session)-[:DURING]->(:Commit)`, and `Turn.toolCalls` as a JSON string. It never overwrites `Turn.label`.
- `unclassifiedTurns(limit: number): Promise<HumanTurn & {projectKey: string}[]>`: turns with no `label` and `index > 0`.
- `saveClassification(turnUuid: string, c: Classification, makeCandidate: boolean): Promise<void>`. Sets the label. If `makeCandidate`, it MERGEs `(:Candidate {id: turnUuid})-[:FLAGS]->(:Turn)` with `status:'pending'` set **only on create**.
- `listCandidates(f: {status?: CandidateStatus; projectKey?: string; limit?: number}): Promise<Candidate[]>`, newest first.
- `candidateDetail(id: string): Promise<{candidate: Candidate; turn: HumanTurn; before: HumanTurn[]; after: HumanTurn[]; commits: Commit[]} | null>`. `before`/`after` are up to 2 turns on each side.
- `decide(id: string, status: 'confirmed' | 'rejected', note: string | null): Promise<void>`. On `confirmed`, it also MERGEs `(:Feedback {id, status:'open', createdAt})-[:FROM_TURN]->(:Turn)`.
- `stats(): Promise<{projectKey: string; week: string; humanTurns: number; pushback: number}[]>`

- [ ] **Step 1: Write failing integration tests:**
  - upserting the same session twice → the turn count is unchanged.
  - after `saveClassification(..., true)` and then `decide(id, 'rejected', null)`, a second `saveClassification(..., true)` leaves the status `rejected`.
  - `decide('confirmed')` creates exactly one `Feedback`.
  - `listCandidates({status:'pending'})` excludes decided ones.
  - `candidateDetail` returns the neighbour turns in order.
- [ ] **Step 2:** Run `docker compose -f docker-compose.test.yml up -d && pnpm test:int`. Expected: FAIL.
- [ ] **Step 3:** Implement with parameterised Cypher only (no string interpolation of values).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): neo4j graph repo`.

### Task 6: Detection (prefilter + Ollama)

**Files:**
- Create: `packages/worker/src/detect/prefilter.ts`, `packages/worker/src/detect/ollama.ts`, `packages/worker/src/detect/classify.ts`
- Test: `prefilter.test.ts`, `classify.test.ts`

**Interfaces (Produces):**
- `prefilterPushback(text: string): { hit: boolean; signals: string[] }`
- `ollamaChatJson<T>(opts: {url: string; model: string; system: string; user: string; schema: object; fetchImpl?: typeof fetch}): Promise<T>`. POSTs `/api/chat` with `stream:false` and `format: schema`, and throws on non-2xx or unparsable content.
- `classifyTurn(turn: HumanTurn, deps: {chat: typeof ollamaChatJson; url: string; model: string}): Promise<Classification | null>`. Returns `null` on any error.

- [ ] **Step 1: Write failing tests:**
  - prefilter hits: "this isn't good enough", "you missed the server-side filtering", "no, that's wrong", "why did you remove X", "still broken", "that's not what I asked".
  - prefilter misses: "how do I play this?", "looks great, ship it", "can you add a settings screen".
  - classify: a fake `chat` returning `{label:'pushback', confidence:0.9, summary:'…'}` → passes through, with `signals` from the prefilter. A fake that throws → `null`. A fake returning `label:'banana'` → `null` (zod validation).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3 (the owner writes this one):** `prefilterPushback`. This is where your sense of what counts as pushback shapes the tool: too broad floods the inbox, too narrow misses real misses (the manual `/postmortem` in M2 covers those). Implement it as a list of case-insensitive regexes, returning the matched source strings as `signals`.
- [ ] **Step 4:** Implement `ollamaChatJson` and `classifyTurn`. The system prompt gives the 4 labels with one-line definitions. The user content is the `precedingAssistantText` (≤2,000 chars), a summary of `precedingToolCalls` (names + paths), then the turn text.
- [ ] **Step 5:** Run. Expected: PASS.
- [ ] **Step 6:** Commit `feat(worker): pushback detection`.

### Task 7: Worker cycle

**Files:**
- Create: `packages/worker/src/state.ts` (`node:sqlite`), `packages/worker/src/cycle.ts`, `packages/worker/src/main.ts`
- Test: `state.test.ts`, `cycle.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - `FileState` with `changed(path, size, mtimeMs): boolean` and `mark(path, size, mtimeMs): void`
  - `runCycle(deps: {listFiles(): Promise<{path: string; size: number; mtimeMs: number}[]>; readFile(p: string): Promise<string>; state: FileState; repo: Pick<GraphRepo,'upsertSession'|'unclassifiedTurns'|'saveClassification'>; roots; commits: typeof commitsInWindow; classify: (t: HumanTurn) => Promise<Classification | null>; classifyBatch: number}): Promise<{filesIngested: number; turnsClassified: number; candidates: number}>`

Cycle rules:
- Ingest every changed `*.jsonl` (sessions whose project is `null` are skipped), then `mark` it.
- Classify up to `classifyBatch` (default 50) unclassified turns:
  - prefilter miss → save `{label:'neutral', confidence:0, signals:[]}` with no Ollama call.
  - prefilter hit → `classify`; `null` → leave unclassified (retry next cycle); otherwise save, with `makeCandidate = label ∈ {pushback, correction}`.
- An exception for one file is logged and does not stop the others.
- `main.ts` loops `runCycle` every `POLL_SECONDS` and logs the counts as one JSON line.

- [ ] **Step 1: Write failing tests** with in-memory fakes:
  - an unchanged file on the second cycle is not re-read.
  - a prefilter miss makes 0 classify calls.
  - classify returning `null` leaves the turn for the next cycle.
  - a `readFile` that throws for one of two files still ingests the other.
  - state survives reopening the same SQLite path.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(worker): ingest/detect cycle`.

### Task 8: API

**Files:**
- Create: `packages/api/src/app.ts`, `packages/api/src/main.ts`
- Test: `packages/api/src/app.test.ts`

**Interfaces (Produces):** `createApp(repo: Pick<GraphRepo,'listCandidates'|'candidateDetail'|'decide'|'stats'>, staticDir?: string): Hono`
- `GET /api/candidates?status=&project=&limit=` → `Candidate[]`
- `GET /api/candidates/:id` → detail, or 404
- `POST /api/candidates/:id/decision` with body `{status:'confirmed'|'rejected', note?: string}` (zod) → 204, or 400 on a bad body
- `GET /api/stats` → `stats()` rows (M1 baseline: weekly pushback rate per project. True "repeat" detection needs M2 embeddings)
- `GET /api/health` → `{ok:true}`
- Anything else serves `staticDir` with an `index.html` fallback.

- [ ] **Step 1: Write failing tests** with a fake repo, using `app.request(...)`: a status filter is passed through; an unknown id → 404; a bad decision body → 400; a valid decision → 204 and the fake recorded the call.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (`@hono/node-server`, `serveStatic`).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): candidates and stats endpoints`.

### Task 9: Inbox UI

**Files:**
- Create: `packages/ui/{index.html,vite.config.ts,src/main.tsx,src/api.ts,src/Inbox.tsx,src/CandidateDetail.tsx,src/styles.css}`
- Test: `packages/ui/src/Inbox.test.tsx` (vitest + @testing-library/react + jsdom)

**Behaviour:**
- Two panes: the left is the pending list (project, time, summary, confidence, signals) with a project filter and a status tab (pending/confirmed/rejected); the right is the detail.
- The detail shows the preceding assistant text, the tool calls (files edited, commands), the flagged turn (highlighted), 2 turns after, and commits in the session window.
- **Confirm** / **Reject** buttons take an optional note. Keyboard: `j`/`k` move, `c` confirms, `r` rejects. After a decision, the next item is selected.
- The header shows the pending count. Dev proxy `/api` → `http://localhost:8787`.

- [ ] **Step 1: Write failing tests** with mocked `fetch`: it renders 2 pending candidates; clicking Confirm POSTs `{status:'confirmed'}` to the right id and selects the next item; pressing `r` POSTs `rejected`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ui): review inbox`.

### Task 10: Docker compose + backfill verification

**Files:**
- Create: `Dockerfile` (multi-stage: pnpm build → `node:26-slim` runtime with `git` installed; targets `worker` and `api`, and the api image includes `packages/ui/dist`), `docker-compose.yml`, `README.md` (run instructions only)

**Compose:**
- `neo4j:5-community`: named volume, `7474`/`7687` on 127.0.0.1 only.
- `worker`:
  - mounts `~/.claude/projects:/transcripts:ro`, `~/code:/vibe:ro`, `./state:/state`
  - `extra_hosts: host.docker.internal:host-gateway`
  - git `safe.directory='*'`, which is needed for the read-only bind mount
- `api`: port `127.0.0.1:8787:8787`.
- All read `.env`.

- [ ] **Step 1:** `docker compose up -d --build`. Expected: all 3 healthy; `curl -s localhost:8787/api/health` → `{"ok":true}`.
- [ ] **Step 2:** Watch the worker logs until `filesIngested` is 0 for two cycles (the backfill is done). Record the totals.
- [ ] **Step 3:** `curl -s 'localhost:8787/api/candidates?status=pending&limit=500' | jq length` is > 0. Open `http://localhost:8787` and confirm the inbox renders real candidates with their context.
- [ ] **Step 4 (precision check, with the owner):** The owner decides 30 candidates in the UI. Precision = confirmed / 30. Target ≥ 0.7; if it's below, tune the prefilter (Task 6, Step 3) and the classifier prompt, then repeat.
- [ ] **Step 5:** Record the backfill totals, precision and the `/api/stats` baseline in `docs/superpowers/plans/m1-results.md`. Commit `chore: compose stack and M1 results`, then `git push -u origin main`.
