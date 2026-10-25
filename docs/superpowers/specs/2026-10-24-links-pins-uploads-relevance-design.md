# Linked projects, pins, image and doc uploads that become facts, and fact relevance

Requested 2026-10-24. The owner asked for four things and then to "do all of this":

1. **Pin projects.**
2. **Link projects**, so facts from one project give context in the other. The links should be found when the tool
   analyses the projects, not only drawn by hand.
3. **Uploads** of project documents, images included, that the system reads and turns into facts.
4. **Fact relevance.** A fact about how to set up an external tool rarely helps with daily coding, so it should rank
   below the facts that do.

## Why

Projects are islands today. Lessons, misses, facts and docs reach an agent only from the project it is working in,
plus global lessons. Real work spans projects: a game and its backend, an app and its site, an open core and the
private product that vendors it. A fact learned in one is missing from the agent changing the other.

Uploads are text only and stored as excerpts, never facts. Screenshots, diagrams and design mocks are not readable.

All facts rank the same. An agent's context gets a one-off setup fact as readily as the convention it needs every day.

## Goals

- **Pin a project.** Pinned projects come first in every project list in the UI.
- **Linked projects.**
  - An undirected link between two selected projects, with a relation label and a short note.
  - **Confirmed links feed agent context.** get_task_context adds a "From linked projects" section with the linked
    project's best matches, each one labelled with where it came from: approved project lessons, past misses, facts
    (code and docs) and doc excerpts. check_before_done also judges the work against the linked projects' most
    relevant approved lessons.
  - **Suggested links.** The worker suggests links from evidence it finds in the projects. The owner confirms or
    dismisses each one on the Projects page, and can link two projects by hand.
- **Uploads.**
  - The Projects page takes images (png, jpg, webp, gif) as well as text.
  - Each upload is read by a model in the worker. A text doc gives facts. An image gives a text description, stored
    as the doc's searchable excerpt, and facts.
  - Uploads still give their excerpts right away. Facts follow when the worker gets to them.
- **Relevance.**
  - Every fact gets `relevance` (0 to 1): how often an agent doing everyday coding in this project needs it.
  - Facts already stored get scored by the worker in the background.
  - The owner can set a fact's relevance by hand.
  - Agent context ranks facts by similarity weighted by relevance. Low-relevance facts appear only when the task is
    very close to them, for example a setup task.

## Non-goals and anti-goals

- **Pinning does not change what agents get.** It orders the UI. (My call; easy to extend later.)
- **No link reaches an agent until the owner confirms it.** This is the same rule as lessons: suggestions are evidence,
  not decisions.
- **Links never reach projects that are not selected.** A link to an unselected or excluded project is not served,
  and the worker does not look inside unselected folders for evidence.
- **Uploads stay on this machine.** They go to the configured models only. Images are never synced or exported.
  Cloud sync is unchanged: doc titles only, and doc facts are not sent.
- **No PDF reading in this round.** PDFs need a parser or a model that reads PDFs. That is a follow-up.
- **No new volumes.** Image bytes are stored in the database (capped at 8 MB), so both backends work unchanged.

## Design

### Pins

- **Storage.** Project gets `pinned: boolean` (default false): a Neo4j property and a Postgres column. ProjectSummary
  carries `pinned`.
- **API.** `PUT /api/projects/:key/pin {pinned}`, owner-only. Logged in Activity.
- **UI.** A pin toggle on each Projects list row and in the project header. A shared `pinnedFirst` sort is applied
  wherever the UI lists projects (Projects, Inbox, Graph, Patterns, Sessions, Activity filters).

### Links

- **Model.** `ProjectLink { id, a, b, relation, note, status: suggested|confirmed|dismissed, evidence[], source:
  detected|you, createdAt, updatedAt }`. `a < b`, so a pair is one link. `id = link:<a>|<b>`.
  - Relations: `depends_on`, `same_product`, `shares_code`, `related`.
  - Evidence: `{ signal, detail, path? }`.
  - **Neo4j:** a `ProjectLink` node with `(:ProjectLink)-[:LINKS]->(:Project)` to both projects.
  - **Postgres:** table `project_links`.
- **Store (new `LinksStore`).**
  - `listLinks(projectKey?)`.
  - `upsertSuggestion(link)`: never touches a confirmed or dismissed link, except to refresh its evidence.
  - `setLink(a, b, patch)`: confirm, dismiss, relabel, or create one by hand.
  - `deleteLink(id)`.
  - `confirmedLinks(projectKey)`.
- **Detection.** A worker stage every 30 minutes (`LINK_SCAN_MINUTES`), over the selected projects. No model is used.
  - **Manifests (strong).**
    - A package.json dependency whose name is another project's package name (any package.json in that repo).
    - A `file:` / `link:` / `portal:` / tarball path that resolves into another project's folder.
    - A go.mod `require` of another project's module path.
    - A Cargo.toml or pyproject dependency on another project's package name.
  - **Remote mentions (medium).** Another project's git remote slug (`owner/name`) appears in this project's
    tracked files.
  - **Name mentions (weak).** Another project's key appears as a whole word in at least three of this project's
    tracked files. Keys shorter than six characters are skipped.
  - **Suggesting.** A pair is suggested once its evidence reaches 0.5. Weights: manifest 0.9, remote 0.6, name 0.4.
  - **Relation.** `depends_on` when a manifest names the other project, else `related`.
  - **Evidence.** At most five items, each with its file. Searches use `git grep -F` with a timeout, and secret files
    are never read.
