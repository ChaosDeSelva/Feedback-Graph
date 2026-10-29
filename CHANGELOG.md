# Changelog

## 0.6.6 (2026-10-28)

- Claude session registration sends JSON and reports refusals. Refused registration/auth requests do not reserve run ownership or create empty session bindings; MCP discovery stays available before registration. Codex sessions have an explicit thread-registration command. Run cleanup uses authenticated provenance, supports explicit owner cleanup of legacy runs, and rejects weak run keys.
- Codex readiness is checked before copying repositories. Blocked scan providers park with exponential readiness backoff; scan responses, CLI and UI explain the wait, and status applies runner health to Docs and Ask too. Setup can generate a separate, explicitly requested procfs compatibility override without changing the default; macOS/OrbStack instructions explain its isolation tradeoff and preserve generated/custom Compose files. Mirror leases distinguish process instances even when a container reuses its PID.
- Judge parsing retains backed verdicts across mixed or malformed answers and accepts exact short changed-code literals without accepting arbitrary short substrings. Conditional console rules require the relevant task trigger. Task PR references are parsed directly, Ask prioritizes named files, and admission replies describe capacity and queue limitations. Raw embedding similarity and weighted task rank are separate; the pre-existing raw 0.78 floor is unchanged.
- Redaction preserves additional compiler diagnostics, identifiers, algorithm names and Azure placeholders while covering Twilio auth prose, PHP/.NET passwords, password hashes, PGP/PuTTY private keys, Discord/Mailgun tokens and nine more credential-file forms. Stored data is reprocessed under v8, including legacy run-key fingerprints. Encrypted local originals protect future redaction repair; existing lost wording is never invented. GitHub document repair re-fetches existing affected sources, and recovery Activity reports actual restored counts.
- Cloud policy revisions trigger re-sharing of unchanged eligible projects after allowlist changes. Established owner allowlists are repaired with audit records; personal-to-team merges remain explicit and retirement respects current policy and all machines. Local-only project settings exclude projects even from forced sync; sandbox demo probes support isolated hook, memory and judge tests. Approval responses and clients explain that sharing happens at the next sync.
- Historical GitHub PR state is backfilled without importing old feedback, enabling the closed-unmerged lesson flag. Admin Inbox defaults match the API/CLI. Cloud request/database waits and the Neo4j project-delete lock are bounded, with expired operations refused before late writes or commits.

## 0.6.5 (2026-10-27)

- Runner health and doctor execute a real nested sandbox readiness probe and fail closed when the host cannot start it. Documented the explicit masked-proc Docker Desktop/OrbStack workaround. The installed AppArmor profile is enforced and runner-only; the Docker default remains documented. Fixed the malformed environment example and added renewable worker mirror leases/sweeping.
- Redaction v7 validates Basic/Docker credentials before masking, preserves compiler diagnostics and ordinary auth policy, and covers more credential files and provider-labelled secrets. Upgrade repair rebuilds damaged facts from original sources, restores only exact safe retained lesson snapshots, and reports when an original or backup is required; it never guesses lost text.
- Pre-done checks have an end-to-end deadline, cancellable embedding and queue waits, and fresh retry budgets. Explicit added console.log violations have changed-line evidence. Weak lesson pointers are dropped, raw similarity scores remain intact, own-PR lessons/docs are excluded, and Ask includes file misses from the code map.
- PR/author filters include exact text-only mentions, CLI/API defaults agree, and GitHub author filtering is documented. Lessons have a distinct revoked status and a closed-unmerged source-PR review flag. Cloud upgrades preserve existing team remotes in empty allowlists; approval-triggered sharing is disclosed.
- Memory imports correlate real Claude and Codex writes even when classification arrives later. Run labels reach MCP and immutable real-session registration; sandbox session reads are isolated. Run keys use a private per-installation salt and are absent from Activity. Cleanup previews count only the Activity entries apply can remove; source transcripts remain retained.
- HTTP/store deadlines and bounded database waits prevent wedged requests and late mutations. Added actual ESLint checks to both repositories and CI, deterministic timestamp tie ordering and storage regression contracts, and accessible/clickable UI evidence and coverage lists.

## 0.6.4 (2026-10-26)

- Inbox and Lessons can filter by GitHub PR number and feedback author in the UI, API, CLI and admin MCP. GitHub sync can be restricted to a PR author. Bulk Inbox confirmation accepts comma- or whitespace-separated IDs.
- Only lessons tied to files named by the task are served as rules. Unrelated projects' global lessons stay out; facts, misses and documents use a 0.78 semantic similarity floor (hosted lexical embedders can supply their calibrated floor without changing scores). A task's own PR discussions are excluded when their association is known.
- Pre-done checks return queued within the tool timeout. Judge evidence must cite an added or removed line; a missing verdict is undecided, never a possible gap.
- Disputed false claims do not create misses. Post-pushback memory writes are excluded from standing context and duplicate memory lessons; mixed git instructions are detached from files.
- Hooks ignore harness prompts and edits outside the repository, and accept run labels and sandbox flags. Operator-labelled runs use a private `FG_RUN_KEY` capability; a display name alone cannot authorize cleanup. Legacy and uncredentialed runs require owner cleanup.
- Runner jobs use a separate mount and process namespace containing only the current mirror, runtime, login and fresh temporary files. Rebuild the codex-runner image when upgrading; Linux user namespaces must be available. Stale mirrors are also swept on startup and before jobs.
- Redaction covers additional provider tokens, Basic authentication, Azure AccountKey, Docker auth and pgpass; scanners skip additional credential files. Stored text is rechecked under redaction rules v6.
- Deselected code maps expire after a 24-hour grace period. Repeated first-run `setup.sh --yes` uses the saved instance name.

## 0.6.3 (2026-10-26)

From the team's 0.6.2 field report (an upgraded live install, a real ticket, the learning loop with Claude Code and Codex,
a second install with planted secrets, stress and cloud). 0.6.2 got the plumbing right; this release makes its centre,
lessons right the first time, visible to the agent and to you.

### Corrections to the 0.6.2 notes
- "A cut code map keeps the files it left out" needed a cloud that understands it, and none deployed did. Now the client
  cuts a code map only for a cloud that says it keeps the files (the cloud from this release does); against an older
  cloud the project fails with what to do, and nothing is withdrawn.
- "A run belongs to whoever opened it" was per kind of credential; it is now per caller (see Runs).
- "Sandbox runs reach only that run" did not cover Activity; now it does.
- "Operator decisions counted apart" were computed but not shown; now they are.
- "Each cloud project is sent once more": no one-off step; the first sync after the upgrade resends each project because
  the unchanged-check changed form.
- "60 only after an edit" was the team's count, not what 0.6.2 showed (81 / 0): the edits made before 0.6.2 are now
  recovered (see Lessons).

### Upgrading
- At the first worker start (each once, logged in Activity): the writer's draft of lessons edited before 0.6.2 is
  recovered from Activity; lesson checks v5; redaction v5 (now over Ask messages too; approved lesson text is never
  rewritten; subjects are redacted before they are cut); git instructions are detached from files; long dependency facts are shortened; fact relevance is
  recalibrated (yours untouched); data folders' facts are forgotten. Steps that read session evidence wait for the
  transcript re-read.
- **Every project needs one full rescan:** the scanner changed (shards by service, enforced budgets), so `fg status`
  recommends it. A scan spends your model budget; none starts on its own.
- Store migrations 0044 to 0046.
- **A second install** that would run under another folder's Compose name is refused by `setup.sh` (`doctor.sh` fails,
  `fg` warns), and its `install-agent.sh` leaves the first install's skills and Codex guidance alone.
  `setup.sh --select acme,demo-shop` chooses the projects to read on a first run without the UI.

### check_before_done
- **A catch keeps its line:** when the judge model flags a lesson but leaves out its evidence, it is asked once more, or
  the line it quoted in its reason is used, so a violation is a gap with its diff line, not "cannot tell".
- **A cut diff is always said** ("diff cut to fit (30.5 of 47.0 KB shown), files not shown: …"), even when no lesson
  applied, and the answer and `/api/status` name the judge model.

### What agents are served
- **Approved lessons are chosen by how far they stand out for the task,** not by a fixed floor (on real embeddings an
  unrelated task scored 0.35 to 0.6 against every lesson): a nonsense task gets none. A lesson is served as a rule only
  when it is tied to a file you named, stands out clearly, or shares a topic with the task; weaker matches are listed
  under "Possibly related lessons" and never judged at done.
- **search_graph** gives misses, facts and docs their room; **impact** lists the nearest dependents first. Each section
  says what it cut.
- "Your own change" marks only facts about files your session edited, written after it started. Named files too big or
  secret-named for the code map say so. `brief: true` keeps the named files. The prompt hook brings back a lesson or
  miss it had to clip. Session summaries end at a sentence. A git instruction ("don't push a PR yet") is never tied to
  files.

### Speed and robustness
- **MCP searches on Neo4j use the vector indexes** (no search did before): 32 concurrent searches went from 16 to 200
  per second at 2,000 lessons, p95 2.3 s to 0.27 s. Neither store applies the sandbox filter until a sandbox run has
  written something.
- **check_before_done queues judge calls** (`CHECK_CONCURRENCY`, default 2), says how many checks it waited behind, and
  answers "not judged" after `CHECK_WAIT_SECONDS` (default 300, enough for a local model; the judge and its retry share it, and a check that gives up cancels its model call): never a pass, never a gap. A judge that fails answers "not judged" with the reason, never an error.
- **Ask answers questions to different models at once,** and a waiting question shows its place in line.
- The largest upload no longer fails: it is embedded in batches, and a big file is taken at once (202) and stored in the
  background. An API restart ends event streams at once; idle connections are kept 65 s. Inbox list rows stay small;
  Activity subjects are capped at 500 characters (the entry says how long the original was).

### Safer by default
- A judge that fails answers "not judged" with the reason, never an error; a project with only a few approved lessons
  still gets the one on its task in other words (a nonsense task still gets none).
- A scan's top-up run that fails keeps the first pass's facts. Real source in folders named `archive/` or `spec/` gets
  its full budget; a folder of game content or decision records is scanned; only big log, transcript, export and dump
  folders are left out.
- `fg cleanup` keeps the history of records it keeps and never removes a change it did not list. A large upload shows
  "embedding" until stored, or why it failed. "May hold a secret" clears once you edit the secret out. A dependency fact
  is shortened only when its list can be read, and its full text is kept in Activity.

### Lessons
- **The quality numbers count your edits from before 0.6.2** (recovered from Activity), and show operator-token
  decisions apart. The post-mortem's examples come from each kind of decision (edited, rejected, approved as written),
  and Activity records which it was shown.
- Lesson checks v5: "rule repaired" follows the rule as it is now and an edit re-checks; rules starting "Cap / Refresh /
  Coalesce …" are not "looks like a fact"; "wrong session" no longer fires on comment-alone or branch- or files-matched
  post-mortems; new flags "vague applies when" and "may hold a secret".

