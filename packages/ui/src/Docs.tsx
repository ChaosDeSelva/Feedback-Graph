import type { ReactNode } from 'react';
import { PageHeader } from './ui/PageHeader.tsx';
import { Kbd } from './ui/display.tsx';

const SECTIONS = ['How it works', 'Your first hour', 'Connect your agents', 'The code map', 'Each page', 'Choosing models', 'Limit what it reads', 'Share with a team', 'When something looks wrong'];
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
            <Tool name="search_graph">Searches lessons and past misses by meaning.</Tool>
          </dl>
          <p className="mt-2">
            If the detector missed some pushback, type <Code>/postmortem what it missed</Code> in Claude Code. It goes to the Inbox like any other item.
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
            project's hotspots (click a file for its module panel); Patterns lists the top ones across your selected projects. Imports are not resolved for
            GDScript and Swift, so their dependents are 0.
          </p>
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
            <Page name="Graph">The evidence chain for a project: feedback, misses, causes, lessons and the context items behind them. Click a node to follow its links.</Page>
            <Page name="Patterns">
              Whether this is working: how often the same kind of miss repeats, why misses happen, how often an agent's pre-done check caught a gap, and
              where agents struggle (the top code map hotspots).
            </Page>
            <Page name="Projects">
              Per project: its <b>code map</b> (size, last build and hotspots; click a file for its symbols, importers, tests, lessons and misses), <b>Scan</b>
              the code for facts (choose which model reads it), search the facts, upload docs agents should know about, export everything learned, or delete it.
            </Page>
            <Page name="Activity">The log of everything the tool created or changed, who or what did it, and why, including each <b>code mapped</b> build with its size and duration.</Page>
            <Page name="Settings">
              Which project folders are read. Tick folders and press <b>Save selection</b>; sessions outside your project roots are counted so you know
              whether to add a root. <b>Clean up</b> deletes the data of projects you have not selected.
            </Page>
          </dl>
        </Section>

        <Section title="Choosing models">
          <p>
            By default everything runs on Ollama on your machine (<Code>gemma4</Code> and <Code>nomic-embed-text</Code>), so nothing leaves it. Post-mortems are
            much better on Claude: run <Code>claude setup-token</Code>, put the token in <Code>.env</Code> as <Code>CLAUDE_CODE_OAUTH_TOKEN</Code>, and post-mortems switch to
            Claude automatically. Each job (<Code>CLASSIFY_LLM</Code>, <Code>POSTMORTEM_LLM</Code>, <Code>SCAN_LLM</Code>, <Code>CHECK_LLM</Code>) can
            also be set on its own; <Code>.env.example</Code> lists the providers.
          </p>
          <p className="mt-3">
            The CLI agents read code differently. <Code>claude-cli</Code> can read only the project folder it is working on, and not the secret files in
            it. <Code>codex-cli</Code> cannot be confined that way: it can read every file the worker can, which is every transcript, every project folder with its .env files,
            the worker's state, your Codex login and the worker's own secrets. It only runs once you set <Code>ALLOW_UNCONFINED_CODEX=1</Code> to accept that.
          </p>
        </Section>

        <Section title="Limit what it reads">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-faint">
            <li>You choose the project folders to read in <SettingsLink />: tick them and press <b>Save selection</b>. Each folder shows how many Claude Code and Codex sessions ran in it. Unselecting a folder stops reading it and keeps what was learned; <b>Clean up</b> on the same page removes the data of every unselected project.</li>
            <li><Code>EXCLUDE_PROJECTS</Code>: never these, whatever is selected. <Code>INGEST_PROJECTS</Code> only sets the selection on the very first start.</li>
            <li><Code>TURN_RETENTION_DAYS</Code>: drop old message text after that many days.</li>
            <li>Secrets are redacted before anything is stored or sent to a model, and secret files are never read. See <Code>SECURITY.md</Code> for details.</li>
          </ul>
          <p className="mt-2 text-muted">Restart after changing <Code>.env</Code>: <Code>docker compose up -d</Code>.</p>
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
            back out of the team graph on the next sync. Every sync is logged in <b>Activity</b> with the counts and the cloud's host.
          </p>
          <p className="mt-2 text-muted">
            Never sent: session transcripts (including the feedback you typed), source code, file excerpts, document text, embeddings, or anything from
            a project you have not selected. A project with no shareable git remote lands in your personal space in the
            org, visible only to you.
          </p>
        </Section>

        <Section title="When something looks wrong">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-faint">
            <li><b>Inbox is empty:</b> the worker classifies newest sessions first; check the badge (it says <b>no projects selected</b> when nothing is being read), and that the project is ticked in <SettingsLink /> and not excluded.</li>
            <li><b>Badge says classifier unavailable</b> (or post-mortem / scan model unavailable): that model could not be asked at all (not running, not pulled, signed out, rate limited); the tooltip gives the reason. That work waits and nothing is charged against it, so fixing the model is enough. Turns given up on earlier can be tried again with <b>Re-queue</b> in the empty Inbox.</li>
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
