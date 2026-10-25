import type { ReactNode } from 'react';
import { PageHeader } from './ui/PageHeader.tsx';
import { Kbd } from './ui/display.tsx';

const SECTIONS = ['How it works', 'Your first hour', 'Connect your agents', 'The code map', 'Linked projects, uploads and relevance', 'Each page', 'Choosing models', 'Limit what it reads', 'Share with a team', 'When something looks wrong'];
const slug = (t: string) => `doc-${t.toLowerCase().replace(/[^a-z]+/g, '-')}`;

/** How to use the tool, for someone who just opened it. Static: nothing here calls the API. */
export function Docs() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Docs" description="How Feedback Graph works, your first hour with it, and how to connect your agents." />
      <div id="docs-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl gap-8 px-3 py-5 md:px-6">
          <nav aria-label="on this page" className="sticky top-5 hidden w-44 shrink-0 self-start lg:block">
            <div className="mb-2 px-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">On this page</div>
            <ul className="grid gap-px border-l border-line">
              {SECTIONS.map((s) => (
                <li key={s}>
                  {/* Buttons, not #anchors: the hash already names the page. */}
                  <button
                    type="button"
                    onClick={() => document.getElementById(slug(s))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="-ml-px block w-full border-l border-transparent py-1 pl-3 text-left text-xs text-muted hover:border-line-strong hover:text-text"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
      <article className="min-w-0 max-w-[44rem] flex-1 space-y-4 text-[13.5px] leading-relaxed">
        <header className="rounded-md border border-line bg-surface p-5 shadow-card">
          <h2 className="text-[22px] leading-tight font-semibold tracking-[-0.015em] [font-stretch:85%]">Using Feedback Graph</h2>
          <p className="mt-2 text-muted">
            When you push back on a coding agent ("that's not right", "you missed X"), the lesson usually stays in that one session. This tool notices the
            pushback, asks you to confirm it, works out why the agent missed it, and turns that into a lesson you approve. Agents then read your approved
            lessons before they start work and check against them before they say "done".
          </p>
        </header>

        <Section title="How it works">
          <ol className="list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-muted">
            <li><b>Read.</b> Every 30 seconds the worker reads the Claude Code (<Code>~/.claude/projects</Code>) and Codex (<Code>~/.codex/sessions</Code>) sessions of the project folders you selected in <SettingsLink />. Nothing is read until you choose, and nothing is changed.</li>
            <li><b>Map the code.</b> The worker also maps each selected project's code (files, imports, tests, recent churn) and notes which files each session edited, so misses are tied to the files they happened in. No model is involved and no source is stored.</li>
            <li><b>Detect.</b> A local model labels each of your messages. Ones that sound like pushback land in the <b>Inbox</b>.</li>
            <li><b>You confirm.</b> Nothing is learned until you confirm an Inbox item. Rejecting it teaches the detector nothing and costs nothing.</li>
            <li><b>Post-mortem.</b> For confirmed feedback, a model reads the session around it and writes what was missed, why, and a proposed lesson. It also looks for the context that would have prevented the miss (code, past sessions, docs, PRs, tickets), and scopes the lesson to the files the fix touched when that fits.</li>
            <li><b>You approve.</b> Proposed lessons wait under <b>Lessons</b>. Only approved ones are ever shown to agents.</li>
            <li><b>Agents use it.</b> Through the MCP server and skill, agents fetch lessons, past misses and code facts for their task, and check their finished work against them.</li>
          </ol>
          <p className="mt-2 text-muted">Every step writes an entry under <b>Activity</b>, so you can always see what created a lesson or fact, and why.</p>
        </Section>

        <Section title="Your first hour">
          <ol className="list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-muted">
            <li>
              No project folder is mounted until you choose one. If <SettingsLink /> lists none, add the folder that holds your projects under{' '}
              <b>Where folders come from</b>, then run <Code>./scripts/setup.sh</Code> on the host: it mounts exactly the folders you chose, read-only, and restarts the containers.
            </li>
            <li>Open <SettingsLink /> and tick the project folders to read, then press <b>Save selection</b>.</li>
            <li>Check the badge at the bottom of the sidebar says <b>worker running</b>. If it says offline, run <Code>docker compose logs worker</Code>: config problems are listed by name.</li>
            <li>Open <b>Inbox</b> and go through the pending items. Use <Kbd>j</Kbd>/<Kbd>k</Kbd> to move, <Kbd>c</Kbd> to confirm real pushback, <Kbd>r</Kbd> to reject anything else (a new request, a question, a false alarm).</li>
            <li>Wait a few minutes, then open <b>Lessons → proposed</b>. Read each lesson and its evidence. Edit the wording or narrow the scope if needed, then <b>Approve</b> or <b>Reject</b>.</li>
            <li>Open <b>Projects</b>, pick a project and press <b>Scan</b> so agents also get facts about its code.</li>
            <li>Connect your agents (next section) and start a normal task in that project.</li>
          </ol>
        </Section>

        <Section title="Connect your agents">
          <p>From the <Code>feedback_tool</Code> folder run:</p>
          <Pre>./scripts/install-agent.sh</Pre>
          <p className="mt-2">
            It sets up every agent it finds. Claude Code: two skills linked into <Code>~/.claude/skills</Code> and the <Code>feedback-graph</Code> MCP server.
            Codex: the same MCP server in <Code>~/.codex/config.toml</Code> and the same guidance in <Code>~/.codex/AGENTS.md</Code> (both backed up first, and
            never added twice). Add <Code>claude</Code> or <Code>codex</Code> to set up only one. The guidance tells the agent when to call each tool, so you don't have to ask:
          </p>
          <dl className="mt-2 space-y-2">
            <Tool name="get_task_context">At the start of a task: approved lessons, similar past misses, code facts and docs for this project and task. When the agent names the files it will touch, lessons tied to those files come first.</Tool>
            <Tool name="check_before_done">Before claiming done: compares the work against past misses and lists gaps it should address. Given <Code>files_changed</Code>, it also names the importers and tests of those files the change did not touch, and what the last misses there were about.</Tool>
            <Tool name="get_module_context">Before changing a file: what it is, its symbols, who imports it, what it imports, the tests that cover it, and the lessons and misses tied to it.</Tool>
            <Tool name="impact">Before changing files others use: everything that imports them (and how far away), the tests to run, and lessons and misses on all of it.</Tool>
            <Tool name="report_feedback">For <Code>/postmortem</Code>, or a miss you did not put in words: sends it to your Inbox. Pushback you typed is flagged from the session anyway; a report of the same moment joins that Inbox item.</Tool>
            <Tool name="get_recent_sessions">When picking up work: the newest session summaries of this project (goal, what was done and decided, open threads, pushback, files). Task context also lists the three most recent in one line each.</Tool>
            <Tool name="search_graph">Searches lessons and past misses by meaning.</Tool>
          </dl>
          <p className="mt-2">
            If the detector missed some pushback, type <Code>/postmortem what it missed</Code> in Claude Code. It goes to the Inbox like any other item.
          </p>
          <p className="mt-2">
            These tools only read and report. To let an agent or a script make some of your decisions (choose projects, start scans, confirm Inbox items),
            set <Code>FG_OPERATOR_TOKEN</Code> in <Code>.env</Code> and use <Code>./scripts/fg</Code>. <Code>OPERATOR_ALLOW</Code> lists what the token may do;
            by default it may not decide lessons, delete data, change settings, import or set integration keys, so what agents learn stays your call. Its
            writes show in Activity as <Code>operator:&lt;name&gt;</Code>, and a lesson it decided carries a badge.
          </p>
        </Section>

        <Section title="The code map">
          <p>
            The worker parses each selected project's code into a map: its files, the symbols each one defines, which file imports which, the tests that
            cover each file (a test imports it directly or through one file) and how often each file changed in the last 90 days. It rebuilds the map only
            when the repo changed, at most every five minutes, with no model and without storing any source. Ingest notes which files each session read and
            edited, so every confirmed miss is tied to the files its session edited, and to the ones it edited after your feedback (where the fix landed).
          </p>
          <p className="mt-2">Agents use the map through two tools of their own, and through the files they name when they ask for task context and check their work before saying done:</p>
          <dl className="mt-2 space-y-2">
            <Tool name="get_module_context">One file: what the code scan says it is, its exported symbols, who imports it, what it imports, the tests that cover it, and the approved lessons and past misses tied to it.</Tool>
            <Tool name="impact">A set of files: the files that depend on them by how many import hops away, the tests to run, and lessons and misses on everything impacted.</Tool>
          </dl>
          <p className="mt-3">
            <b>Hotspots</b> are where agents struggle. Each file gets a score:
          </p>
          <Pre>score = 4 × misses + log2(1 + churn) + log2(1 + dependents)</Pre>
          <p className="mt-2 text-muted">
            <b>misses</b> counts confirmed misses whose session edited the file, <b>churn</b> its commits in the last 90 days and <b>dependents</b> the files
            that import it. One miss outweighs a busy file: a file agents got wrong once ranks above one that only changes a lot. The Projects page shows a
            project's hotspots (click a file for its module panel); Patterns lists the top ones across your selected projects.
          </p>
          <p className="mt-2 text-muted">
            Test files are left out of the hotspots unless you tick include tests (Projects, or Code mode on the Graph page). Docs and config files score 0
            until a miss touches them.
          </p>
          <p className="mt-2 text-muted">
            A big repo's map is capped: by default at 40% of the files worth mapping, from 400 to 4,000 (<Code>SCAN_MAX_FILES</Code> sets a number). The
            files your sessions edited come first, then source, then tests, manifests and docs. The code map card says when a map is capped and how many files
            it left out.
          </p>
          <p className="mt-2 text-muted">
            GDScript preload, load and extends paths link to the files they name (<Code>res://</Code> is the folder holding the nearest{' '}
            <Code>project.godot</Code>), and a <Code>class_name</Code> used elsewhere links to the file that declares it. A Swift import of a local module
            links to that module's files (a <Code>Package.swift</Code> target, or a <Code>Sources/&lt;Module&gt;</Code> folder).
          </p>
        </Section>

        <Section title="Linked projects, uploads and relevance">
          <dl className="space-y-3">
            <Page name="Pin">Pin a project on the Projects page (the pin beside it, or <b>Pin</b> in its header): pinned projects come first in every project list.</Page>
            <Page name="Link">
              Projects that belong together (a game and its backend, an app and its site, a product and the library it vendors) can be linked under{' '}
              <b>Linked projects</b>. An agent working in one then also gets the best lessons, past misses, facts and doc excerpts of the other, each labelled
              with where it came from, and <b>check_before_done</b> checks the work against the other project's most relevant lessons too. Every{' '}
              <Code>LINK_SCAN_MINUTES</Code> (30) the worker looks for links between your selected projects, without a model: a package manifest naming
              another project's package or a local path into it, another project's repository named in its files, and its name in several files. These
              arrive as <b>suggestions</b> with their evidence: nothing reaches an agent until you <b>Confirm</b> one. <b>Dismiss</b> keeps it from being
              suggested again; you can also link two projects by hand, with a relation and a note on how they fit together.
            </Page>
            <Page name="Uploads">
              Upload specs, notes, screenshots, design mocks or whiteboard photos under <b>Docs and discussions</b> (text, or PNG, JPEG, WebP and GIF
              images up to 8 MB). Text is searchable at once. The worker then reads each upload with <Code>DOCS_LLM</Code> (default the scan model): a
              document becomes facts; an image becomes a description of everything in it, which replaces its placeholder excerpt, and facts. Images need
              a model with vision. Facts from a document show <b>from your document</b> and go with it when you remove it. Uploads stay on this machine
              and are sent only to that model.
            </Page>
            <Page name="Relevance">
              Every fact gets a relevance from 0 to 1: how often an agent doing everyday coding here needs it. A core convention is <b>everyday</b>; how to
              set up an external tool, CI or deploy steps are <b>rare</b>. Agents get facts ranked by similarity weighted by relevance, and a rare fact only
              when the task is very close to it. Scans and document reading score new facts; facts stored before relevance existed are scored in the
              background by the scan model. Set one yourself with <b>everyday</b>, <b>sometimes</b> or <b>rare</b> under the fact: the background scorer never
              changes yours (a rescan makes new facts, scored again).
            </Page>
          </dl>
        </Section>

        <Section title="Each page">
          <dl className="space-y-3">
            <Page name="Inbox">
              Possible pushback, with the conversation around it. <b>Pending</b> is waiting for you; <b>Confirmed</b> shows each item's post-mortem state, with
              a retry button if one failed; <b>Rejected</b> lets you change your mind.
            </Page>
            <Page name="Lessons">
              Proposed lessons with the miss and evidence behind them. Scope decides where a lesson applies: <b>task</b> (work like this one), <b>project</b>, or
              <b> global</b> (every project). Prefer the narrowest scope that fits. An approved lesson can be revoked at any time.
            </Page>
            <Page name="Graph">
              The evidence chain for a project: feedback, misses, causes, lessons and the context items behind them. Click a node to follow its links.{' '}
              <b>Code</b> mode draws one project's code map: its top hotspot files sized by score (red when misses touched them), their imports and tests,
              and the misses and lessons on them; click a file for its module panel.
            </Page>
            <Page name="Patterns">
              Whether this is working: how often the same kind of miss repeats, why misses happen, how often an agent's pre-done check caught a gap, and
              where agents struggle (the top code map hotspots).
            </Page>
            <Page name="Sessions">
              A running summary of each session of the selected projects: its goal, what was done and decided, open threads, pushback and files touched. The
              worker summarizes a session once it has been quiet for a few minutes, then only the turns that came after, merged into the summary; after half
              an hour of quiet the session is <b>idle</b> (complete for now) until it continues. Each update is listed with the turns it took in.
              Summaries stay on this machine: they are never exported or synced.
            </Page>
            <Page name="Projects">
              Per project: <b>Pin</b> it, its <b>linked projects</b> (and suggestions to confirm), its <b>code map</b> (size, last build and hotspots; click a file for its symbols, importers, tests, lessons and misses), <b>Scan</b>
              the code for facts (choose which model reads it), search and sort the facts by relevance, upload docs and images agents should know about (read into facts), export everything learned, or delete it.
            </Page>
            <Page name="Activity">The log of everything the tool created or changed, who or what did it, and why, including each <b>code mapped</b> build with its size and duration.</Page>
            <Page name="Settings">
              Which project folders are read. Tick folders and press <b>Save selection</b>. <b>Where folders come from</b> holds the project roots: add
              or remove them there (there is none by default), and the folders sessions ran in outside them are suggested with their session counts, each
              one click from being a root. A saved change is mounted when you run <Code>./scripts/setup.sh</Code>, which restarts the containers. A folder
              that is not a git repo but holds repos one or two levels down is not one project: each git repo inside it is a project of its own.{' '}
              <b>Clean up</b> deletes the data of projects you have not selected. Every other page shows only the selected
              projects; Settings is the one place that lists every folder.
            </Page>
          </dl>
        </Section>

        <Section title="Choosing models">
          <p>
            By default everything runs on Ollama on your machine (<Code>gemma4</Code> and <Code>nomic-embed-text</Code>), so nothing leaves it. Post-mortems are
            much better on Claude: run <Code>claude setup-token</Code>, put the token in <Code>.env</Code> as <Code>CLAUDE_CODE_OAUTH_TOKEN</Code>, and post-mortems switch to
            Claude automatically. Each job (<Code>CLASSIFY_LLM</Code>, <Code>POSTMORTEM_LLM</Code>, <Code>SCAN_LLM</Code>, <Code>CHECK_LLM</Code>, <Code>SUMMARY_LLM</Code> for session
            summaries, where <Code>off</Code> turns them off, <Code>DOCS_LLM</Code> for reading uploads, which needs vision for images) can also be set on its own; <Code>.env.example</Code> lists the providers.
          </p>
          <p className="mt-3">
            The CLI agents read code differently. <Code>claude-cli</Code> can read only the project folder it is working on, and not the secret files in
            it. <Code>codex-cli</Code> cannot be confined that way inside the worker, so it runs in its own container: set <Code>CODEX_RUNNER_URL=http://codex-runner:8790</Code> and
            add <Code>codex</Code> to <Code>COMPOSE_PROFILES</Code>. That container holds only the Codex CLI, your Codex login and a copy of the project without its secret
            files, so that copy is all Codex can read. Without it, inside the worker Codex can read every file the worker can, which is every transcript, every project folder with its .env files,
            the worker's state, your Codex login and the worker's own secrets, and it only runs once you set <Code>ALLOW_UNCONFINED_CODEX=1</Code> to accept that.
          </p>
          <p className="mt-3">
            <Code>CHECK_LLM</Code> judges <b>check_before_done</b> inside the api, which has no agent CLIs, so it takes Ollama or an API model, not <Code>claude-cli</Code> or <Code>codex-cli</Code>.
          </p>
        </Section>

        <Section title="Limit what it reads">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-faint">
            <li>The containers see only the project roots you add in <SettingsLink /> (read-only), never your whole home folder.</li>
            <li>You choose the project folders to read in <SettingsLink />: tick them and press <b>Save selection</b>. Each folder shows how many Claude Code and Codex sessions ran in it. Unselecting a folder stops reading it and hides it everywhere but Settings (agents stop getting its lessons too); what was learned is kept until <b>Clean up</b> on the same page removes the data of every unselected project.</li>
            <li><Code>EXCLUDE_PROJECTS</Code>: never these, whatever is selected. <Code>INGEST_PROJECTS</Code> only sets the selection on the very first start.</li>
            <li><Code>TURN_RETENTION_DAYS</Code>: drop old message text after that many days. A turn keeps its text until its session summary covers it; summaries are never dropped.</li>
            <li>Secrets are redacted before anything is stored or sent to a model, and secret files are never read. See <Code>SECURITY.md</Code> for details.</li>
          </ul>
          <p className="mt-2 text-muted">Restart after changing <Code>.env</Code>: <Code>docker compose up -d</Code>.</p>
        </Section>

        <Section title="GitHub and Linear">
          <p>
            Reviewers push back too. Connect GitHub or Linear and comments on your pull requests and Linear issues arrive in the <b>Inbox</b>, marked{' '}
            <b>GitHub</b> or <b>Linear</b>, with the author, a link to the comment and, for a review comment, the file, line and diff lines. The same
            classifier as for sessions picks out pushback and corrections; you confirm or reject them as usual.
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-muted">
            <li>
              In <SettingsLink />, under <b>Integrations</b>, paste a token and press <b>Connect</b>. It is checked with one read-only call and saved only if
              it works. For GitHub use a fine-grained token with only your projects' repositories and <b>Pull requests</b> and <b>Issues</b> read-only; for
              Linear a personal API key. A token in <Code>.env</Code> (<Code>GITHUB_TOKEN</Code>, <Code>LINEAR_API_KEY</Code>) wins and shows as "set in .env".
            </li>
            <li>Each selected project with a github.com remote is linked to its repository (<Code>GITHUB_REPOS</Code> overrides it). For Linear, pick each project's team.</li>
            <li>Every 10 minutes (<Code>INTEGRATION_SYNC_MINUTES</Code>) new comments are read; the first sync goes back 14 days. Bots are skipped.</li>
          </ol>
          <p className="mt-2">
            A confirmed comment's post-mortem reads the agent session that did the work: one on the pull request's branch, or the only one just before the
            comment. With none, it works from the comment and its diff lines.
          </p>
          <p className="mt-2 text-muted">
            Tokens stay on this machine (a mode 600 file, never the database) and are never shown again. A revoked token or a rate limit pauses that
            service and says so in Settings and in the connections list in the sidebar.
          </p>
        </Section>

        <Section title="Share with a team">
          <p>
            Cloud sync is optional and off by default: unless you configure it, nothing is sent anywhere. With a Feedback Graph Cloud org, your approved
            lessons become your team's: teammates' agents get them through the team MCP endpoint, matched by git remote.
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-muted">
            <li>In the cloud web app, create an access token with the <b>sync</b> scope.</li>
            <li>Set <Code>CLOUD_URL</Code> (https) and <Code>CLOUD_TOKEN</Code> in <Code>.env</Code>, and restart.</li>
            <li>Press <b>Sync now</b> on the Cloud sync card in <SettingsLink />, or set <Code>SYNC_INTERVAL_MINUTES</Code> to sync on a schedule. <Code>SYNC_PROJECTS</Code> narrows which selected projects are sent.</li>
          </ol>
          <p className="mt-2">
            <b>Sent</b>, per selected project: its key and git remote, its approved lessons, misses (what was missed and why), current code facts,
            document titles and links, and the code map's file paths with their hotspot numbers. Only lessons you approved leave: they become the
            team's (or wait for an admin, if your org reviews them), and a proposed lesson stays on this machine until you approve it, unless you set{' '}
            <Code>SYNC_SUGGESTIONS</Code> to <Code>true</Code> to send proposed ones to an admin as suggestions; a lesson you reject or move back to proposed, or anything you delete, is taken
            back out of the team graph on the next sync. A project you stop syncing (unselected, excluded, or left out of <Code>SYNC_PROJECTS</Code>)
            gets one last, empty bundle on the next sync that takes back what was sent for it. Every sync is logged in <b>Activity</b> with the counts and the cloud's host.
          </p>
          <p className="mt-2 text-muted">
            Never sent: session transcripts (including the feedback you typed), source code, file excerpts, document text, embeddings, or anything new
            from a project you have not selected. A project with no shareable git remote lands in your personal space in the
            org, visible only to you.
          </p>
        </Section>

        <Section title="When something looks wrong">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-faint">
            <li><b>First, run <Code>./scripts/doctor.sh</Code>:</b> it checks Docker, ports, Ollama (with a real structured-output call), the mounts, the Codex login and GitHub and Linear, and says how to fix each failure.</li>
            <li><b>Nothing seems to happen:</b> the empty Inbox, Lessons and Graph pages show what the worker is on and every stage's backlog. The first hours of a big selection go to classifying and scanning.</li>
            <li><b>Inbox is empty:</b> the worker classifies newest sessions first; check the badge (it says <b>no projects selected</b> when nothing is being read), and that the project is ticked in <SettingsLink /> and not excluded.</li>
            <li><b>Badge says classifier unavailable</b> (or post-mortem / scan model unavailable, or summaries paused for the summary model): that model could not be asked at all (not running, not pulled, signed out, rate limited); the tooltip gives the reason. That work waits and nothing is charged against it, so fixing the model is enough. Turns given up on earlier can be tried again with <b>Re-queue</b> in the empty Inbox.</li>
            <li><b>A GitHub comment never reached the Inbox:</b> bots, the pull request author's replies to a reviewer, status notes and bare review triggers are skipped before the classifier; <SettingsLink /> lists the rules.</li>
            <li><b>Post-mortem never appears:</b> Inbox → Confirmed shows whether it is waiting, failed (with the error) or gave up, with a retry button.</li>
            <li><b>Agents get no lessons:</b> lessons must be approved, and the agent must be working inside that project's folder.</li>
            <li><b>Backups, upgrades, running it for a team:</b> see <Code>docs/operations.md</Code>.</li>
          </ul>
        </Section>
      </article>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section id={slug(title)} aria-labelledby={`${slug(title)}-h`} className="scroll-mt-4 rounded-md border border-line bg-surface p-5 shadow-card">
      <h2 id={`${slug(title)}-h`} className="mb-3 text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {children}
    </section>
  );
}

function Tool({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-l-2 border-line pl-3">
      <dt><Code>{name}</Code></dt>
      <dd className="text-muted">{children}</dd>
    </div>
  );
}

function Page({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 md:grid-cols-[6.5rem_minmax(0,1fr)] md:gap-4">
      <dt className="font-semibold">{name}</dt>
      <dd className="text-muted">{children}</dd>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[3px] border border-line bg-sunken px-1 py-px font-mono text-[0.85em] break-words">{children}</code>
);
const Pre = ({ children }: { children: ReactNode }) => (
  <pre className="overflow-x-auto rounded-sm border border-line bg-sunken px-3 py-2 font-mono text-xs">{children}</pre>
);

/** Pages are addressed by the hash, so a plain link switches to Settings. */
function SettingsLink() {
  return <a href="#settings" className="font-semibold text-accent-text underline decoration-accent/50 underline-offset-2 hover:decoration-accent">Settings</a>;
}