### Secrets
- Webhook URLs (Slack, Discord), tokens in a URL's query, slashed secret values and whole flag values
  (`--password=Secret123!`) are redacted; "the admin password for the system is …" is caught; paging tokens like
  `nextPageToken` are not blanked.
- An uploaded document's fact that is an instruction aimed at the agent ("ignore previous instructions", "you are now…",
  role markers, piping a download into a shell) is not kept; a project convention ("Always run pnpm test before
  committing") is a fact and stays.
- An Activity subject is redacted before it is cut to 500 characters, so a token crossing the cut is never half-stored.

### Scans
- Shards follow service boundaries (nested apps get their own; unrelated services never merge). Tests, fixtures,
  archived and generated files get a small budget, enforced in code, as are each shard's fact minimum and maximum. A file
  an agent asks about mid-scan is read on its own. Dependency facts are a count and the notable packages. "Everyday"
  relevance is a minority. Folders of transcripts, logs and other data are left out.

### Runs, demo and cloud
- A run belongs to the operator name that opened it. The operator token may clean up runs agents opened without a
  token. `fg cleanup --apply` also removes the run's Activity entries and checks. The default Activity feed and the
  Dashboard leave out labelled runs; sandbox entries never show to anyone else.
- `fg demo seed` no longer fails after writing the lessons: it completes or takes back what it wrote; `fg demo remove`
  removes the project it created; demo records are never exported or synced.

### UI
- Activity rows read on one line: subject, kind badge, and time, actor and run as chips; a run filter, labelled runs
  hidden by default. Times show in words on hover.
- Graph Code mode names the key files and every file with misses (red ring, miss count). The Projects page no longer
  scrolls as a whole. The Lessons bulk bar no longer moves rows; filtered empty lists say nothing matches.
- Ask shows each answer's context pack size, cites misses by their file, re-sorts its list, no longer fails on the word
  "constructor"; the Dashboard's Ask lets you choose the model. Linear with no team mapped says to map one.
- The Docs page and the guide cover 0.6.2: runs, sandboxes and testing, the diff-reading check, headless Claude Code.

## 0.6.2 (2026-10-26)

From the team's 0.6.1 field report (real headless Claude Code and Codex sessions end to end, a fresh install with
planted secrets, a stress run on a large repository) and their audit of 143 proposed lessons: 21 approved as written,
60 only after an edit, 62 rejected. Most of this release is about the lessons being right the first time.

### Upgrading
- At the first worker start, without you doing anything (each step once, logged in Activity with counts):
  - **secret redaction v3** runs over stored facts, document texts, lessons, miss feedback, Inbox items, session
    summaries and Activity. Facts you wrote are never closed; a fact that is itself a credential is.
  - **lessons are re-checked (v4):** proposed lessons get their paths normalized against the repository; every lesson
    gets the new flags (generic, two-in-one, wrong session, contradicts the session's evidence, built on another
    project's Linear tickets). Approved lessons are only flagged, never rewritten.
  - **comments are matched to sessions again** under the new rule; a proposed lesson built on the wrong session is
    flagged, and one whose own post-mortem found no miss is rejected.
  - **skip rules v3** run over the pending Inbox (bot reviews, approvals, status tables, folded review summaries).
  - Codex sessions an older rule froze at their first turn are read again; transcripts are read once more to record
    which instruction files each session had.
  - Each cloud project is sent once more (the unchanged-check now uses a canonical form).
- Store migrations 0034 to 0043.
- **The operator token** can no longer choose which projects are read (`select_projects`) or delete a link
  (`links_delete`) unless `OPERATOR_ALLOW` names them. Add them if a script relies on that.
- **A second checkout** gets its own Docker Compose name (`FG_INSTANCE`), ports and Ollama port (`OLLAMA_PORT`) from
  `./scripts/setup.sh`, and `install-agent.sh` registers it as `feedback-graph-<name>`. An existing install keeps its
  name, ports and volumes.

### Lessons
- **A review comment is matched to a session only if the session worked on the pull request's branch or edited its
  files,** never for being nearest in time (the most common reason the team rejected a lesson). With no match the
  post-mortem works from the comment and the pull request alone, and says so.
- **A post-mortem that finds the agent missed nothing proposes no lesson.** A nit, "Minor:" or optional comment never
  becomes a project-wide lesson.
- **Not pushback, so skipped:** reviews written by a bot or an AI, approvals with nothing to change, status tables,
  notes about branch merge order. A review summary that repeats its inline comments is one Inbox item.
- **A lesson whose rule is just "project" or a label is asked for again,** told why; if still empty the title becomes
  the rule, or the lesson is dropped and logged (the miss is kept).
- **New flags:** "generic" (a rule that names no file, function, value or command; listed last, with the reason) and
  "two lessons in one".
- **Lesson paths are checked against the repository:** a bare file name resolves to its one match, an ambiguous one is
  flagged, missing files, pull request refs and globs matching nothing are dropped.
- **The post-mortem learns from how you judged this project's earlier lessons:** what you changed (the writer's
  version is now kept when you edit), what you rejected and why, and what you approved as written. Never another
  project's, never a sandbox run's.
- **How your lessons are judged** (approved as written, after an edit, rejected; 30 and 90 days, per project) on the
  Lessons page, `fg lessons quality`, `fg status` and `/api/pipeline`.
- **A global lesson can be narrowed to a project** on the Lessons page (or `projectKey` in `PATCH /api/lessons/:id`).
- **A global lesson reaches an agent only when the task is on its topic,** and its own project's files no longer rank
  it up elsewhere.

### What agents are told
- **Lesson counts are the project's own and the global ones, apart.**
- **check_before_done reads the real diff:** the one the agent passes, or the repository's diff of `files_changed`. The
  judge copies the diff lines each verdict rests on; a verdict with no line in the diff is "cannot tell from the diff",
  neither a gap nor a pass. A size cut names the files it left out. It takes `session_id`, and the plugin passes it.
  The Stop hook asks for `git diff` from the commit the session started at, and no longer counts a denied or failed
  check_before_done as done.
- **impact and get_module_context are capped and say what they left out:** the nearest 15 tests, 8 lessons, the 6
  most recent misses (grouped), within about 4,000 characters. Facts and imports past 40 say "and N more".
- **A post-mortem judges what the agent had loaded from the session itself** (attachments, `@AGENTS.md` imports, the
  Codex instructions), and only sees Linear tickets linked to its project.
- **A folder that is not selected** still gets global lessons, but its task and summary are not kept in Activity or
  sent to the judge; check_before_done says the work was not judged.

### Codex
- The agent MCP tools carry MCP annotations, so `codex exec` can call them. `install-agent.sh` also prints the one-run
  override: `codex exec -c 'mcp_servers.feedback-graph.default_tools_approval_mode="approve"'`.
- A live Codex session is no longer frozen at its first turn when it later opens like a Claude Code conversation.

### Secrets and privacy
- Secrets assigned in code (`const API_KEY = "..."`, `token := "..."`, `self.password = '...'`), unquoted config
  values, `-e`/`--password` flags and passwords written in prose are redacted everywhere, including Ask's snippets.
  Database, cache, config and map keys, identifiers, paths and versions are not ("The primary key is user_id2." stays).
- An uploaded image or document that shows a password no longer becomes a fact; uploaded text reaches a model fenced
  as data.
- No git command the tool runs on a project can run a filter, fsmonitor, textconv, external diff, signature program or
  hook the repository configures.
- An export with no project named covers the selected projects only.

### Scans, queues and scale
- **Scans take turns:** a big repository's sharded scan gives way after each shard to scans queued behind it, never
  gets its slot straight back while another waits, and picks up where it left off (its file list and plan kept while
  HEAD is unchanged).
- **Each queue says how it stands** (scans by project, classify, post-mortems, Ask answers): how many wait, the oldest
  wait, what runs now, in `/api/pipeline`, `fg status` and the Dashboard.
- **A GitHub sync past 1,000 pull requests** reads the rest over the next syncs instead of skipping them, and says so.
- **The Docs list** loads 100 at a time ("load older"; `limit` and `X-Next-Cursor` in the API).
- **Neo4j** has indexes for the per-project lookups the Projects page makes.
- **A post-mortem about auth code** no longer reads as "model not signed in"; one that keeps reading as unavailable is
  recorded as failed after five tries instead of holding the queue.

### Cloud sync
- A project that keeps failing backs off on its own; the others sync on their interval, and Settings names it.
- A project too large for the cloud is sent with its code map cut to the busiest files that fit, and says how many.
  The bundle says `codeFilesPartial`, so a cloud from 0.6.2 on keeps the files it left out of the team's code map.
- An unchanged project is not resent because rows came back in another order; Sync now and the scheduled sync no
  longer lose each other's record of what was sent.

### For testers and automation
- **Runs:** label requests with `x-fg-run: <id>` (or `?run=<id>` on `/mcp`, `fg --run <id>`); Activity shows and
  filters it. A run belongs to whoever opened it: a write under another caller's run id is refused.
- **`fg cleanup --run <id>`** removes only what that run wrote: a dry run first, `--apply` to do it, keeping anything
  you decided on since. The operator token may clean up only runs it opened.
- **Sandbox runs** (`x-fg-sandbox: 1`): their records reach only that run (every list, search, count, Ask pack and code
  map answer), and are never exported or synced.
- **`fg evidence <session>`** (`GET /api/sessions/:id/evidence`): what the tool saw in a session and what it decided.
- **`fg demo seed` / `fg demo remove`:** a labelled demo corpus in demo-shop so the lesson path can be tried on a fresh
  install. Running it is your approval of those demo lessons; it never touches a file a scan recorded.
- **Running Claude Code headless** (`claude -p`): a tool that is not allowed is denied, never prompted. Pass
  `--allowedTools "mcp__plugin_feedback-graph_fg" "Bash(git diff *)"`; with `scripts/install-agent.sh claude` instead
  of the plugin, allow `mcp__feedback-graph`. The plugin skill has the details.

### Safer by default
- **A lesson you edited or decided is never changed automatically:** a re-run post-mortem keeps your wording, the path
  clean-up leaves your paths, and a "no miss" finding only flags it. Automatic rejections never count as yours in the
  quality numbers or the writer's examples (operator-token decisions do, counted apart); ones already stored are
  corrected once at start.
- **A model outage, or a model busy with a scan, never uses up post-mortem attempts;** only an item that keeps failing
  while the model answers everything else is charged.
- **A run never takes over your records:** a sandbox tester's upload or link decision is its own copy beside yours,
  any other labelled run gets a 409 on your documents, links, pins, Inbox items, lessons and chats unless you opened
  it, and your decision on something a run made makes it yours, so cleanup leaves it. `fg cleanup` never labels its
  own request with the run it removes.
