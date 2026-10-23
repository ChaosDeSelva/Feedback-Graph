# @fb/store-postgres

The Postgres + pgvector backend for Feedback Graph. The open-source tool stores everything in Neo4j by default; the
hosted team product runs the same api and worker code on Postgres. Both backends implement the interfaces in
`packages/core/src/store.ts`, and one set of contract suites proves they behave the same.

**Status:** complete. Every repository class is implemented and passes the same contract suites as Neo4j
(`TEST_STORES=neo4j,postgres pnpm test:int`, run by `scripts/check.sh` and CI). The api, the worker and `reembed` open
the configured backend with `openStore(config)` (`src/open.ts`): `STORE=postgres` plus `DATABASE_URL`. The
implementation groups below are kept as the map of which test covers which class.

## Layout

| Path | What | Owner |
| --- | --- | --- |
| `migrations/0001_init.sql` | The whole schema. Header comments give the conventions; each table names the Neo4j label or relationship it holds. | seam (frozen) |
| `migrations/0002_codegraph.sql` | The code map (map columns on `code_files`, `code_symbols`, `code_imports`, `code_tests`, `code_maps`), `session_files`, and the `code_mapped` activity kind. | frozen once run |
| `migrations/0003_read_resets.sql` | `read_resets`: folders whose read marks the worker forgets after a cleanup or project delete. | frozen once run |
| `migrations/0004_turns_requeued.sql` | The `turns_requeued` activity kind. | frozen once run |
| `migrations/0005_agents_md.sql` | The `agents_md` context item kind (AGENTS.md in post-mortems). | frozen once run |
| `migrations/0006_candidate_reports.sql` | `detected`, `detected_turn_uuid` and `agent_report` on candidates: one Inbox item for a detector flag and an agent report of the same miss. | frozen once run |
| `migrations/0007_import.sql` | The `bundle_imported` activity kind (POST /api/import). | frozen once run |
| `migrations/0008_cloud_sync.sql` | The `cloud_synced` activity kind (team sync runs). | frozen once run |
| `src/migrate.ts` | Migration runner: `schema_migrations`, one transaction per file, advisory lock so api and worker can start together. | seam |
| `src/db.ts` | `openDb`, `tx()` (all-or-nothing, Neo4j's `runInTransaction`), `iso()`, `toVector()` / `fromVector()`, `toJson()`, `notImplemented()`. Every query's parameters lose their NUL characters in the pool's client class (`stripNul`). | seam |
| `src/vector.ts` | The four nearest-neighbour queries in the form the HNSW indexes serve, and `runSearch` (iterative scans). | seam |
| `src/store.ts` | `openPostgresStore(config)` / `postgresStore(db)`: a `Store` with `ensureSchema()` (migrations), `ping()`, `close()`. | seam |
| `src/testing/*` | Test harness (creates the database in `TEST_PG_URL`, migrates it) and `PostgresProbe`. | seam |
| `src/graph.ts` ... `src/selection.ts` | One class per repository. | implementation groups |
| `src/open.ts` | `openStore(config)`: Neo4j or Postgres, as `STORE` says. Used by the api, worker and reembed. | integration |

Need a schema change? Add the next numbered `migrations/NNNN_<what>.sql`; never edit `0001_init.sql` once anything has run on it.
Need a change to a seam file? Coordinate: every group depends on them.

## Running the contract suites

```sh
docker compose -f docker-compose.test.yml up -d --wait postgres-test   # pgvector 0.8.7 / Postgres 17 on :5433
TEST_STORES=postgres pnpm test:int                                     # everything, on Postgres
TEST_STORES=neo4j,postgres pnpm test:int                               # both backends, side by side
```

`TEST_PG_URL` (default `postgres://fg:fg@localhost:5433/fg_test`) picks the database. The harness creates it when
missing and runs the migrations, and wipes it before every test, so its name must contain `test`. Give every
parallel run its own name (`fg_test_g1`, `fg_test_g2`, ...).

`TEST_PG_OLD_VECTOR_URL` (unset: skipped) points `pgvector.int.test.ts` at a server with a pgvector older than 0.8
(`pgvector/pgvector:0.7.4-pg17`), to check that startup refuses it.

A contract suite is `describeStores(name, (h) => { ... })` from `@fb/core/testing`: it runs once per backend in
`TEST_STORES`. What no Store method shows (row counts, stored text, seeding an orphan) goes through the test
probe (`h.probe`, interface in `packages/core/src/testing/probe.ts`), never through SQL in a test.

## Implementation groups

Split by class so each group owns its files outright. Groups 1 and 2 can be verified alone; groups 3 and 4 have
tests that also call group 1 (and, for portability, everything), which fail with group 1's `not implemented` until
it merges. Merge order: 1, 2, 3, 4.

| Group | Classes | Files (only these) | Neo4j size | Contract tests |
| --- | --- | --- | --- | --- |
| 1. Pipeline | `PgGraphStore`, `PgKnowledgeStore` | `src/graph.ts`, `src/knowledge.ts` | 718 lines | 43, self-contained |
| 2. Code context | `PgFactsStore`, `PgDocsStore` | `src/facts.ts`, `src/docs.ts` | 351 lines | 19, self-contained |
| 3. Log, selection, views | `PgActivityStore`, `PgSelectionStore`, `PgInsightsStore` | `src/activity.ts`, `src/selection.ts`, `src/insights.ts` | 371 lines | 19; 10 need group 1 |
| 4. Cross-cutting | `PgPortabilityStore`, `PgEmbeddingsStore` | `src/portability.ts`, `src/embeddings.ts` | 237 lines | 8; 5 need groups 1-3 |

Each group tests against its own database:

```sh
# Group 1
TEST_STORES=postgres TEST_PG_URL=postgres://fg:fg@localhost:5433/fg_test_g1 pnpm vitest run --project integration --no-file-parallelism \
  packages/core/src/graph/repo.int.test.ts packages/core/src/graph/knowledge.int.test.ts
# Group 2
TEST_STORES=postgres TEST_PG_URL=postgres://fg:fg@localhost:5433/fg_test_g2 pnpm vitest run --project integration --no-file-parallelism \
  packages/core/src/graph/facts.int.test.ts packages/core/src/graph/docs.int.test.ts
# Group 3
TEST_STORES=postgres TEST_PG_URL=postgres://fg:fg@localhost:5433/fg_test_g3 pnpm vitest run --project integration --no-file-parallelism \
  packages/core/src/graph/activity.int.test.ts packages/core/src/graph/selection.int.test.ts packages/worker/src/selection.int.test.ts packages/core/src/graph/insights.int.test.ts
# Group 4
TEST_STORES=postgres TEST_PG_URL=postgres://fg:fg@localhost:5433/fg_test_g4 pnpm vitest run --project integration --no-file-parallelism \
  packages/core/src/graph/embeddings.int.test.ts packages/core/src/graph/portability.int.test.ts packages/api/src/settings.int.test.ts
```

Done means: the group's tests pass with `TEST_STORES=postgres`, `TEST_STORES=neo4j` stays green, and
`pnpm typecheck` passes.

## Contract tests per class

"Also calls" lists the other classes a test needs; a test with none is verifiable on its own.

### GraphStore (`src/graph.ts`, group 1): `packages/core/src/graph/repo.int.test.ts`

- upserting the same session twice does not duplicate turns
- unclassifiedTurns skips index 0 and labelled turns
- unclassifiedTurns returns newest first and can be limited to some projects
- re-upserting does not clear an existing label
- a decided candidate keeps its status when re-flagged
- confirming creates exactly one open Feedback
- listCandidates filters by project
- candidateDetail returns neighbouring turns in order and session commits
- stats counts human turns and pushback per project and ISO week
- a turn that failed classification 3 times is no longer offered
- rejecting a confirmed candidate rejects its Feedback, and confirming again reopens it
- the worker heartbeat round-trips, and ping reports the graph is up
- retention removes the text of old turns nobody flagged, and keeps whole sessions behind candidates
- candidate detail says where its post-mortem stands (also calls Knowledge.recordPostmortemFailure)
- sessions record their source; candidates from them carry it to the inbox
- a session without a source is a Claude Code session
- unclassifiedTurns with an empty project list returns nothing (nothing selected), not everything
- upsertSession stores the remote, and a later null does not erase it
- a new folder with a known remote resolves to the existing project and is recorded as its alias
- a folder that already is a project, or has no remote, stays itself
- backfill lists projects without a remote and fills one in place

### KnowledgeStore (`src/knowledge.ts`, group 1): `packages/core/src/graph/knowledge.int.test.ts`

Every test also calls Graph.upsertSession, saveClassification and decide (same group); some call listCandidates.

- feedbackNeedingPostmortem returns the full input for confirmed feedback
- feedback you reject after confirming gets no post-mortem
- rejecting after the post-mortem withdraws its proposed lesson but keeps one you approved
- failures are retried up to MAX_POSTMORTEM_ATTEMPTS times then skipped
- savePostmortem writes the evidence chain and a proposed lesson
- fix commits are found by real time, whatever time zone the committer was in
- a lesson cannot supersede itself or a lesson that does not exist
- the task of a pre-done check is stored redacted
- a global lesson has no project
- updateLesson approves, edits, and supersedes
- searchLessons returns approved lessons for the project and global ones, nearest first
- relatedMisses finds similar past misses in the project with their feedback
- createManualFeedback queues a pending candidate; only your confirmation starts a post-mortem
- recordPreDoneCheck stores which lessons were checked and which were gaps
- post-mortem output, memory lessons and manual feedback are redacted before storage
- re-importing a memory file never undoes your decision or your edits
- a global lesson narrowed back to project scope belongs to its own project again
- an approved project lesson is found even when many closer lessons belong elsewhere
- a failed post-mortem waits with growing backoff before it is retried, then gives up
- narrowing a lesson whose project cannot be traced fails closed: it is not served anywhere
- a lesson stored with another embedding size is skipped, not a failed search
- lesson scores are cosine similarity scaled to 0..1: same direction 1, orthogonal 0.5

### FactsStore (`src/facts.ts`, group 2): `packages/core/src/graph/facts.int.test.ts`

- saveFileFacts stores facts and file hashes; rescanning a file closes its old facts
- facts keep their provenance: why, scan job, file hash, and the file summary
- markFilesRemoved closes facts of deleted files
- replaceProjectFacts swaps all current facts from a source (agentic scans)
- a replace that fails part way leaves the old facts and file hashes as they were
- searchFacts returns current facts for the project, nearest first
- scan jobs queue, run and finish; projects summarise
- stored facts and file summaries are redacted, whatever the model returned
- project facts are found even when many closer facts belong to other projects
- asking for a scan while one is queued or running returns that one instead of queueing another
- listProjects shows each project remote and its alias folders
- scores are cosine similarity scaled to 0..1: same direction 1, orthogonal 0.5

### DocsStore (`src/docs.ts`, group 2): `packages/core/src/graph/docs.int.test.ts`

- upsertDoc stores chunks; re-upserting the same ref replaces them
- searchDocs returns nearest chunks of the project with their doc
- deleteDoc removes the doc and its chunks
- sync cursors persist per key
- upsertDoc redacts secrets in the title and every chunk, whoever the caller is
- project doc chunks are found even when many closer chunks belong to other projects
- scores are cosine similarity scaled to 0..1: same direction 1, orthogonal 0.5

### ActivityStore (`src/activity.ts`, group 3): `packages/core/src/graph/activity.int.test.ts`

- records an activity and lists it back with details and targets
- filters by project, kind and target, newest first, with a limit
- defaults: no details, no targets, global project
- record redacts secrets in subject, why and details
- details that look like config survive redaction as valid JSON
- *(Neo4j only, skipped on Postgres)* one unreadable row does not break the log: Neo4j keeps details as JSON text
  that can be corrupt; `details jsonb` cannot be.

### SelectionStore (`src/selection.ts`, group 3)

`packages/core/src/graph/selection.int.test.ts` (all also call Activity.record / list, same group):

- a first start with INGEST_PROJECTS keeps reading exactly those projects, and says so once
- an existing graph without INGEST_PROJECTS starts with nothing selected, and the log says nothing is being read (also calls Graph.upsertSession)
- a new install tracks nothing until you choose
- setting the selection marks it chosen and returns what it was before
- scope combines the selection, EXCLUDE_PROJECTS and the aliases recorded on projects (also calls Graph.upsertSession, canonicalProject)
- the candidate snapshot round-trips
- keysWithData lists projects and anything else filed under a project key (also calls Graph.upsertSession)

`packages/worker/src/selection.int.test.ts` (the worker's ingest cycle; also calls Graph.upsertSession,
unclassifiedTurns, saveClassification, recordClassifyFailure, listCandidates):

- Codex sessions of the selected folder reach the inbox as Codex; others are not read until selected
- with nothing selected the worker reads nothing, but still lists the candidates

### InsightsStore (`src/insights.ts`, group 3): `packages/core/src/graph/insights.int.test.ts`

All also call Graph.upsertSession, saveClassification, decide and Knowledge.savePostmortem (group 1).

- projectGraph returns the evidence chain nodes and links for one project only
- patterns counts misses by cause, across all projects or one
- a miss similar to an earlier miss is a repeat, grouped with it
- weekly series counts feedback and repeats by the week the feedback was given
- pre-done catch rate comes from recorded checks (also calls Knowledge.recordPreDoneCheck)

### EmbeddingsStore (`src/embeddings.ts`, group 4): `packages/core/src/graph/embeddings.int.test.ts`

- a fresh graph records the configured model
- a graph with vectors from before this check is taken to use the old default
- reembed rebuilds every vector from its text with the new model and records it

### PortabilityStore (`src/portability.ts`, group 4)

`packages/core/src/graph/portability.int.test.ts` (seeds through Graph, Knowledge, Facts, Docs and Activity):

- export is a versioned bundle of one project's derived knowledge, without raw transcripts or vectors
- the bundle carries each project's git remote, so clones in differently named folders can be matched
- approvedOnly exports just what you approved, the shape a team sync would send
- deleting a project removes everything learned from it and leaves other projects alone

`packages/api/src/settings.int.test.ts` (Settings over HTTP; also calls Graph.upsertSession and Selection, Activity):

- selection round-trips through the graph, and cleanup deletes only unselected projects

### CodeGraphStore (`src/codegraph.ts`): `packages/core/src/graph/codegraph.int.test.ts`

Built on the shared `codeGraphViews` (core `codegraph.ts`): a backend implements the few reads in `CodeGraphReads`,
so moduleContext, impact, hotspots and lessonsForPaths are computed the same way on both. Also calls Graph,
Knowledge, Facts and Portability.

- replaceCodeMap stores the map and reads it back in the parser's shape, with its fingerprint and size
- a new map replaces the old one: removed files, symbols and edges are gone
- a replace that fails part way leaves the previous map as it was
- symbol names, import names and specifiers are redacted before they are stored
- moduleContext gives a file's symbols, importers, imports, tests, churn and facts
- a mapped file is not a scanned one: the scanner's file hashes are untouched by the map
- sessions record the repo files they read and edited; recording again replaces them
- a miss is linked to the files its session edited, and knows where the fix landed
- approved lessons reach a file through its misses or through their paths; proposed ones do not
- impact lists dependents by depth, the tests to run, and the misses and lessons on what it touches
- hotspots combine churn, misses and dependents, and return the parts
- export carries file paths and hotspot numbers only; deleting the project removes the map and session files

`packages/worker/src/codegraph/stage.int.test.ts`: a real repo is mapped, read back losslessly, and rebuilt
incrementally from what was stored.

### Text with NUL characters: `packages/core/src/graph/nul.int.test.ts`

- sessions, turns, tool calls, facts, docs, lessons and activity with NUL characters are stored

### Postgres only: `src/vector.int.test.ts`

- every search is written so its HNSW index can serve it (EXPLAIN with the alternatives priced out)
- a query vector of another length cannot use the index, and is answered by an exact scan
- with enough rows the planner picks the index on its own
- the index path returns what the exact scan returns, even when the nearest rows belong to other projects

### Seam (already passing)

- `packages/core/src/testing/probe.int.test.ts`: both probes read and seed alike.
- `packages/store-postgres/src/migrate.int.test.ts`: runs only when `TEST_STORES` includes postgres.
- `packages/store-postgres/src/schema.test.ts` (unit): CHECK constraints equal the TypeScript unions.

## Matching the Neo4j behavior

The Neo4j class next to yours (`packages/core/src/graph/<name>.ts`) is the specification, and its Cypher has
side effects that are easy to miss. Use the shared helpers from `@fb/core` instead of re-deriving them:
`postmortemState`, `OUTCOME_STATUS`, `contextItemId`, `postmortemRetryAt`, `MAX_POSTMORTEM_ATTEMPTS`,
`MAX_CLASSIFY_ATTEMPTS`, `docIdOf`, `PROJECT_PATH`, `evidenceNode`, `patternReport`, `REPEAT_WINDOW`,
`REPEAT_SIMILARITY`, `selectionSeededActivity`, `toSelection`, `SELECTION_ID`, `EMPTY_SELECTION`, `projectScope`,
`initialSelection`, `LEGACY_EMBED_MODEL`, `redactDeep`, `redactSecrets`.

- **Redact where Neo4j does, with the same function.** savePostmortem `redactDeep`s the whole post-mortem;
  upsertLesson and createManualFeedback `redactDeep` their input; recordPreDoneCheck `redactSecrets` the task;
  saveFileFacts / replaceProjectFacts `redactDeep` file and facts; upsertDoc `redactSecrets` title, ref and each
  chunk; ActivityStore.record `redactSecrets` subject and why and `redactDeep`s details. The doc id is built from
  the redacted ref.
- **Activity entries.** Repositories do not log activity, with one exception: SelectionStore.ensure logs
  `selectionSeededActivity(seed, existingProjects)` once, only from the call that created the selection row
  (Neo4j uses a `created_by` token; `INSERT ... ON CONFLICT DO NOTHING RETURNING` does the same).
- **MERGE creates projects.** upsertSession, saveFileFacts, replaceProjectFacts, requestScan, upsertDoc,
  createManualFeedback, upsertLesson (non-null projectKey) and updateLesson (narrowing to a known origin) all
  create the `projects` row when missing (`INSERT ... ON CONFLICT DO NOTHING`), which listProjects and
  keysWithData then see. upsertSession overwrites name and repo_path and keeps the old remote when the new one is
  null; the others create the row with only what they have (saveFileFacts: key only).
- **Re-upserting a session** overwrites the turn's ts, idx, text, preceding_assistant_text and tool_calls, and
  never its label, classification, classify_attempts or pruned_at. Commits upsert ts and subject.
- **Times.** Turn and commit times come back as stored (`ts_text`); order and compare by `ts`. Tool-generated
  times go through `iso()`. ISO weeks (`stats`): `to_char(ts AT TIME ZONE 'UTC', 'IYYY-"W"IW')`.
- **Vector search** (`src/vector.ts`). Skip rows whose `vector_dims(embedding)` differs from the query's. The score is
  Neo4j's `vector.similarity.cosine`, which is (1 + cos) / 2 in [0, 1], not raw cosine: `1 - (embedding <=> $q) / 2`
  (agents see it). To be servable by its HNSW index a query repeats the index's expression exactly:
  `vector_dims(embedding) = <dims>` with the dimension as a literal, and `ORDER BY (embedding::vector(<dims>)) <=>
  $q::vector(<dims>)`. Project-filtered searches must still find the project's rows when many closer rows belong to
  other projects (three tests check this): `runSearch` sets `hnsw.iterative_scan = relaxed_order` and the outer ORDER
  BY restores the order. HNSW is approximate: data of near-duplicate vectors can leave rows the graph never reaches
  (real embeddings are spread out; `vector.int.test.ts` uses seeded random vectors for that reason).
- **NUL characters.** Postgres text and jsonb refuse U+0000. The pool's client strips it from every parameter; JSON
  built for a jsonb parameter goes through `toJson()` (a unit test fails on any `JSON.stringify(` in `src/`).
- **Embedding texts** (reembed, and what the pipeline embeds): lesson `title || E'\n' || rule || E'\nApplies when: ' || coalesce(applies_when, '')`;
  miss `missed || E'\n' || coalesce(cause_explanation, '')`; fact `path || ': ' || statement` (current facts only;
  closed facts lose their vector); chunk `text`. Mark rows `reembed_pending` first and clear the flag as each batch
  lands, so a crashed run resumes.
- **All or nothing.** replaceProjectFacts runs in one `tx()`. A fact `kind` outside FACT_KINDS fails the CHECK, which
  is what makes "a replace that fails part way" fail on Postgres.
- **Ordering ties.** Where Neo4j orders by one column, add the id as a tie-breaker so results are stable.
- **deleteProject** deletes turns, sessions (cascading their links), commits no other project's sessions saw,
  lessons whose project_key or origin_project_key is the key, every table's rows with that project_key (activity
  and predone checks included), sync cursors whose key ends in `:<key>` (compare with `right()`, not LIKE), then the
  project. Causes stay. It returns the number of rows deleted from entity tables (the test checks > 10).
- **Numbers.** The pool parses `bigint` and `numeric` as JS numbers, so `count(*)` needs no cast.