- **Context.**
  - **get_task_context.** For each confirmed link to a selected project, the section takes:
    - up to 2 approved lessons of the other project (its project-scoped lessons only; globals are already there),
    - 2 past misses,
    - 3 facts, relevance-weighted,
    - 2 doc excerpts.
  - **Labels.** Each item is labelled `[from <key> · <relation>]`. The section opens with the link's note when it
    has one.
  - **check_before_done.** Adds the top 2 approved lessons from each linked project.
  - **Activity.** The context_served entry lists the linked projects used.
- **UI.** A "Linked projects" card on the project detail:
  - confirmed links, with relation, note and Unlink,
  - suggestions, with evidence, Confirm and Dismiss,
  - "Link a project", with a project select, relation and note.

### Uploads that become facts

- **API.** The upload body takes `{ title, name, text }` for text, or `{ title, name, image: { mediaType, data
  (base64) } }` for an image.
  - Images up to 8 MB.
  - The request body limit is raised for this route only.
- **Text uploads** are chunked and embedded as now.
- **Image uploads** store the bytes as a doc blob and a placeholder excerpt ("image, not read yet").
- **Processing state.** Uploaded docs get `status: pending`. A new worker stage takes pending upload docs one at a
  time:
  - **Image.** The docs model (`DOCS_LLM`, default `SCAN_LLM`) describes the image (all visible text, UI, diagram
    structure, data) and extracts facts. The description replaces the doc's excerpt chunks.
  - **Text.** The same model extracts facts from the doc text.
  - **Storage.** Facts are stored as ordinary facts carrying `docId`:
    - Neo4j: `Fact {docId}` nodes `-[:FROM]->(:Doc)`.
    - Postgres: `facts.doc_id` (with `code_file_id` null).
    - Same shape as code facts, with `path` = the doc name. Scans never close them; deleting the doc deletes them.
    - (Changed from a separate DocFact store while building: one fact store keeps search, relevance and re-embedding in
      one place.)
  - **Failures** retry like scans (3 attempts with backoff). "Model unavailable" waits without counting an attempt.
  - **A model without vision.** An image job fails with a plain error that names the provider.
- **Providers.** `JsonTask` gains `images?: { mediaType: string; data: string }[]`, and `LlmProvider` gains
  `vision: boolean`. How each provider sends the image:
  - **ollama:** the `images` array.
  - **anthropic:** image content blocks.
  - **openai-compatible:** `image_url` data URIs.
  - **claude-cli:** writes the image into its empty folder and asks it to Read the file.
  - **codex-cli and jev:** no vision.
- **Context.**
  - **get_task_context.** Doc facts join the facts section, merged by weighted score and labelled
    `(from doc <name>)`.
  - **search_graph.** Doc facts join the project facts it searches.
- **UI.**
  - The upload input accepts images.
  - Each doc row shows its status (reading / N facts / failed with error), an image thumbnail, and its facts.
  - The facts card on the Projects page lists doc facts with code facts.

### Relevance

- **Shape.** `CodeFact.relevance: number`. Stored facts may have `null` (not scored yet; ranked as 0.5).
- **Extraction.** Code and doc extraction prompts ask for relevance with a rubric:
  - **0.8–1:** needed in most changes (core conventions, invariants, data model, auth rules).
  - **0.4–0.7:** some changes (one module's API, a config knob).
  - **0–0.3:** rarely while coding (setting up or configuring an external tool, CI or deploy steps, editor or
    machine setup, history).
  - **package.json facts:** commands 0.7, dependencies 0.5.
- **Background scoring.** A worker stage scores up to 40 unscored current facts (code and doc) per cycle with the
  scan model (prompt only). It runs after all other work and stops when nothing is left. It skips a fact the owner
  scored.
- **Owner override.** `PATCH /api/facts/:id {relevance}` (owner-only) sets `relevanceBy: 'you'`. A rescan creates new
  facts, which get model scores again; that is noted in the UI.
- **Ranking in agent context.**
  1. Fetch 3× the facts needed.
  2. Score each as `similarity × (0.55 + 0.45 × relevance)`.
  3. Drop facts with relevance < 0.3 unless their similarity is at least 0.8.
  4. Keep the top N.
- **UI.**
  - A relevance badge on each fact: everyday (≥ 0.7), sometimes (≥ 0.4), setup / rare (< 0.4), or unscored.
  - A sort by relevance.
  - Buttons to set it: everyday / sometimes / rare.

## Storage changes

- **Postgres migration `0016_links_pins_docs_relevance.sql`.**
  - `projects.pinned`
  - `project_links`
  - `facts.relevance`, `facts.relevance_by`
  - docs: `kind`, `status`, `attempts`, `error`, `retry_at`, `processed_at`
  - `doc_blobs`
  - `facts.doc_id` (and `code_file_id` nullable)
- **Neo4j.** New properties, plus vector index `doc_fact_embedding` in schema.ts.
- **Embedding.** EmbeddingsStore.reembed covers doc facts.
- **Delete project and clean up.** Remove the project's links, doc facts and blobs.
- **Export.** Unchanged: the export and cloud bundles keep their shape (no relevance), and links and doc facts are not
  exported (local only).

## Calls I made (the owner can overrule)

- **Pinning is UI order only.**
- **Links need a confirm before agents use them.**
- **Link detection uses no model.** It is evidence the owner can check, and it is free.
- **Image bytes live in the database, capped at 8 MB.**
- **PDFs are left for later.**
- **Relevance is a number, shown as three bands.**