- **check_before_done judges only the lessons get_task_context would serve** (lessons tied to the changed files always),
  and when a diff is over its ~32 KB budget it keeps the files the lessons and misses name first. If you deny the tool,
  the Stop hook says so once and stops asking.

### Changed
- **The Dashboard** gives Where agents struggle and Recent activity a full-width row each.

## 0.6.1 (2026-10-25)

0.6.1 makes 0.6.0 work on the data an install already holds, and on a large real repository. Each rule change now
migrates the data it governs (maps, scan shards, facts, lesson checks, pending Inbox items, misses), lists say what a
cap left out, and judges answer "applies or not" instead of a reason with no verdict.

### Upgrading
- At the first worker start after the upgrade, without you doing anything (each step once, logged in Activity):
  - code maps from older map rules are rebuilt;
  - existing facts are validated again;
  - existing lessons are checked again;
  - the skip rules and the new instruction rule run over items already waiting in the Inbox;
  - misses about branches, merges and pull requests stop sitting on files.
- **Files read by an older scanner are rescanned by the next scan you start,** not on their own (a scan spends your
  model budget). Until then the Projects page and `fg status` say "N files were read by an older scanner: press Scan to
  refresh them".
- Store migrations 0026 to 0033.
- **Cloud sync:** a team project that lost records to the old second-folder bug gets them back with one forced Sync now
  (`fg cloud sync-now --force`) of each affected folder, once the cloud is updated.

### Changed
- **Ask is first on the Dashboard,** front and centre: one question box with the project under it (Enter asks, Shift+Enter is a new line), starter questions that fill the box, questions suggested by your hotspots, and your recent chats. The status cards follow. The Dashboard shows 10 projects then all, and counts global lessons.
- **Settings has tabs:** Projects, Integrations, Cloud sync and Clean up. The tab is kept in the address, a link to a card opens its tab, and unsaved folder changes stay in the bar on every tab.
- **A GitHub or Linear token saved in Settings now wins over one in `.env`,** so a key set in `.env` can be replaced from Settings without editing the file. Disconnect removes the saved token and goes back to the `.env` one, if any.
- **The operator token no longer asks in Ask by default** (`chat` joined the default-off verbs: it spends your Claude or Codex subscription); add `chat` to `OPERATOR_ALLOW` to allow it. `./scripts/setup.sh` now says what the token turns on (the admin MCP at `/mcp/admin`) when it makes one, including under `--yes`.
- **Cloud sync names this machine** (`CLOUD_MACHINE`, filled by `./scripts/setup.sh` from the host name) so the cloud's sync log says which machine synced. A 429 from the cloud now says it may be the rate limit, not only another sync.

### What agents receive
- **`check_before_done`** also judges approved lessons tied to the files you changed, and lists only the lessons and misses the judge says apply. When none applies it says so, and that this is not a pass while lessons wait for approval. It never prints a gap whose own reason explains it away.
- **One miss on many files is shown once,** with its file list, in every tool.
- **Misses and facts need a 0.3 similarity** to be served. A task that names a service by its folder ranks that service first, and scores are shown. A miss whose lesson you rejected as coming from the wrong session is never served.
- **`search_graph`** returns its own hits (about 3,000 characters) and says what it cut. "Data, not instructions" appears once per answer, and the `check_before_done` reminder only on `get_task_context`.
- **`get_task_context`:**
  - `brief: true` gives lessons, misses on your files, their importers and tests, and PR discussions in about 1,500 characters.
  - It lists the Linear tickets the PRs it shows name.
  - Named files with no facts are queued for a scan.
  - Facts from your own change this session are labelled as such.
- **Linked projects** add context only when it is close to the task. One-turn probe sessions are left out of recent sessions, and a session shows the branch its files were changed on.
- The hook no longer reads "is" as a lesson id.

### Code map and Ask
- **Capped code maps keep an import index for every file,** so importer counts, impact and tests include files past the cap. The map keeps the most imported and most changed files, not the first by path. A file past the cap says who imports it instead of "not in the code map".
- Python imports of a repo's own packages that cannot be followed count as unresolved.
- **Ask finds files by name,** including files past the cap. "modal" also finds dialogs, and filler words and part-word matches no longer fill the pack.
- Each answer reports the size of its pack, and citations and Sources rows are links.

### Scans and facts
- **Monorepos are split properly:**
  - Scans shard by every package and service with its own manifest (go.mod, pyproject.toml, package.json...), not only the declared workspaces.
  - Shards over 400 files are split, and the fact budget grows with the shard instead of stopping at 60.
- **A new scanner version rescans** the files an older one read, even unchanged. Facts saved before 0.6.1 are checked again once at start: AGENTS.md and missing-file citations are no longer served, and wrong line ranges are dropped (logged in Activity).
- **Scan order:**
  - files an agent named in `get_task_context` that have no facts come first (read first by the next scan);
  - then files sessions edited;
  - then hotspots (recent churn, review comments, long explanatory comments).
- **Scan agents:**
  - They see files grouped by directory, with a minimum per large directory.
  - They report what they did not reach, and the Projects page shows it.
  - Codex copies the repo once per scan, not once per shard.
- **Facts API and line ranges:**
  - The facts API pages (`limit`, `offset`, `X-Next-Offset`) and filters by `origin`; `confidence` is gone.
  - Correct line ranges inside a function body are no longer dropped.
  - Task context points at a manifest instead of printing its dependency list.

### Learning from feedback
- **An instruction about git ("don't push a PR yet") is not a miss** unless the agent then pushed, merged or opened the PR.
  - Only a pure git constraint counts. A message that complains, asks for a change or names a file still goes to the classifier, even when it mentions a commit or a PR.
  - It is judged once its session has gone idle, so a push that comes later still makes it a miss.
- **Misses purely about branches, pushes, merges, PRs or commits** are no longer attached to every file the session edited.
- **Post-mortems:**
  - Lessons no longer carry PR numbers in the rule, repeat the rule as the title, or leave "applies when" empty.
  - A new cause, "code not read": the code was in the repository and the session never opened it.
  - Proposed facts are logged beside the lesson, never stored.
- **Lesson checks are versioned and rerun on upgrade.**
  - They now flag paths missing from the repo, lessons with no path, wrong-session misses and near-duplicates (`duplicate-of`).
  - An APPROVED review is not a nit, and "When X, ensure Y" counts as a rule.
  - "Looks like a fact" now catches "X is configured in Y" and "Remember that ...".
  - `fg lessons recheck` forces a recheck.
- **Bulk decisions:** select lessons, or all lessons with a flag, and approve or reject them with one confirm. Also `fg lessons approve|reject <id>... --note` and `POST /api/lessons/decisions`. Lessons filter by source and by check. A lesson from a review says who said it, with the review verdict shown neutrally.
- **Skip rules:**
  - The status-note rule knows "Fixed: …", "Done.", "Closing in favour of #…", "Superseded by #…" and "Addressed in the latest commit"; corrections worded the same way still reach the classifier.
  - When the rules change, they run over items already pending.
- **Linear issues** of a mapped team are read (read-only) as project documents, and pull requests link to the tickets they name.

### Operator tools
- **Admin MCP:** compact paged lists (20 rows), `inbox_get` and `lesson_get`, `structuredContent`, and read-only hints, so Codex no longer asks before each read.
- **`fg`:**
  - `facts list --q` shows results.
  - `scan --wait` shows progress at least every 30 seconds.
  - `status --watch` prints only changes.
  - `--json` errors are JSON, usage errors are one line, and `fg help <verb>` works.
  - `--until idle` is not held up by the GitHub or Linear sync, and `map rebuild` is logged.
- **OpenAPI** has response schemas for every operation and describes the MCP endpoints. Unknown `/api` paths answer a JSON 404.
- **Security:**
  - A wrong bearer token is refused (401) and logged on reads too.
  - Request bodies are limited: 1 MB, 16 MB for uploads, 256 MB for imports.
  - Link decisions record who made them, and Activity records whether a write came from the operator token or a browser.
  - The api and worker containers run on a read-only file system, and Neo4j drops capabilities.

### Fixed
- **The Graph's Code mode no longer packs files into one ball:** files repel each other more as the map grows, never overlap, links get room by kind, each dot keeps a readable size when zoomed out, and the drawing is fitted below the legend and notes. Captions no longer pile up or cover nodes.
- A Projects link followed while the page is open switches project, so Rebuild and Scan act on the project shown. The code map card shows the new map once a rebuild finishes.
- A lesson's context no longer prints "wasAvailable" as its reason.
- "Where agents struggle" lists only files with misses, and Sync now says "Nothing changed since the last sync".
- **Performance:**
  - Orphan code files left by old session touches are purged.
  - Activity lists leave big details out until you open an entry.
  - The Inbox loads 200 items at a time.
  - The relevance backfill no longer keeps the worker busy.
  - The cloud preview runs 4 projects at a time.

## 0.6.0 (2026-10-24)

### Added
- **Dashboard,** the new landing page: what the worker is doing and model health, pipeline counts (Inbox waiting on you, turns to classify, post-mortems, lessons, scans), repeat and pre-done catch rates with the weekly trend, projects (pinned first, with links), top hotspots and recent activity, and an Ask box.
- **Ask.** Chat about one project (and its confirmed linked projects), one conversation per topic. Each question gets a context pack: matching approved lessons, past misses, facts (code and documents), doc excerpts, recent sessions, code map matches with where each is used and its tests, and up to 16 KB of the matching code (secret files never read, secrets redacted). The answer cites numbered sources, lists existing examples with their usages, and ends with a **prompt for your agent** to copy into Claude Code or Codex: goal, files to read first, patterns to follow, lessons and misses to respect, open questions, the sources, and which Feedback Graph tools to use while working. Answers run in the worker on `CHAT_LLM` (default Claude when a Claude token is set, else Codex when it may run, else the local model); each chat can switch between Claude, Codex and the local model. The model gets only the question and its pack, never the repository. Chats are deleted with their project and never exported or synced. New routes under `/api/chats` (writes owner-only; operator verbs `chat`, on by default, and `chat_delete`, off).
- **`fg` grows:** `scan --wait`, `status --until idle|<stage>`, `map rebuild <key>`, `pipeline`, `inbox show`, `lessons show`, `links list|confirm|dismiss`, `facts list|relevance`, `docs list|upload`, `activity`, `sessions`, `cloud status`, `cloud sync-now [--force]`, `integrations status|test|set --from-stdin`, `doctor`. `fg status` shows the stage, the pipeline backlog, the last Sync now and since when a model is down; `fg projects list` shows pins, counts, scans and links. New `GET /api/scans/:id` (with queue position).
- **Rebuild a code map** from the code map card, `fg map rebuild <key>` or `POST /api/projects/:key/codemap/rebuild`.
- **Find a file by path** in Code mode; a module panel can be linked (`#projects/<key>/<path>`), and a fact's file opens it.
- **Retry a failed upload reading** without uploading again (`POST /api/docs/:id/reread`).
- Lesson checks are stored on each lesson and shown as chips before you approve (narrowed, about feedback, platitude, looks like a fact, bad paths, wrong session, self-review...); existing proposed lessons are checked once. Settings shows how many comments each skip rule kept out, and Activity records them.

- **Admin MCP endpoint** `/mcp/admin`, only when `FG_OPERATOR_TOKEN` is set and only for that token: a coding agent can check status, list and select projects, run scans, decide Inbox items, links, fact relevance and lessons, run Sync now and rebuild code maps from inside a session. Each tool goes through the same `OPERATOR_ALLOW` verbs as the API, and Activity records `operator:<agent>`.
- **`GET /api/openapi.json`** describes the local API (OpenAPI 3.1), including which routes are owner-only and which `OPERATOR_ALLOW` verb unlocks each. **`GET /api/events`** streams stage, pipeline, scan, Ask and Activity changes as server-sent events; `fg status --watch` follows it.
- **Agentic scans run per package or service** (pnpm, npm, Go and Cargo workspaces, else `src/*`, `packages/*`, `services/*`, `apps/*`, `cmd/*`), each with its own fact budget, instead of one skim of the whole repo. A rescan only revisits packages whose files changed; a package that fails is retried next scan while the others keep their facts. The scan line says how many were rescanned.
- **Convert a lesson to a fact** (Lessons page, `POST /api/lessons/:id/to-fact`, `fg lessons to-fact <id>`): a proposed lesson that states how the code is becomes a project fact you wrote, which no scan replaces; the lesson is rejected with the note "converted to a fact".
- `fg inbox list --source claude|codex|github|linear` (and `GET /api/candidates?source=`), `fg projects list|select --with-sessions`, `fg setup`.
- **A guide to every page**, with screenshots: `docs/guide.md`, and the same guidance on the Docs page.

### Changed
- **Shorter tool names in the Claude Code plugin.** The plugin's MCP server is now `fg`, so its tools are `mcp__plugin_feedback-graph_fg__get_task_context` and so on (was `..._feedback-graph_feedback-graph__...`). If you allowed the old names in Claude Code permissions, allow the new ones; the hooks and skills need nothing. `install-agent.sh` registrations keep the `feedback-graph` name.
- **What agents receive.** TypeScript path aliases (tsconfig `paths`, `extends`, `#imports`) resolve in the code map; when imports could not be followed, agents read "import graph incomplete" instead of empty lists. With no approved lesson, `get_task_context` and `check_before_done` say how many are waiting, and the check judges the work against confirmed past misses instead of reading as passed. Misses and facts are ranked by closeness to the task and the named files, and post-mortems that found no miss are never served. `get_task_context` says when the facts about each named file were refreshed and whether the file changed since. Empty "developer said" fragments are gone.
- **Plugin hooks** add only approved lessons and misses on the files a prompt names (about 1.5k characters), skip plain questions, and the Stop reminder names the edited files.
- **Facts** are checked against the repository when saved (citations of missing files or instruction files are dropped, wrong line ranges removed) and show an evidence level (line checked, file only) instead of a confidence percentage. Manifest facts also come from pyproject, go.mod, Cargo.toml, Makefile targets, compose services and `.env.example` keys (never values), and are counted apart from model facts. "Everyday" now starts at relevance 0.8, matching the rubric.
- **Post-mortems of comments** use a work session only with evidence (it edited the commented file or one the comment names), and otherwise the comment alone. Lesson paths are checked against the repository; instruction files, PR references and non-paths are dropped. Comments synced before 0.5.0 get their author details on the next sync, so the skip rules apply; pending items a rule now matches say so (decided items are never changed).
- **Ollama:** structured calls send `think: false`, a fixed context window (`OLLAMA_NUM_CTX`, default 16384) and per-job answer budgets (classify 256, relevance 1024, Ask 6144, others 2048; `OLLAMA_NUM_PREDICT` still overrides). `doctor.sh` and `setup.sh` fail when a model answers only in its thinking. On a local model, Ask's context pack is cut to fit the window.
- **Projects** created by scans or code maps get their folder and remote, so they show their path and sync to the cloud as team projects.
- **Git worktrees** are fingerprinted through the roots mapping (a folder git cannot read falls back to a file fingerprint), so their maps no longer rebuild every 5 minutes. Code maps are written as a diff in small transactions, a map pass stuck over 20 minutes is logged and restarted, and orphan code-file records are cleaned up.
- **Sync now** sends only what changed, like the schedule (`fg cloud sync-now --force` resends everything), and reports progress.
- The operator's name is recorded on Inbox decisions, fact relevance and uploads, and Activity wording names the agent. Notes an agent wrote reach the post-mortem only as untrusted text. A wrong bearer token gets 401 and is logged. `setup.sh` offers to create `FG_OPERATOR_TOKEN`.
- **UI:** Code mode labels the top hotspots at any zoom by their shortest unique path, without overlaps; "No hotspots yet" instead of docs and config when nothing scores; facts sort by relevance, grouped by file, 25 files at a time; the pipeline panel stays as one line after the first run; link decisions keep their row with Undo, and no links are suggested between a project and its own clones; the Inbox description no longer scrolls on its own, bot comments are collapsed and authors are labelled (PR author, reviewer, bot, agent, self-review); the skip rules sit under Integrations; import messages can be dismissed; pinning no longer scrolls the page; maps built before 0.5.0 that are at the cap say so.
- api and worker containers drop all Linux capabilities and cannot gain privileges; MCP text arguments have length limits; `GET /mcp` answers 405.
- **Clearer UI:** Inbox rows say "87% sure"; Linear's badge is violet so it no longer looks like GitHub; every miss cause has its own colour and the Graph names causes like Lessons and Patterns do; the Dashboard's backlog tiles open where the backlog shows, and scans show queued and running apart; lessons say where they came from in words; Patterns lists every project; Activity explains each actor; a fact citing no file reads "not checkable (no file)"; approved lessons have a Save button for edits.
- Postgres adds migrations `0019_chat`, `0020_code_map_rebuild`, `0021_lesson_checks`, `0022_map_unresolved_fact_evidence`, `0023_operator_attribution`, `0024_scan_shards` and `0025_lesson_to_fact`.

## 0.5.0 (2026-10-24)

### Added
- **Pin projects.** A pin beside each project on the Projects page (and **Pin** in its header); pinned projects come first in every project list. `PUT /api/projects/:key/pin` (owner-only).
- **Linked projects.** Link projects that belong together, with a relation (depends on, same product, shares code, related) and a note. When an agent works in one, `get_task_context` adds a **From linked projects** section with the other project's best approved lessons, past misses, facts and doc excerpts, each labelled with where it came from. `check_before_done` also checks the work against the linked projects' most relevant lessons. Only confirmed links between selected projects are used. Every `LINK_SCAN_MINUTES` (30) the worker looks for links without a model: a package manifest (package.json, go.mod, Cargo.toml, pyproject.toml) naming another project's package or a local path into it, another project's repository named in its files, and its name in several files. They arrive as suggestions with their evidence for you to **Confirm** or **Dismiss**. New: `GET /api/projects/:key/links`, `PUT /api/links`, `DELETE /api/links/:id` (writes owner-only).
- **Image uploads, and every upload read into facts.** The Projects page takes PNG, JPEG, WebP and GIF images (up to 8 MB, stored in the database) as well as text. The worker reads each upload with `DOCS_LLM` (default `SCAN_LLM`). A document becomes facts. An image becomes a description of everything in it, which replaces its placeholder excerpt, plus facts. Facts from a document are labelled with it in agent context, are never closed by a code scan, and go with the document. Images need a model with vision: Ollama vision models, `claude-cli`, `anthropic:`, `openai:` and `openrouter:` read them; `codex-cli` and `jev` refuse with a plain error. Each upload shows whether it is waiting, read (with its fact count) or failed (with why), and images show a thumbnail (`GET /api/docs/:id/image`).
- **Fact relevance.** Every fact has a relevance from 0 to 1: how often an agent doing everyday coding in the project needs it. Setting up an external tool, CI or deploy steps rank low. Scans and document reading score new facts. Facts stored before relevance existed are scored in the background by the scan model, a batch at a time when nothing else is waiting. Agent context ranks facts by similarity weighted by relevance and leaves a rare fact out unless the task is very close to it. On the Projects page each fact shows everyday, sometimes, rare or unscored, the list sorts by relevance, and you can set a fact's relevance (`PATCH /api/projects/:key/facts/:id/relevance`, owner-only; the background scorer never changes yours).

- **Let agents drive it: an operator token and the `fg` CLI.** Set `FG_OPERATOR_TOKEN` (24+ characters) and an agent or script sending it as a bearer can make the owner decisions `OPERATOR_ALLOW` names. By default that is everything except deciding lessons (what agents learn stays yours), deleting a project or an uploaded document, the settings that change roots or clean up data, imports and integration keys; `all` allows everything. Writes made with it show in Activity as `operator:<name>` (the `X-FG-Operator` header), and a lesson an agent approved or rejected shows a badge. `scripts/fg` (no dependencies; host Node, or `docker compose exec api`) does `status [--watch]`, `projects list|select|unselect`, `scan --all|--key`, `inbox list|confirm|reject`, `lessons list|approve|reject` and `cloud sync-now`, with `--json`. It never sends the token over plain http to another machine. New batch routes `POST /api/projects/scan` and `POST /api/candidates/decisions` (owner-only).
- **`./scripts/doctor.sh`** checks Docker, ports, Ollama (with a real schema-constrained call), models, `host.docker.internal` and Ollama from inside the worker, the transcript mounts, the Codex login, and GitHub and Linear, as PASS/WARN/FAIL lines with the fix.
- **Setup without questions.** `setup.sh --yes --pull-models --projects <dirs>`, plus `--github-token-file`, `--linear-key-file` and `--claude-token-file` (read a file a person wrote; written to `.env` mode 600, never echoed). Setup now makes one real structured-output call to Ollama and stops with the fix when it fails (on macOS: the Ollama app, not the Homebrew formula, whose build cannot do structured output).
- **`install-agent.sh codex --codex-auto-approve`** writes `default_tools_approval_mode = "approve"` for the feedback-graph server, which `codex exec` needs to call its tools.
- **What the pipeline is doing.** `/api/status` fills `stage` and `progress` (what the worker is on, since when, done of total), and a new `GET /api/pipeline` gives every stage's backlog. A first-run panel on the empty Inbox, Lessons and Graph pages shows ingest, classify backlog, items waiting on you, post-mortems queued, lessons and scans, each linked to its page. A model outage says since when and clears once that model answers again.
- **Scans run beside the worker cycle,** `SCAN_CONCURRENCY` at once (default 2; agentic scans one at a time), instead of one per cycle. A project with no code files finishes at once. The Projects page shows a queued scan's place in the queue. A model timeout while a scan holds the model is not counted against the turn or feedback waiting behind it.
- **Comments skipped before the classifier,** with the rule recorded: bots, the pull request author's replies to another reviewer ("Fixed in <sha>"), the author's whole-comment status notes ("Resolved", "Closing: ...") and bare "@claude review" triggers. Comments are labelled human, bot or agent (`GITHUB_BOT_LOGINS`, `GITHUB_AGENT_LOGINS`), and the classifier sees the review verdict, so nits in an approving review are not pushback. Settings lists the rules.
- **Settings:** select all, none, the folders shown, or the folders with sessions.

### Changed
- `/api/status` reports the docs reader's model as a job of its own (`docs`).
- **The code map keeps what matters when it is capped:** files your sessions edited, then source, before tests, manifests, docs and the rest, instead of the first files alphabetically. `SCAN_MAX_FILES` unset now scales with the repo (40% of the files worth mapping, from 400 to 4000). The code map card and Code mode say when a map is capped ("Showing 400 of 10,290 files") and how to raise it. Docs and config files no longer rank as hotspots unless a miss touched them. Code mode labels files with their names.
- **Large files are read in parts** split where their top-level functions and classes start (up to four), instead of being cut at 24,000 characters. Agentic scans report the files the model cited as files scanned.
- **Every Ollama call has a length limit and a repeat penalty** (`OLLAMA_NUM_PREDICT` 2048, `OLLAMA_REPEAT_PENALTY` 1.1), so a model stuck repeating itself stops early. `OLLAMA_TIMEOUT_SECONDS` sets how long one Ollama call may take (default: each job's own limit). Embeddings use nomic-embed-text's real context size.
- **Sync now with nothing stored** says nothing was sent, instead of "Sent 0 projects".
- `CLOUD_URL` may be `http://host.docker.internal:<port>`, for a Feedback Graph Cloud on the same machine.
- GitHub and Linear tokens from `.env` are checked on first use and show the account, instead of "not checked yet".
- The Inbox keeps its order while new items arrive. A change made while the API restarts is retried a few times (never uploads, imports, deletes, cleanup or a cloud sync), or shown as not saved.
- Transcripts are re-read once (ingest version 3) to remember each Claude Code conversation's fingerprint.
- Postgres adds migrations `0016_relevance_pins_links_docs.sql`, `0017_lesson_decided_by.sql` and `0018_code_map_candidates.sql`.

### Fixed
- **One turn can no longer stall the pipeline.** A model call that times out counts against that turn (or post-mortem, summary, document or scan), which is skipped after its attempts, and the rest of the batch goes on. A model that cannot be reached still pauses without counting.
- **Answers wrapped in prose or code fences are read,** and an unusable answer is asked again once, more strictly. A failure shows the end of what the model returned (redacted).
- **Codex copies of Claude Code conversations are no longer ingested twice.** Duplicates already in the graph stay; reject their Inbox items as usual.
- **A comment with no matching agent session** is post-mortemed from the comment alone, and its lesson never takes another session's file paths. A session found by time alone is not linked when it ran on another branch or never touched the commented file.
- **Proposed lessons are checked for scope:** paths outside the repo are dropped, a universal rule drawn from one nit is narrowed to the task, and lessons about how to treat feedback are flagged (`lessonChecks` on the post-mortem activity). You still approve every lesson.
- Pasted errors, logs and long explanations no longer trip the "wtf" / "why is" keyword signals.
- Go projects: `go.mod` is read, so Go imports resolve in the code map.
- `git status` on a large or mounted repo gets more time, and falls back to skipping untracked files.
- Codex ending an MCP session gets 204 instead of a 415 error.

## 0.4.4 (2026-10-24)

### Added
- **Claude Code plugin** (`plugin/`, with a marketplace at the repo root: `/plugin marketplace add ChaosDeSelva/Feedback-Graph`, then `/plugin install feedback-graph@feedback-graph`). It bundles the MCP server, the skills and four hooks: on each request the task's lessons, past misses and code map are added as context (once per session, then only for lessons not yet shown); before the first edit of a file, its lessons and misses when it has any; before Claude stops, once, a request to run `check_before_done` if it changed files or committed since the last check; after `/clear` or a compaction, what was shown is forgotten. Hooks act only in selected projects, only read, and stay silent when the Feedback Graph is unreachable. `FEEDBACK_GRAPH_URL`, `FEEDBACK_GRAPH_TOKEN`, `FEEDBACK_GRAPH_HOOKS=off`.
- **`test-from-feedback` skill:** turns the approved lessons and past misses on the code being changed into test cases, runs them with the tests `impact` lists, and reports which lesson each guards.
- `GET /api/agent/project?cwd=`: whether a folder is a selected project (read-only; for the hooks).

### Changed
- The skills moved from `skill/` to `plugin/skills/`. `install-agent.sh claude` links them from there (and links the new skill); re-run it once after pulling so the old links are replaced. With the plugin installed, it leaves Claude Code alone, so the tools are never registered twice.
- **PR descriptions and Linear tickets are read as context.** A comment's Inbox item and its post-mortem show the pull request's description, or the ticket's description, state, priority, labels and assignee.

### Fixed
- A comment is linked only to an agent session that did the work (edited files or ran `git commit`), not one that only read the repo. Transcripts are re-read once to record this. Postgres adds migration `0015_session_work.sql`.
- **Ticket and PR text cannot pose as instructions to the post-mortem.** Descriptions are fenced as untrusted, and lines in them (or in comments) that start like the prompt's own section markers are quoted. Ticket state, priority, assignee and labels are redacted and capped like the description.

## 0.4.3 (2026-10-24)

### Added
- **GitHub and Linear comments in the Inbox.** Settings has an **Integrations** section: paste a GitHub token (fine-grained, Pull requests and Issues read-only) or a Linear API key, checked with one read-only call and saved only if it works, in `state/settings/integrations.json` (mode 600, `INTEGRATIONS_FILE`; never the database, never returned). `GITHUB_TOKEN` / `LINEAR_API_KEY` in `.env` still work, win, and show as "set in .env". Each selected project with a github.com remote is linked to its repository (`GITHUB_REPOS` overrides; per-project on/off), and each can be mapped to a Linear team. Every `INTEGRATION_SYNC_MINUTES` (10) the worker reads new review comments, review bodies and PR conversation comments, and comments on the team's issues (people only; the first sync goes back 14 days), stores each PR or issue as a stand-in thread, and the classifier labels each comment like a transcript turn; pushback and corrections become Inbox items marked GitHub or Linear, with author, link, title, and file, line and diff lines for review comments. Each is linked to the agent session that likely did the work (same branch, or the only session just before), whose turns, edited files and summary its post-mortem reads; with none, it works from the comment alone. A revoked token pauses that service until replaced, a rate limit until it lifts. The Inbox has a source badge and a source filter. The sidebar shows a connections list (GitHub, Linear, Claude, Codex, Ollama, cloud sync), from a new `connections` field on `/api/status`. New routes under `/api/settings/integrations` (writes owner-only). Postgres adds migration `0014_external_feedback.sql`.

### Changed
- **`setup.sh` fixes what it finds.** In a terminal it offers, each as a yes/no question, to pull a missing Ollama model, to save a pasted `claude setup-token` token to `.env` (hidden as you type, validated, file kept mode 600) so post-mortems run on Claude while classifying, summaries and embeddings stay on Ollama, to start the stack and wait until it answers, and to run `install-agent.sh`. Without a terminal it only reports, as before.
- **Cleaner root suggestions.** Folders sessions ran in outside the roots skip temporary folders (`/tmp`, `/private/tmp`, `/var`) and agent worktrees; a suggestion inside another folds into it, and three or more side by side are offered as the folder holding them.
- **Project roots are edited in Settings, and there is no default root.** `docker-compose.yml` no longer mounts `PROJECTS_DIR` (default `~/code`) or the bundled `examples/` folder: `./scripts/setup.sh` always writes `docker-compose.override.yml` with exactly the folders you chose, at `/roots/1`, `/roots/2`... (zero is valid: everything starts, with no projects). In Settings, **Where folders come from** lists the roots with Remove (after a confirm step), an **Add folder** field, and the parent folders of sessions that ran outside every root with their session counts, each with **Add as root**. Saving writes `state/settings/project-roots.json` (the api mounts only `./state/settings`) and logs a `roots_saved` activity; until `./scripts/setup.sh` remounts and restarts, Settings shows the command with a copy button. With no root at all, the header and Inbox say to add a project folder in Settings first. New: `PUT /api/settings/roots` (owner-only), and `pendingRoots`, `rootsEditable` and `outsideRoots.folders` on `GET /api/settings/projects`. Postgres adds migration `0013_roots_saved.sql`.
- **Upgrading:** run `./scripts/setup.sh` once after pulling (not only `docker compose up`): it reads `PROJECTS_DIR`/`PROJECTS_DIRS` from your `.env` and mounts them through the override; without it the containers start with no project folder. The examples folder is no longer mounted; add it in Settings if you want the demo project. `PROJECTS_DIR` and `FEEDBACK_TOOL_DIR` are no longer read by compose.

### Fixed
- **Only the projects you selected are shown.** Every page but Settings listed every known project and every folder under the roots, and the Inbox, Lessons, Activity, Patterns, Graph and Sessions showed data of projects that were never selected (read before opt-in existed). The API now applies the selection to every list (`/api/projects`, `/api/candidates`, `/api/stats`, `/api/lessons`, `/api/activity`, `/api/patterns`, `/api/sessions`, the code map) and answers 404 for an item of any other project; a clone folder follows its project, and before a selection is saved nothing is shown (the pages point to Settings). A global lesson counts as data of the project it was learned in, so one learned in an unselected project is hidden and is no longer served to agents by `get_task_context`, `check_before_done`, `get_module_context` or `impact`. Settings still lists every folder, and stored data is left alone (**Clean up** removes it). The stores take a `projectKeys` filter, covered by a contract suite on both backends; no migration.
- **Removing anything asks first, in the app.** Removing a document, deleting a project's data, cleaning up unselected projects and revoking an approved lesson open a confirm dialog that names what goes, with Cancel focused and Escape or a click outside cancelling. Leaving unsaved edits asks in the same dialog instead of the browser's prompt.

## 0.4.2 (2026-10-23)

Two gaps left by 0.4.1: a final reply that arrives late is now summarized, and no prompt-only job runs an agent CLI in the worker's folder.

### Fixed
- **A late final reply is summarized.** A summary update that reached the last turn early (a `SUMMARY_MAX_DELTA_TURNS` update while the agent was still answering) left the agent's final reply, stored on the next read, unsummarized: nothing triggered another update. Each session now records which final reply its summary took in; a newer one is sent alone, with the previous summary, once the session is quiet (or when it is idle), and the cursor stays on the last turn. A rebuild clears the record unless it reaches the reply. Sessions summarized under 0.4.1 that have a final reply get that one small update. Postgres adds migration `0012_final_reply_summarized.sql`.
- **`CLASSIFY_LLM=claude-cli` or `codex-cli` no longer sees the worker's files.** Classification gave the CLI no folder, so it worked in the worker's own one (codex-cli copied it into its mirror), as summaries did before 0.4.1. Every job that sends only a prompt (classification, summaries, one-file fact extraction, the `check_before_done` judge) now goes through one helper, `askPromptOnly` in `packages/core/src/llm`, which gives an agent CLI a fresh empty folder and removes it afterwards. The claude-cli and codex-cli providers also use a fresh empty folder whenever a request names none, so a new job cannot fall back to the process's folder. Post-mortems and whole-repo scans still run in the repository.

## 0.4.1 (2026-10-23)

A security fix for the graph tooltips, the summary model in the health report and kept out of the worker's files, and summaries that read how a session ended.

### Added
- **The summary model is in the model health report.** `/api/status` lists `summary` beside `classify`, `postmortem` and `scan`, with its provider, `ok` and the reason it could not be asked (a provider that could not be built says so); `SUMMARY_LLM=off` is reported as `off: true`, not as a problem. The header badge says **summaries paused** while the summary model is down, and the "Ollama is not reachable" hint names `SUMMARY_LLM` with the other job settings.
- **Include tests on Patterns.** The "Where agents struggle" card has the **include tests** toggle (`tests=1`), like the Projects code map and the Graph's Code mode.
- **Summaries take in the agent's last answer.** The agent's reply after the last human turn was never stored, so a summary missed how a session ended. Claude Code and Codex sessions now keep it (redacted, the last 2,000 characters) on the session, not as a turn, so it is never classified and never becomes an Inbox item; the summary update that reaches the last turn reads it after that turn. `TURN_RETENTION_DAYS` removes it with the session's turns, and it is never exported or synced. Postgres adds migration `0011_session_final_reply.sql`.

### Fixed
- **Graph tooltips escape what they show.** The force graph renders node and link labels as HTML, and labels carry feedback text, lesson titles and file paths from transcripts and model output: a label like `<img src=x onerror=...>` ran in the page on hover. Every value in the Evidence and Code graph tooltips is now escaped.
- **`SUMMARY_LLM=claude-cli` or `codex-cli` no longer sees the worker's files.** The summary job gave the CLI no folder, so it worked in the worker's own one (codex-cli copied it into its mirror). A summary needs only its prompt: each request now runs in an empty scratch folder, removed afterwards.

## 0.4.0 (2026-10-23)

Sessions get running summaries that grow with them: the worker keeps a cursor per session and folds only the turns after it into the summary, and a session quiet for half an hour is marked idle until it continues; a new Sessions page, an MCP tool and task context show them, and they never leave the machine. codex-cli can run confined in its own codex-runner container, which holds only the Codex CLI, your Codex login and a copy of the repository. Git repos nested in a folder that is not a repo become projects of their own, the containers run as any host uid, scans back off during an outage, and cloud sync remembers what the cloud accepted across restarts. The code map gains a Code mode on the Graph page, GDScript and Swift module links, and hotspots that leave test files out by default.

### Added
- **Session summaries.** Every session of the selected projects gets a running summary: goal, what was done, decisions, open threads, pushback, files touched and outcome (structured, plus a short markdown rendering). The worker's new summarize stage keeps a cursor per session (the last turn summarized, by index and time): when a session has been quiet for `SUMMARY_QUIET_MINUTES` (10) or `SUMMARY_MAX_DELTA_TURNS` (40) turns are waiting, it sends only the turns after the cursor, with the previous summary, and stores the merged summary the model returns (`SUMMARY_LLM`, default the local Ollama model; zod-checked, asked again once, then backed off; an unavailable model moves nothing). Big deltas are summarized in parts, then merged. Quiet for `SESSION_IDLE_MINUTES` (30), a caught-up session is **idle**; a new turn makes it active again. Existing sessions are backfilled newest first, `SUMMARY_BACKFILL_PER_CYCLE` (3) per cycle. Each update is kept in the session's history and logged in Activity as **session summarized**. A new **Sessions** page (Insights) lists them by project and state, with each summary, its update history, files touched, and links to the Inbox items and lessons from the session; **Rebuild summary** starts again from the first turn. Agents get `get_recent_sessions`, `get_task_context` lists the three most recent sessions, and post-mortems read the summary of their session. Summaries are redacted before they are stored, never exported or synced, and deleted with their project; `TURN_RETENTION_DAYS` keeps a turn's text until a summary covers it and never removes a summary. `SUMMARY_LLM=off` turns it off. REST: `GET /api/sessions`, `GET /api/sessions/<id>`, `POST /api/sessions/<id>/resummarize` (UI only). Postgres adds migration `0009_session_summaries.sql`.
- **codex-cli runs confined, in its own container.** With `CODEX_RUNNER_URL=http://codex-runner:8790` and `codex` in `COMPOSE_PROFILES`, Codex jobs run in the new codex-runner service, which holds only the Codex CLI, its own Codex home with your login file, and a scratch volume where the worker puts each job's copy of the repository: no transcripts, projects, state or secrets, no published port, read-only root, no capabilities. The worker sends each job with a random token the runner writes into the scratch volume at startup; the runner refuses folders outside the volume, runs one job at a time, enforces the timeout and kills codex's process group. `ALLOW_UNCONFINED_CODEX` is then not needed; without the runner, that gate is unchanged. See docs/operations.md, **Running codex-cli confined**, and SECURITY.md.
- **Repos nested in a folder that is not a repo are projects of their own.** A top-level folder holding git repos one or two levels down (`~/src/github.com/org/repo`, `~/code/client/app`) lists each repo in Settings as a project (`github.com__org__repo`); a session belongs to the deepest repo it ran in. Plain folders stay top-level projects, and a folder already selected or excluded as a whole stays one project.
- **`install-agent.sh --help` and `--dry-run`.** The dry run prints what would change (links, `claude mcp add`, Codex files) and writes nothing.
- **`CLAUDE_PROJECTS_DIR`** points at Claude Code transcripts kept somewhere other than `~/.claude/projects`, like `CODEX_SESSIONS_DIR` for Codex.
- **Code mode on the Graph page.** Per project, the code map drawn: the top 60 files by hotspot score (sized by score, red when misses touched them) and their hottest neighbours, import and test edges, and the misses and approved lessons on those files; a note says when the graph is capped. Clicking a file opens the same module panel as Projects. REST: `GET /api/projects/<key>/codemap/graph?limit=60[&tests=1]` (selected projects only, like the other code map routes).
- **GDScript and Swift modules in the code map.** `.gd` files get symbols (top-level `class_name`, `class`, `enum`, `func`, `signal`, `const`, `var`; exported unless the name starts with `_`) from a line-based reader, and their `preload`/`load`/`extends` paths (`res://` from the folder holding `project.godot`) and class_name references become edges. A Swift `import` of a local module (a `Package.swift` target or a `Sources/<Module>/` folder) links to that module's files instead of `pkg:`.

### Changed
- **Hotspots leave test files out by default.** Tick **include tests** on the Projects code map (or the Graph's Code mode), or pass `tests=1` to `GET /api/projects/<key>/codemap/hotspots` and `GET /api/codemap/hotspots`. The export still carries every file's numbers.

### Fixed
- **MCP Activity names the agent.** `context served`, checks and reports said `agent (MCP)` for every client; they now say the client's name and version from its `initialize` (e.g. `claude-code 2.1.309 (MCP)`).
- **`CHECK_LLM=claude-cli` or `codex-cli` is refused with a reason** instead of silently judging with the local Ollama model: `check_before_done` is judged in the api, which has no agent CLIs.
- **Linux with a uid other than 1000.** The worker, api and codex-runner run as `HOST_UID:HOST_GID` from `.env` (setup.sh fills them in), with a `HOME` and Codex login volume any uid can write; `scripts/check-uid.sh` (in `check.sh`) runs the worker image as uid 1234 in Docker and checks it writes `worker.sqlite`.
- **Scans back off during an outage.** A scan whose model cannot be asked waits two minutes between tries and never uses an attempt; a real failure is retried after 5 and 10 minutes and failed after the third (Postgres: migration `0010_scan_attempts.sql`).
- **Cloud sync remembers across restarts, and takes back unselected projects.** What the cloud last accepted is kept in the store, shared by the worker's schedule and Sync now; a project you stop syncing gets one last bundle that withdraws what was sent for it. `scripts/cloud-sync-e2e.sh` uses its own test containers and handles the cloud's review gate.
- **A graceful stop never closes the store under a code map write**: a map being parsed is abandoned, one being written is waited for.
- **First-run and script fixes.** `PROJECTS_DIRS=~/code ./scripts/setup.sh` writes `PROJECTS_DIRS` to `.env`; an empty `~/.codex/sessions` no longer makes `install-agent.sh` set up Codex (it looks for the CLI, `config.toml` or `auth.json`); `backup.sh`, `restore.sh` and `demo-pushback.sh` no longer need Node on the host; the README documents `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT` and `API_PORT`, and says Ollama must be running before `ollama pull`.
- **`SYNC_SUGGESTIONS=true` now takes effect.** `docker-compose.yml` did not pass it to the api and worker, so suggestions were never sent whatever `.env` said. A test now checks that every key in `.env.example` reaches `docker-compose.yml`.
- **With `API_TOKEN` set, the api container is healthy.** `GET /api/ready`, which the compose health check calls, is open like `/api/health` (it says only `ok` and the store).
- **`install-agent.sh` and `setup.sh` follow `API_PORT`.** Without `FEEDBACK_GRAPH_URL`, the MCP server is registered at `http://localhost:<API_PORT>/mcp` from `.env` (an `API_BIND` other than loopback or `0.0.0.0` is used as the host), and `setup.sh` prints the real UI address.
- **Ollama not running is named.** The MCP tools (`get_task_context`, `check_before_done`) and the worker say `Ollama is not reachable at <url> (<model>, <code>)` and how to fix it, not a bare `fetch failed`. `/api/status` has an `ollama` field (`url`, `ok`, `reason`, from a ping of Ollama's `/api/tags` that also checks the embedding model is pulled); while Ollama does not answer, every `ollama:` job model is reported unavailable even before a job tried it, and the UI header says **Ollama unreachable**.

## 0.3.0 (2026-10-23)

Your choice of what is read, and of what is shared. Nothing is read until you select project folders in Settings, and optional team sync to a Feedback Graph Cloud org sends only the lessons you approved unless you opt in to suggestions. Codex joins Claude Code as a source of sessions and as an agent that gets the lessons, a code map links misses to the files they touched and gives agents module context, impact and file-aware checks, Postgres runs as an alternative backend behind the same contract tests, and export bundles can be imported on another machine or backend. Setup asks for your project folders instead of assuming one, and a model that is down no longer uses up classification tries or fails post-mortems and scans.

### Added
- **Team sync to Feedback Graph Cloud (optional, off by default).** With `CLOUD_URL` and `CLOUD_TOKEN` set, your project knowledge is pushed to a cloud org: **Sync now** on the new Cloud sync card in Settings, or every `SYNC_INTERVAL_MINUTES` from the worker; `SYNC_PROJECTS` narrows the selected projects. Each project goes as its export bundle, rebuilt field by field: key and git remote, its lessons, misses without the quoted feedback or excerpts, current facts, document metadata and code map hotspot numbers; never transcripts, source, document text or embeddings. Each bundle is the whole project and says `complete: true`, and lists in `withdrawn` what was sent before and is gone now, so the cloud follows your decisions: approved lessons become the team's, a lesson you reject, supersede or move back to proposed demotes the team copy, and deleted lessons, misses, docs and fact files leave the team graph; a selected project that now holds nothing is sent as an empty complete bundle. Nothing is shared without your approval: a bundle carries your approved lessons plus the current status of any lesson the cloud already received; a lesson you never approved stays on your machine unless you set `SYNC_SUGGESTIONS=true`, which sends proposed ones as suggestions for an admin (the Cloud sync card says which applies). https only (http only to localhost), redirects refused, 429 (another sync of the org running) waits the `Retry-After` (seconds or a date; longer than a minute fails that project until the next run), 5xx retried with backoff, 401/403 stop the run, failed scheduled runs back off up to a day. Each run is logged in Activity as **cloud sync** (counts, projects, the cloud's host); the worker heartbeat reports the last result and next run; `/api/status` reports `cloud` with the token redacted. Cloud tokens (`fgc_pat_...`) are redacted everywhere. REST: `GET /api/cloud`, `POST /api/cloud/sync` (UI only). Postgres adds migration `0008_cloud_sync.sql` (the new Activity kind). `scripts/cloud-sync-e2e.sh` checks the sync against a real cloud in Docker.
- **Codex can use the lessons.** `scripts/install-agent.sh` sets up Codex as well as Claude Code (each one it finds, or the one you name): the `feedback-graph` MCP server in `~/.codex/config.toml` over streamable HTTP, with the `API_TOKEN` bearer header when set, and the skill's guidance in `~/.codex/AGENTS.md` between markers. Existing config is never overwritten: files are backed up before they change, and re-running adds nothing twice. README **Connect your agents** and the Docs page cover both.
- **More than one projects folder, and a first run that asks.** `PROJECTS_DIRS=~/code,~/work` in `.env` (or answered to `setup.sh`) mounts every folder through a `docker-compose.override.yml` that `setup.sh` generates, so `docker-compose.yml` is never edited. `setup.sh` asks for the folders, suggesting the ones your Claude Code sessions ran in (no more silent `~/Vibe` default), creates `./state`, `~/.claude/projects` and the Codex sessions folder so Docker does not create them as root, checks that Ollama answers and has both models (with the `ollama pull` to run), and on Linux explains `OLLAMA_HOST=0.0.0.0` and the uid the containers run as. `POLL_SECONDS`, `CLASSIFY_BATCH`, `SCAN_MAX_FILES` and `SCAN_MAX_BYTES` now reach the worker from `.env`; `COMPOSE_PROFILES=postgres` replaces `--profile postgres` on every command.
- **Import an export bundle.** Projects → **Import bundle**, or `POST /api/import` (yours only, from the UI). The bundle's `schemaVersion` is checked, it is validated, size-limited (50 MB) and redacted again. Lessons are matched by id (importing twice changes nothing and never overrides your decision), re-embedded with the current model, and arrive proposed unless you keep them approved (`?keepApproved=1`); facts go into projects with none yet. `EXCLUDE_PROJECTS` is respected. Logged in Activity as **bundle imported** (Postgres: migration `0007_import.sql`). Moves lessons between machines and between the Neo4j and Postgres backends.
- **Code map, linked to misses.** The worker parses each selected project's code into files, symbols, imports, the tests covering each file and 90-day churn, and keeps it current beside ingest (at most every five minutes, only when the repo changed, incremental, bounded by `SCAN_MAX_FILES` / `SCAN_MAX_BYTES`; a Scan maps its project first). Each build is logged in Activity as **code mapped**. Ingest records which repo files each session read and edited, so every miss is linked to the files its session edited and to where the fix landed. The store answers, per file, its symbols, importers, imports, tests, facts, misses and approved lessons; the impact of changing files (dependents by depth, tests to run, misses and lessons on them); and a project's hotspots (misses, churn and dependents, with the score). Export adds `codeFiles` (paths and hotspot numbers only). The first start after upgrading reads the selected projects' transcripts once more to record touched files (idempotent).
- **Agents use the code map.** Two new MCP tools: `get_module_context` (one file: code facts, exported symbols, importers, imports, tests, and the approved lessons and past misses tied to it, with citations) and `impact` (dependents of a set of files with their distance, the tests to run, lessons and misses on all of it). `get_task_context` adds a short code map section for the files the agent names, and `check_before_done` takes `files_changed`: for each changed file it lists the importers and tests the change did not touch and what the last misses there were about. Each call is logged in Activity. The skill tells agents when to call them.
- **Code map in the UI.** Projects shows each project's code map (files, symbols, edges, last build) with a sortable hotspots table; clicking a file opens its module panel (symbols, importers, imports, tests, facts, lessons, misses) with links to the lesson and the Inbox item. Patterns gains **Where agents struggle**, the top hotspots across the selected projects. Links of the form `#lessons/<id>` and `#inbox/<id>` open that item. The Docs page explains the code map, the two tools and how hotspots are scored. Read-only REST: `GET /api/projects/<key>/codemap/{hotspots,module,impact}` and `GET /api/codemap/hotspots`.
- **Lessons scoped to files.** A post-mortem sees the files the session edited before and after the feedback, and proposes its lesson with the narrowest paths the evidence supports.
- **`get_task_context` takes `files`:** the files the agent expects to touch. Approved lessons whose paths cover them, or whose miss edited them, come first and say which files they touch. The skill tells agents to pass them.
- **Postgres storage.** The tool can run on Postgres 17 with pgvector instead of Neo4j: `STORE=postgres` (with `DATABASE_URL`, or `POSTGRES_PASSWORD` and the bundled service) and `STORE=postgres docker compose --profile postgres up -d`. The same api and worker code runs on either through one storage interface, and one contract test suite runs against both backends in `scripts/check.sh` and CI. Neo4j stays the default; nothing changes for existing installs. `/api/ready` and `/api/status` report the store (`"store": "neo4j"`). Postgres backups use `pg_dump` (docs/operations.md). `DATABASE_URL` is validated at startup with every other setting, and its password is never logged.
- **Codex sessions.** `~/.codex/sessions` (`CODEX_SESSIONS_DIR`) is mounted read-only; Codex CLI / Desktop sessions of selected folders go through the same pipeline as Claude Code's (redaction, classification, Inbox, post-mortem), streamed line by line, with per-file cursors. Sessions and Inbox candidates carry `source: 'claude' | 'codex'`. Agent CLIs are denied `/codex-sessions`.
- **Project candidates and selection API** for the Settings page: `GET /api/settings/projects` (every folder under the roots with its git remote, Claude Code and Codex session counts, last activity, selection, exclusion, alias and whether it has data; missing folders; a count of sessions outside every root), `PUT /api/settings/projects`, and `POST /api/settings/cleanup` (`{"confirm": "remove-unselected"}`) to delete the data of unselected projects. Writes are yours only, from the UI, and logged in Activity (**projects selected**, **unselected data removed**).
- **Projects are identified by their git remote,** not only by folder name. The worker reads each project's `origin` (only when the folder is itself a repo root), stores it normalized with credentials stripped (`github.com/org/repo`, `local/<name>`), and fills it in for existing projects on the next cycle without re-ingesting. A new folder holding a clone of a known remote is recorded under the existing project as an alias, logged in Activity as **project alias**; MCP calls from that folder resolve to the existing project. The Projects page shows the remote under each name, and the export bundle carries `projects: [{key, remote}]` (still `schemaVersion: 1`: the field is additive).

### Changed
- **One miss, one Inbox item.** When the detector flags pushback and an agent also reports it with `report_feedback` (within 60 minutes, same project, similar words or the same session), the two become one Inbox item that keeps both sources: candidates carry `origins` (`detector`, `agent`) and `agentReport`. A report made first is moved onto the transcript turn once the detector finds it, so its post-mortem sees the whole session. `report_feedback` takes an optional `session_id`. The skills now call `report_feedback` only for `/postmortem` and for misses the developer did not state in words, and no longer assume projects live under one folder. The Inbox shows such an item's report (**Reported by the agent**, and **and found by the detector** when both flagged it, with the agent's words and what it had done), and the worker's **candidate flagged** Activity entry links to the merged item. Postgres migration `0006_candidate_reports.sql`.
- **Feedback memories are imported as proposed lessons,** not approved ones: they wait in Lessons for your approval like a post-mortem's lesson, and are not served to agents until then. `MEMORY_AUTO_APPROVE=true` restores approving them on import. A memory lesson you have edited, approved or rejected is never changed by a later version of its file (as before); a proposed import has no decision time. Memory lessons imported before this change keep their status.
- **Post-mortems read AGENTS.md.** Besides CLAUDE.md (now in every parent folder up to the project root, not only the one above the repo) and Claude Code memory, a post-mortem reads AGENTS.md in the repo and its parents, labelled by source. For a Codex session AGENTS.md is what the agent had loaded and CLAUDE.md and memory are not; for Claude Code the reverse. Only a file the session's agent loads counts as available context. Context items gain the kind `agents_md` (Postgres migration `0005_agents_md.sql`).
- **You choose which project folders are read; nothing is read until you do.** The tool no longer ingests every project it finds. The selection is stored in the graph and gates ingest, memory import, scans, GitHub sync and MCP context. On upgrade, `INGEST_PROJECTS` seeds it (an install with `INGEST_PROJECTS=demo-shop` keeps reading exactly demo-shop); with it empty, nothing is selected, Activity logs it, `/api/status` carries `selection` and the header says **no projects selected**. From then on `INGEST_PROJECTS` is only that seed. `EXCLUDE_PROJECTS` remains a hard deny that the selection cannot override.
- `PROJECTS_DIR` now defaults to `~/code` in `docker-compose.yml` when it is not set, and `scripts/setup.sh` asks instead of assuming a folder. An existing `.env` that sets it is unaffected.
- Vulnerabilities are reported through GitHub private vulnerability reporting (SECURITY.md), with a first answer within 5 working days.
- New `NOTICE` listing the third-party fonts, tree-sitter grammars and libraries in the built UI and runtimes and their licenses; the images carry `LICENSE` and `NOTICE`. New [docs/editions.md](docs/editions.md) says what the open-source edition covers. The README opens with a public introduction and a quickstart from a fresh clone.
- **Upgrading keeps serving your lessons.** With `INGEST_PROJECTS` empty, the first start after upgrading selects the projects that already hold approved lessons, confirmed feedback, docs or scans (never an excluded one) instead of nothing, so MCP keeps serving what you approved; Activity lists them and says why. A new install still starts with nothing selected.
- **Global lessons reach every folder you have not excluded.** `get_task_context` and `check_before_done` in a folder under a root that is not selected now serve the global approved lessons (and nothing of the folder's own; reading its sessions stays opt-in). The "not a tracked project" answer now points to Settings.
- Changing `INGEST_PROJECTS` / `EXCLUDE_PROJECTS` no longer forgets every transcript cursor. Transcript cursors moved to a new table, so the first start after upgrading re-reads the selected projects' transcripts once (idempotent).

### Fixed
- **Selecting a second clone of a project you had not selected** no longer drops its sessions, marks them read, and leaves Settings unable to save. A clone follows its project: Settings shows it as a clone before anything of it is read, ticking it selects that project, and it is never made an alias of a project you have not selected. A folder saved before it became a clone or was excluded is dropped when you save (logged in Activity), never a reason to refuse the save.
- **Cleanup kept deleting data you selected:** memory lessons and docs filed under a selected project's clone folder are now kept.
- **A project cleaned up (or deleted while unselected) and selected again** has its whole history read again; before, only files that changed afterwards were.
- **Cleanup during a running ingest cycle** could have the cycle write the deleted project back. Each transcript is now written under a store-wide lock, against the selection as it is at that moment, and cleanup and project delete take the same lock.
- **Codex sessions that moved into a selected folder** after starting elsewhere were never read; they are now read for the turns in the selected folder, and counted in each folder they were in.
- **The first message after a Codex cwd switch** is now classified (it was skipped as if it opened the session).
- **Postgres: pgvector older than 0.8** made every vector search fail; startup now refuses it with the version found and how to upgrade. 0.8.0 is the documented minimum.
- **`reembed` after a crash** resumes where it stopped instead of re-embedding everything again (both stores).
- **A missing or unreachable model no longer uses up classification tries.** The classifier now tells a model it could not ask (connection refused, DNS, timeout, HTTP 5xx, model not found, not authorized or rate limited, CLI not installed or not signed in) from an answer it could not label. Only the second counts against a turn. When the model is unavailable, classification pauses for the cycle, the worker's last error reads `classifier unavailable: <reason>`, `/api/status` carries `models` (each job's model with `ok` and `reason`, post-mortem and scan included) and the sidebar badge says **classifier unavailable** (or **post-mortem model unavailable** / **scan model unavailable**) in its label. Turns given up on before this fix (or for any other reason) can be re-queued: the empty Inbox offers **Re-queue N turns that were given up**, owner-only (`POST /api/turns/requeue`), logged in Activity as **turns re-queued**; `/api/status` counts them (`givenUpTurns`). Postgres adds migration `0004_turns_requeued.sql` for the new Activity kind.
- **Post-mortems and scans no longer fail for a model that is down.** As for classification, a post-mortem whose model (or embedding model) could not be asked is not charged an attempt and the rest of the batch waits for the next cycle, and a scan goes back in the queue (its error says why) instead of failing, then runs once the model answers. The worker's last error reads `post-mortem model unavailable: <reason>`.
- With nothing selected, the empty Inbox and the MCP "not a tracked project" answer point to the Settings page.
- Postgres: text with NUL characters (seen in transcripts) failed to store; it is now stored without them, everywhere.
- The worker image installed whatever `@anthropic-ai/claude-code` and `@openai/codex` were newest at build time; they are pinned (Claude Code 2.1.309, for the confinement flags below, and Codex 0.162.0). `backups/` and the generated override are kept out of the Docker build context.
- `backup.sh` and `restore.sh` only knew Neo4j: on `STORE=postgres` they stopped the stack and dumped an empty Neo4j volume. They now read `STORE` from `.env`: on Postgres, `pg_dump -Fc` of the bundled service or of `DATABASE_URL` with nothing stopped, and a restore that replaces the schema in one transaction, with `state.tgz` and checksums as before. A backup records its store, a restore refuses the other store's backup, and a misconfigured `.env` is refused with a message.
- The per-project code map routes (`/api/projects/<key>/codemap/*`) answered for any project key; they now answer only for selected projects that are not in `EXCLUDE_PROJECTS`.
- `STORE=postgres` with the bundled service and an empty `POSTGRES_PASSWORD` failed later with an authentication error; startup now names `POSTGRES_PASSWORD`.
- The code map's repo check ran `git status` with optional locks on a read-only mount, and a `git status` that timed out made a dirty tree look clean. It now runs with `--no-optional-locks`, and a timeout is logged and rebuilds the map on the interval.
- Postgres: vector searches never used their HNSW indexes. They now can (the planner picks them for large projects), with iterative scans so a project's rows are still found when closer rows belong to other projects.
- Settings: a selected folder that later became another clone or was added to `EXCLUDE_PROJECTS` locked the page (it could not be unticked and every save failed). It can now be unticked, its row says why it is not read, and saving drops it. Zero counts, "never" and "not git" are now readable (WCAG AA contrast).
- Leaving Settings with an unsaved selection, or a lesson with unsaved edits (another page, lesson or tab, or closing the tab), now asks first instead of dropping the changes.
- Inbox: a quick `c` then `r` could send two decisions for the same item; one decision now runs at a time. The project filter lists every project and keeps showing the one picked when its list is empty. Errors in Inbox and Lessons clear on the next success, tab or item.
- Graph, Patterns, Activity and the Projects facts and docs cards no longer show a slow answer for a project or filter you have already left.
- The phone menu holds keyboard focus while open and returns it to the menu button when closed.
- The served UI logged a Content-Security-Policy error and fell back to a system font for one subset: the build inlined that font as a `data:` URL, which `default-src 'self'` refuses. Fonts are now always emitted as files, and `check.sh` fails if a build inlines one.
- `get_module_context` listed only the tests with a direct (or one-file) link to the file, so a file reached by tests through more imports showed none while `impact` listed them. It now lists the same tests `impact` does at its default depth (3 hops).
- The code map wrote a project's map beside a cleanup or project delete, so a project deleted while its map was being built could get its map back. The write now runs inside the same store-wide lock, after checking the project is still selected; the parse stays outside it.
- Files that left the code map stayed in the store as empty file entries for good. A new map now removes those nothing else refers to (never scanned, no facts, no session touches), on both backends.

### Security
- **Claude Code agents are confined to the repository.** `claude-cli` now runs with only Read, Grep and Glob, `--restricted` (file tools stay inside the project folder; the repository's own `.claude` settings are ignored) and `--permission-mode dontAsk`, and no longer pre-approves reads anywhere. Its deny rules for the worker's folders were relative paths that matched nothing (`Read(/proc/**)` means the project root's `proc`); they now use absolute paths (`Read(//proc/**)`), and the secret-file rules cover every path on disk too. Before this, a post-mortem agent could read other projects' `.env` files, every transcript, the state database, the Codex login and the worker's environment. The worker image pins Claude Code 2.1.309 for these flags.
- **`codex-cli` needs `ALLOW_UNCONFINED_CODEX=1`.** Codex's sandbox cannot be confined to the repository, so it can read everything the worker can (SECURITY.md lists it). A job set to `codex-cli` without the setting stops the worker at startup with a configuration error; a scan requested with Codex fails and says why.
- **`API_BIND` beyond loopback requires `API_TOKEN`.** Without a token the only guard was the Host header, which any client on the network can set; the API now refuses to start instead. Compose passes `API_BIND` to the api, and outside a container the server listens on `API_BIND` (127.0.0.1 by default) instead of every interface.
- Post-mortem and scan failure messages (which can quote model output) are redacted before they are stored, logged or served, on both backends.
- A `DATABASE_URL` password given as `?password=` is masked in logs and errors like one in the userinfo.

## 0.2.0 (2026-10-22)

Ready to run beyond a single laptop.

### Added
- **Access control.** `API_TOKEN` protects the API, MCP and UI (Bearer header or a sign-in page with an HttpOnly session cookie); `PUBLIC_HOSTS` and `API_BIND` for running behind a TLS proxy. Security headers on every response.
- **Operations.** `/api/ready` (fails while Neo4j is down), `/api/status` and a header badge with the worker's heartbeat, last cycle and last error; graceful shutdown that also stops running CLI agents; JSON access logs; container health checks; `scripts/setup.sh`, `backup.sh`, `restore.sh`, `check.sh`; CI workflow.
- **Validated configuration.** Every setting is checked at startup and all problems are reported at once, by name.
- **Data controls.** Export a project's lessons, misses, facts and docs as a versioned JSON bundle; delete everything learned from a project; `EXCLUDE_PROJECTS`; `TURN_RETENTION_DAYS`.
- **Embedding model safety.** The graph records which model embedded it; a changed `OLLAMA_EMBED_MODEL` is refused with a re-embed command (`pnpm reembed`).
- **UI.** Revoke an approved lesson, restore a rejected one, retry a post-mortem that gave up, see where each confirmed item's post-mortem stands, server error messages instead of status codes.
- Apache-2.0 license, SECURITY.md, CONTRIBUTING.md (DCO).

### Fixed
- Inbox shortcuts fired on Cmd+C / Ctrl+R; decisions could apply to an item other than the one shown after fast navigation (Inbox and Lessons).
- A whole-repo scan could leave a project with no facts after a failure part way; scanning with a different model did nothing on an unchanged repo and left near-duplicate facts.
- Fix commits were matched by comparing timestamps as text across time zones.
- Rejecting feedback you had confirmed still ran its post-mortem.
- The classifier retried unlabelable turns forever, and a hung model stalled a whole cycle.
- A CLI agent that ignored SIGTERM could hang the worker; its child processes held the pipes open.
- Codex could read secret files in the repository; Claude was missing several secret-file patterns; symlinks were followed.
- Redaction missed env-style and quoted config secrets, URL credentials and several token formats, and activity details were redacted as JSON text.
- More than 30 PRs updated between GitHub syncs: the rest were skipped for good.
- Memory import covered only the first project root, ignored `INGEST_PROJECTS`, and stopped on a file deleted mid-read.
- Past misses and code facts reached agents without the untrusted-data fence; a doc title could start its own line.
- A mistyped project key or `cwd` with `..` created junk projects.
- Repeat scan requests queued duplicate scans; Linear search hits from other teams were stored as project docs; uploads with the same name replaced each other silently; document removals were not logged.
- An unreadable transcript was retried every 30 seconds; weekly stats counted session openers.

## 0.1.0 (2026-10-22)

First version: transcript ingest, pushback detection with an inbox, post-mortems, lessons, code facts, docs, GitHub and Linear context, MCP tools and skill, provenance log, graph and patterns views.
