import { useEffect, useState, type ReactNode } from 'react';
import { hashFocus } from './links.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';
import { architectureSvg, NARROW_WIDTH } from './ui/architecture.ts';

const SECTIONS = ['How it works', 'Your first hour', 'Connect your agents', 'The code map', 'Linked projects, uploads and relevance', 'Each page', 'The learning loop', 'Choosing models', 'Limit what it reads', 'GitHub and Linear', 'Share with a team', 'Runs, sandboxes and testing', 'When something looks wrong'];
const slug = (t: string) => `doc-${t.toLowerCase().replace(/[^a-z]+/g, '-')}`;

/** The skills `install-agent.sh` links for Claude Code (plugin/skills, one folder each). */
export const CLAUDE_SKILLS = ['feedback-graph', 'postmortem', 'test-from-feedback'];

/**
 * Prose keeps a readable line (about 110 characters, growing with the font) while the page uses the full width:
 * code blocks, the page guides and their screenshots run to the edge.
 */
const MEASURE = '[&>:not(pre,.wide)]:max-w-[54em]';

const DIAGRAM = architectureSvg('tokens');
const NARROW_DIAGRAM = architectureSvg('tokens', 'narrow');

/** How to use the tool, for someone who just opened it. Static: nothing here calls the API. */
export function Docs() {
  // #docs/<section> (the Dashboard's Getting started links one) opens at that section.
  useEffect(() => {
    const at = hashFocus('docs');
    if (at) document.getElementById(`doc-${at}`)?.scrollIntoView?.({ block: 'start' });
  }, []);
  // Below lg the contents are a bar pinned to the top of the page that opens the list over it.
  const [tocOpen, setTocOpen] = useState(false);
  const go = (s: string) => {
    setTocOpen(false);
    document.getElementById(slug(s))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Docs" description="How Feedback Graph works, your first hour with it, and how to connect your agents." />
      <ScrollArea id="docs-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full flex-col lg:flex-row lg:gap-10 lg:px-8 lg:py-8 xl:gap-14 xl:px-12">
          <nav
            aria-label="on this page"
            className="sticky top-0 z-10 shrink-0 border-b border-line bg-canvas px-4 py-2 md:px-8 lg:top-8 lg:w-60 lg:self-start lg:border-0 lg:bg-transparent lg:p-0"
          >
            <button
              type="button"
              aria-expanded={tocOpen}
              aria-controls="docs-toc"
              onClick={() => setTocOpen(!tocOpen)}
              className="flex w-full items-center justify-between gap-2 py-1 text-left text-[15px] font-semibold lg:hidden"
            >
              On this page
              <span aria-hidden="true" className={`text-xs text-faint transition-transform ${tocOpen ? 'rotate-90' : ''}`}>▶</span>
            </button>
            <div aria-hidden="true" className="mb-3 hidden px-3 text-xs font-semibold tracking-[0.06em] text-muted uppercase lg:block">On this page</div>
            {/* Below lg the open list lies over the page, so closing it moves nothing under the section it scrolls to. */}
            <ul
              id="docs-toc"
              className={`${tocOpen ? 'grid' : 'hidden'} absolute inset-x-0 top-full max-h-[70vh] gap-px overflow-y-auto border-b border-line bg-canvas px-4 py-2 shadow-pop md:px-8 lg:static lg:grid lg:max-h-none lg:overflow-visible lg:border-0 lg:border-l lg:bg-transparent lg:p-0 lg:shadow-none`}
            >
              {SECTIONS.map((s) => (
                <li key={s}>
                  {/* Buttons, not #anchors: the hash already names the page. */}
                  <button
                    type="button"
                    onClick={() => go(s)}
                    className="-ml-px block w-full border-l-2 border-transparent py-1.5 pl-3 text-left text-[15px] leading-snug text-muted hover:border-line-strong hover:text-text"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <article className="min-w-0 flex-1 px-4 pt-6 pb-16 text-[17px] leading-[1.65] md:px-8 lg:p-0 2xl:text-[18px]">
            <header className={`border-b border-line pb-8 ${MEASURE}`}>
              <h2 className="text-[30px] leading-tight font-semibold tracking-[-0.02em] [font-stretch:88%] md:text-[36px]">Using Feedback Graph</h2>
              <p className="mt-3 text-[1.1em] text-muted">
                When you push back on a coding agent (&quot;that&apos;s not right&quot;, &quot;you missed X&quot;), the lesson usually stays in that one session.
                This tool notices the pushback, asks you to confirm it, works out why the agent missed it, and turns that into a lesson you approve. Agents
                then read your approved lessons before they start work, and check against them before they say &quot;done&quot;.
              </p>
            </header>

            {/*
              * Chosen by the column's width, not the window's (the sidebar and contents take their share): the four-column
              * diagram from 976px, where its 14px text draws at 11px or more, the three-column one below, at most its own
              * size. Under 460px even that would shrink past 11px, so it scrolls sideways and says so.
              */}
            <figure className="@container border-b border-line py-8">
              <p aria-hidden="true" className="mb-2 text-xs text-muted @min-[460px]:hidden">Scroll sideways to see all of it →</p>
              <ScrollArea className="overflow-x-auto">
                <div data-diagram="narrow" style={{ maxWidth: NARROW_WIDTH }} className="min-w-[460px] @min-[976px]:hidden [&>svg]:block [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: NARROW_DIAGRAM }} />
                <div data-diagram="wide" className="hidden @min-[976px]:block [&>svg]:block [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: DIAGRAM }} />
              </ScrollArea>
              <figcaption className="mt-3 text-[15px] text-muted">
                How it works: what you push back on becomes a lesson only once you confirm it and it is approved (by you, or by the learning loop once your reviews have earned it), agents read the graph before work and before
                &quot;done&quot;, and the learning loop tidies the graph with every change audited and undoable.
              </figcaption>
            </figure>

            <Section title="How it works">
              <ol className="list-decimal space-y-2 pl-6 marker:font-semibold marker:text-muted">
                <li><b>Read.</b> Every 30 seconds the worker reads the Claude Code (<Code>~/.claude/projects</Code>) and Codex (<Code>~/.codex/sessions</Code>) sessions of the project folders you selected in <SettingsLink />. Nothing is read until you choose, and nothing is changed.</li>
                <li><b>Map the code.</b> The worker maps each selected project&apos;s code (files, symbols, imports, tests, recent churn) and notes which files each session edited, so misses are tied to the files they happened in. No model is involved and no source is stored.</li>
                <li><b>Detect.</b> A local model labels each of your messages. Ones that sound like pushback land in the <b>Inbox</b>.</li>
                <li><b>You confirm.</b> Nothing is learned until you confirm an Inbox item. Rejecting one teaches nothing and costs nothing.</li>
                <li><b>Post-mortem.</b> For confirmed feedback, a model reads the session around it and writes what was missed, why, and a proposed lesson. It looks for the context that would have prevented the miss (code, past sessions, docs, PRs, tickets), scopes the lesson to the files the fix touched when that fits, and proposes its <b>triggers</b>: path globs, added-line patterns and symbols that bring the lesson to work like it.</li>
                <li><b>You approve.</b> Proposed lessons wait under <b>Lessons</b>. Only approved ones are ever shown to agents. The learning loop runs in <i>auto</i> by default, and may approve a lesson itself, but only once your own reviews of its proposals have earned it (20 of them in the call's confidence band, at a 0.9 bar), and every approval it makes can be rolled back. Set it to <i>propose</i> to keep every approval yours.</li>
                <li><b>Agents use it.</b> Through the MCP server, the plugin or the skill, agents fetch the lessons, past misses and code facts for their task, and check their finished work against them.</li>
                <li><b>It learns.</b> The learning loop reads what happened next (repeats, checks, your edits and rejections) and tidies the graph: it links repeated misses, merges duplicates, retires lessons that never help and proposes better wording. Each change is a decision you can keep, roll back or annotate. See <button type="button" onClick={() => go('The learning loop')} className="font-semibold text-accent-text underline decoration-accent/50 underline-offset-2 hover:decoration-accent">The learning loop</button>.</li>
              </ol>
              <p className="text-muted">Every step writes an entry under <b>Activity</b>, so you can always see what created a lesson or fact, and why.</p>
            </Section>

            <Section title="Your first hour">
              <ol className="list-decimal space-y-2 pl-6 marker:font-semibold marker:text-muted">
                <li>
                  If a <b>Read-only</b> banner shows, this install has no owner token: run <Code>./scripts/setup.sh --yes --enable-auth</Code> in the install
                  folder. Then sign in: <Code>./scripts/fg signin</Code> prints a link that signs this browser in once, within 60 seconds.
                </li>
                <li>
                  No project folder is mounted until you choose one. If <SettingsLink /> lists none, add the folder that holds your projects under{' '}
                  <b>Where folders come from</b>, then run <Code>./scripts/setup.sh</Code> on the host: it mounts exactly those folders, read-only, and restarts the containers.
                </li>
                <li>In <SettingsLink />, tick the project folders to read and press <b>Save selection</b>.</li>
                <li>Check that the badge at the bottom of the sidebar says <b>worker running</b>. If it says offline, run <Code>docker compose logs worker</Code>: config problems are listed by name.</li>
                <li>Open <b>Inbox</b> and go through the pending items: <Key>j</Key>/<Key>k</Key> to move, <Key>c</Key> to confirm real pushback, <Key>r</Key> to reject anything else (a new request, a question, a false alarm).</li>
                <li>A few minutes later, open <b>Lessons → proposed</b>. Read each lesson and its evidence, edit the wording or narrow the scope if needed, then <b>Approve</b> or <b>Reject</b>.</li>
                <li>Open <b>Projects</b>, pick a project and press <b>Scan</b>, so agents also get facts about its code.</li>
                <li>Connect your agents (next section) and start a normal task in that project.</li>
              </ol>
              <p>
                <b>No history yet?</b> <Code>./scripts/setup.sh --yes --demo</Code> adds the bundled demo-shop project and seeds its demo lessons. Then{' '}
                <Code>./scripts/fg demo context</Code> shows what an agent is given before editing it, and <Code>./scripts/fg demo check</Code> shows the check
                catching a change that breaks a lesson, with the line. <Code>./scripts/fg demo remove</Code> takes the demo lessons back.
              </p>
            </Section>

            <Section title="Connect your agents">
              <Sub>Claude Code plugin</Sub>
              <p>The plugin bundles the MCP server, the skills and hooks that use the graph without being asked. In Claude Code:</p>
              <Pre>{'/plugin marketplace add ChaosDeSelva/Feedback-Graph\n/plugin install feedback-graph@feedback-graph'}</Pre>
              <p>
                Its hooks add the task&apos;s lessons, past misses and the AGENTS.md / CLAUDE.md files on the named files&apos; path to a request (once a
                session, then only what is new), a file&apos;s lessons before its first edit, and, before Claude stops, ask it once to run{' '}
                <Code>check_before_done</Code> if it changed files. They act only in folders you selected, stay silent when Feedback Graph is down, and{' '}
                <Code>FEEDBACK_GRAPH_HOOKS=off</Code> turns them off.
              </p>

              <Sub>install-agent.sh (Codex, or Claude Code without hooks)</Sub>
              <p>From the folder you cloned Feedback Graph into, run:</p>
              <Pre>./scripts/install-agent.sh</Pre>
              <p>
                It sets up every agent it finds. Claude Code: {CLAUDE_SKILLS.length} skills ({CLAUDE_SKILLS.map((k, i) => <span key={k}>{i ? ', ' : ''}<Code>{k}</Code></span>)}) linked into <Code>~/.claude/skills</Code> and the <Code>feedback-graph</Code> MCP server.
                Codex: the same MCP server in <Code>~/.codex/config.toml</Code> and the same guidance in <Code>~/.codex/AGENTS.md</Code> (both backed up first, and
                never added twice). Add <Code>claude</Code> or <Code>codex</Code> to set up only one; <Code>--dry-run</Code> shows what it would change. It
                refuses a checkout that is not set up yet (run <Code>./scripts/setup.sh</Code> first). Use the plugin or this script for Claude Code, not both.
              </p>

              <Sub>The tools</Sub>
              <p>The guidance tells the agent when to call each tool, so you don&apos;t have to ask:</p>
              <dl className="space-y-3">
                <Tool name="get_task_context">
                  At the start of a task: approved lessons, similar past misses, code facts and docs for this project and task. Name the files you will
                  touch and the lessons tied to them come first, with a short code map of them (importers, tests, past misses) and the AGENTS.md /
                  CLAUDE.md files on their path. A lesson whose <b>triggers</b> match those files or the task&apos;s words is served too, saying which
                  trigger fired (at most six beyond the file-tied ones). A past miss is served only when it shares a file with the work or is at least{' '}
                  <Code>MISS_MIN_SIMILARITY</Code> (0.85) similar to it. <Code>brief: true</Code> gives only lessons, misses on those files, their importers
                  and tests, and PR discussions (about 1,500 characters).
                </Tool>
                <Tool name="check_before_done">
                  Before claiming done: the judge checks the real change against the lessons <Code>get_task_context</Code> would serve, the lessons
                  whose triggers fire on the lines the diff adds or the files it changes, and close past misses, and lists the gaps. It reads the{' '}
                  <Code>diff</Code> the agent passes, or the repository&apos;s diff of <Code>files_changed</Code>. Each verdict quotes the diff lines it rests
                  on; one that points to no line is listed under <b>Cannot tell from the diff</b>: neither a gap nor a pass, check it yourself. When a lesson
                  requires a change to a file it names (a test, a doc) and the diff leaves that file out, the gap says so. About 32 KB of diff is read, the
                  files the lessons and misses name first, and the answer names the files it cut. Given <Code>files_changed</Code>, it also names the
                  importers and tests the change did not touch. A slow judge answers <b>queued</b> with the lessons to check by hand and when to call again
                  with the same arguments; its call keeps running for up to <Code>CHECK_WAIT_SECONDS</Code> (300).
                </Tool>
                <Tool name="get_module_context">Before changing a file: what it is, its symbols, who imports it, what it imports, the tests that cover it (its own first), and the lessons and misses tied to it. A file past the code map&apos;s cap gets the same answer, its symbols parsed on demand.</Tool>
                <Tool name="impact">Before changing files others use: everything that imports them (and how far away), the tests to run, and lessons and misses on all of it.</Tool>
                <Tool name="report_feedback">For <Code>/postmortem</Code>, or a miss you did not put in words: sends it to your Inbox, marked <b>agent report</b>. Pushback you typed is flagged from the session anyway; a report of the same moment joins that Inbox item.</Tool>
                <Tool name="get_recent_sessions">When picking up work: the newest session summaries of this project (goal, what was done and decided, open threads, pushback, files). Task context also lists the three most recent in one line each.</Tool>
                <Tool name="search_graph">Searches lessons, past misses, facts and docs by meaning, in about 3,000 characters; says when nothing is close enough.</Tool>
              </dl>
              <p>
                If the detector missed some pushback, type <Code>/postmortem what it missed</Code> in Claude Code. It goes to the Inbox like any other item.
              </p>

              <Sub>Headless runs</Sub>
              <p>
                <Code>claude -p</Code> never prompts: a tool that is not allowed is denied, and the Stop hook says the check did not run. Allow the tools and
                the git commands the check asks for:
              </p>
              <Pre>{'claude -p "..." --allowedTools "mcp__plugin_feedback-graph_fg" "Bash(git diff *)" "Bash(git add -N *)"'}</Pre>
              <p>
                Set up with <Code>./scripts/install-agent.sh claude</Code> instead of the plugin, the server is <Code>feedback-graph</Code>: allow{' '}
                <Code>mcp__feedback-graph</Code>. The agent tools carry MCP annotations (read-only, except <Code>report_feedback</Code>), so{' '}
                <Code>codex exec</Code> can call them; for one headless Codex run without asking, <Code>install-agent.sh</Code> prints the override:{' '}
                <Code>{`codex exec -c 'mcp_servers.feedback-graph.default_tools_approval_mode="approve"' ...`}</Code>.
              </p>

              <Sub>A second install</Sub>
              <p>
                Another checkout of the tool on the same machine: <Code>./scripts/setup.sh</Code> gives it its own Docker Compose name
                (<Code>FG_INSTANCE</Code>), its own ports and Ollama port (<Code>OLLAMA_PORT</Code>), so it never takes over the first one&apos;s containers or
                data, and <Code>install-agent.sh</Code> registers its MCP server as <Code>feedback-graph-&lt;name&gt;</Code>. An existing install keeps its name,
                ports and volumes. The scripts ignore a <Code>COMPOSE_PROJECT_NAME</Code> in your shell, and stop when the install name set there is another
                install&apos;s.
              </p>

              <Sub>Agents and scripts that decide</Sub>
              <p>
                The tools above only read and report. To let an agent or a script make some of your decisions (start scans, confirm Inbox items), set{' '}
                <Code>FG_OPERATOR_TOKEN</Code> in <Code>.env</Code> and use <Code>./scripts/fg</Code>. <Code>OPERATOR_ALLOW</Code> lists what the token may do;
                by default it may not decide lessons, choose which projects are read, delete data, change settings, import, set integration keys, ask in Ask
                (which spends your subscription), or decide on or configure the learning loop (<Code>loop_decide</Code>, <Code>loop_settings</Code>), so what
                agents learn stays your call. Its writes show in Activity as <Code>operator:&lt;name&gt;</Code>,
                and a lesson it decided carries a badge.
              </p>
            </Section>

            <Section title="The code map">
              <p>
                The worker parses each selected project&apos;s code into a map: its files, the symbols each one defines, which file imports which, the tests that
                cover each file (a test beside it or in its Go package first, then tests that import it directly or through one file) and how often each file
                changed in the last 90 days. It checks the map at most every five minutes and rebuilds it only when the repo changed, with no model and
                without storing any source; the Code map card on Projects says when it was last checked and built. Ingest notes which files each session read
                and edited, so every confirmed miss is tied to the files its session edited, and to the ones it edited after your feedback (where the fix landed).
              </p>
              <p>Agents use the map through two tools of their own, and through the files they name when they ask for task context and check their work before saying done:</p>
              <dl className="space-y-3">
                <Tool name="get_module_context">One file: what the code scan says it is, its exported symbols, who imports it, what it imports, the tests that cover it, and the approved lessons and past misses tied to it.</Tool>
                <Tool name="impact">A set of files: the files that depend on them by how many import hops away, the tests to run, and lessons and misses on everything impacted.</Tool>
              </dl>
              <p>
                <b>Hotspots</b> are where agents struggle. Each file gets a score:
              </p>
              <Pre>score = 4 × misses + log2(1 + churn) + log2(1 + dependents)</Pre>
              <p className="text-muted">
                <b>misses</b> counts confirmed misses whose session edited the file, <b>churn</b> its commits in the last 90 days and <b>dependents</b> the files
                that import it. One miss outweighs a busy file: a file agents got wrong once ranks above one that only changes a lot. The Projects page shows a
                project&apos;s hotspots (click a file for its module panel); Patterns lists the top ones across your selected projects.
              </p>
              <p className="text-muted">
                Test files are left out of the hotspots unless you tick include tests (Projects, or Code mode on the Graph page). Docs and config files score 0
                until a miss touches them.
              </p>
              <p className="text-muted">
                A big repo&apos;s map is capped: by default at 40% of the files worth mapping, from 400 to 4,000 (<Code>SCAN_MAX_FILES</Code> sets a number). The
                files your sessions edited come first, then source, then tests, manifests and docs. Source files up to <Code>CODE_MAP_MAX_BYTES</Code> (1 MB)
                are parsed, so large hub files keep their importers. The Code map card says when a map is capped and how many files it left out; a file
                past the cap that an agent names still gets its importers, tests and symbols.
              </p>
              <p className="text-muted">
                GDScript preload, load and extends paths link to the files they name (<Code>res://</Code> is the folder holding the nearest{' '}
                <Code>project.godot</Code>), and a <Code>class_name</Code> used elsewhere links to the file that declares it. A Swift import of a local module
                links to that module&apos;s files (a <Code>Package.swift</Code> target, or a <Code>Sources/&lt;Module&gt;</Code> folder).
              </p>
            </Section>

            <Section title="Linked projects, uploads and relevance">
              <dl className="space-y-4">
                <Page name="Pin">Pin a project on the Projects page (the pin beside it, or <b>Pin</b> in its header): pinned projects come first in every project list.</Page>
                <Page name="Link">
                  Projects that belong together (a game and its backend, an app and its site, a product and the library it vendors) can be linked under{' '}
                  <b>Linked projects</b>. An agent working in one then also gets the best past misses, facts and doc excerpts of the other, each labelled
                  with where it came from; lessons stay with the project they were learned in. Every <Code>LINK_SCAN_MINUTES</Code> (30) the worker looks
                  for links between your selected projects, without a model: a package manifest naming another project&apos;s package or a local path into
                  it, another project&apos;s repository named in its files, and its name in several files. These arrive as <b>suggestions</b> with their
                  evidence: nothing reaches an agent until you <b>Confirm</b> one. <b>Dismiss</b> keeps it from being suggested again; you can also link two
                  projects by hand, with a relation and a note on how they fit together.
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
              <p className="text-muted">
                Open a page below for how to read it. Colours mean the same everywhere: <b>blue</b> is waiting (pending, proposed, queued), <b>green</b> is
                done or kept (confirmed, approved), <b>red</b> is refused or failed, <b>grey</b> is neutral or retired. Only approved lessons ever reach
                agents: approved by you, or by the learning loop once your reviews have earned it. On a read-only install the owner buttons are disabled and say why. The full guide, with every badge, is <Code>docs/guide.md</Code>.
              </p>
              <div className="wide grid gap-3">
                <PageGuide name="Dashboard" shot="dashboard" summary="Ask first, then where everything stands, each part linked to its page.">
                  <li><b>Getting started</b>, first, until done: choose projects, connect your agent (the <Code>./scripts/install-agent.sh</Code> command to copy), confirm a miss, approve your first lesson. Each step ticks itself off; only the next one is spelled out.</li>
                  <li><b>Ask</b>, at the top: type a question, pick the project and the model (Default, Claude, Codex, Local model), press <Key>Enter</Key> (<Key>Shift</Key>+<Key>Enter</Key> for a new line): it opens a new chat on the Ask page. Starter questions fill the box; <b>suggested questions</b> ask about your hotspots; <b>recent chats</b> open your last conversations.</li>
                  <li><b>Now</b>: the worker (green running, red offline) and the step it is on; one badge per model job (classifier, post-mortem, scan, summaries, docs reader, chat, embeddings), red with the reason when it cannot be reached.</li>
                  <li><b>Pipeline</b> tiles: Inbox waiting on you, turns to classify (<b>1000+</b> when capped; opens Activity filtered to feedback flagged, with the backlog), post-mortems queued (opens the Inbox&apos;s confirmed tab), lessons <b>proposed / approved</b>, scans <b>done / queued / running / failed</b>. A dash means unknown. Under the tiles, a line per busy queue (scans, classify, post-mortems, Ask answers): how many wait, the oldest wait, and what runs now for how long, as <Code>fg status</Code> says it.</li>
                  <li><b>Quality</b>: <b>repeat rate</b> (confirmed feedback that repeats an earlier kind of miss; lower is better), <b>checks that caught a gap</b> (pre-done checks that found one), and feedback per week: grey first time, red repeats.</li>
                  <li><b>Learning loop</b>: the mode it runs in (and the one set, when a pause, <Code>LOOP_DISABLED</Code> or a tokenless install holds it lower), this week&apos;s applied, proposed and rolled-back decisions with a link to those waiting on <b>Decisions</b>, the rollback rate and model calls today, <b>Watch it</b> (the Learning loop page) and <b>Pause learning</b>.</li>
                  <li><b>Learning-loop metrics</b>, over the last weeks: <b>gaps fixed per serving</b> (gaps fixed per time a lesson was served) and <b>not applicable</b> (the share of the done check&apos;s verdicts that said a lesson did not apply), each with k of n and its 95% interval; proposals per week; and what was rolled back, by type. The repeat rate and checks that caught a gap are under Quality. It says <i>Nothing measured yet</i> until there is something to count.</li>
                  <li><b>Projects</b> (pinned first), <b>Where agents struggle</b> (files a confirmed miss touched; a file opens its module panel) and <b>Recent activity</b>, rows as on the Activity page. Each card loads on its own, so one error never blanks the page.</li>
                </PageGuide>

                <PageGuide name="Ask" shot="ask" summary="Chat about one project; the answer ends with a prompt for your agent.">
                  <li>A chat about one project, one conversation per topic. Ask what already exists (&quot;I want to add a modal: what do we have?&quot;) or where something belongs (&quot;where would feature X go?&quot;).</li>
                  <li><b>New chat</b>: pick the project and the model (Default, Claude, Codex, Local model; <Code>CHAT_LLM</Code> sets the default). The answer uses the project and its confirmed linked projects. The model gets only your question and that context, never the repository, and secret files are never read.</li>
                  <li>While it waits its turn, <b>Waiting for Claude: 2 questions ahead of this one…</b> counts up from when you asked; while it writes, <b>Answering with Claude… 0:42</b> counts up; a red box with <b>Retry</b> means it failed. The list shows a blue <b>answering</b> badge.</li>
                  <li><b>[S1]</b> in the answer points to <b>Sources</b>: kind badges <b>lesson</b> (green), <b>miss</b> (red), <b>fact</b> (accent), <b>code</b> (blue), doc, session, linked (grey). Code and facts open their file&apos;s module panel; a miss is cited by the file its session edited and opens that file&apos;s panel, where its past misses are listed.</li>
                  <li>Under each answer: the model that wrote it and the size of the <b>context pack</b> it was answered from (characters and sources). The list re-sorts when a conversation gets a message, and one answering in the background moves up once answered.</li>
                  <li><b>Examples</b>: existing code with <Code>path:lines</Code>, why it fits, and where it is used; each path opens its module panel.</li>
                  <li><b>Prompt for your agent</b>: <b>Copy</b> it into Claude Code or Codex. It names the files to read first and the Feedback Graph tools to use. Tip: select the tool&apos;s own folder in Settings and ask about it.</li>
                </PageGuide>

                <PageGuide name="Inbox" shot="inbox" summary="Possible pushback for you to confirm or reject. Only confirmed items are learned from.">
                  <li>Tabs <b>pending</b>, <b>confirmed</b>, <b>rejected</b>; filter by source, project, PR number and feedback author. Pending items stay in arrival order while you work.</li>
                  <li>Each row: a <b>source</b> badge (Claude accent, Codex grey, GitHub blue, Linear violet), <b>self-review</b> when an agent reviewed its own PR under the author&apos;s account, the project, and the classifier&apos;s <b>confidence %</b> that this is pushback, shown as &quot;87% sure&quot;, or <b>agent report</b> for a miss an agent sent with <Code>report_feedback</Code>, which no classifier scored.</li>
                  <li>The pane: the flagged turn (accent border, <b>flagged as pushback</b>) with the turns and the agent&apos;s reply around it. For a comment: the PR or Linear issue, its work session and author chips <b>reviewer</b> or <b>PR author</b> (blue), <b>AI agent</b> or <b>bot</b> (grey).</li>
                  <li>A grey <b>skip rule</b> note means the comment would be kept out if it came in today: a hint, the decision stays yours.</li>
                  <li><Key>j</Key>/<Key>k</Key> move, <Key>c</Key> confirm (sends it for a post-mortem, with your optional note), <Key>r</Key> reject (nothing is learned). The <b>confirmed</b> tab shows each post-mortem: waiting, retrying, gave up or done, with <b>Retry post-mortem now</b>.</li>
                </PageGuide>

                <PageGuide name="Lessons" shot="lessons" summary="Proposed lessons to approve. Approving is what agents learn from.">
                  <li>Tabs <b>proposed</b>, <b>approved</b> (agents get these), <b>rejected</b> (declined during review), <b>revoked</b> (previously approved, then withdrawn), <b>superseded</b> (replaced by a newer one). Filter by source, check, PR number and feedback author; an empty filtered list says nothing matches, with <b>Clear filters</b>.</li>
                  <li>In the header, <b>how your lessons were judged</b>: of the post-mortem&apos;s lessons decided in the last 30 days, how many you approved as written, approved after an edit, and rejected (open it for 90 days and each project), and how many an agent with the operator token decided. The edited and rejected ones (and one approved as written) are shown to the post-mortem as examples, so &quot;as written&quot; is the number to watch go up. <Code>fg lessons quality</Code>, <Code>fg status</Code> and <Code>/api/pipeline</Code> give the same numbers.</li>
                  <li>On the proposed tab, tick lessons (or <b>select all with flag</b>) and <b>Approve selected</b> or <b>Reject selected</b> in one confirm; the buttons stay in place, disabled until something is ticked, so the rows never move under the cursor.</li>
                  <li>Each row: the project or <b>global</b>, where it came from (<b>session pushback</b>, <b>GitHub review</b>, <b>Linear comment</b>, <b>agent report</b>, <b>memory file</b>, <b>by you</b>, <b>demo</b>; hover for the full wording), the <b>cause</b> with its dot, and red <b>check chips</b> from the automatic lesson check (hover for why), such as <b>needs a path</b>, <b>platitude</b>, <b>generic</b> (names no file, function, value or command; listed last, with the reason), <b>two lessons in one</b> or <b>&quot;applies when&quot; too narrow</b>. An accent <b>approved by agent</b> badge means an agent with the operator token decided, not you; an accent <b>changed by loop</b> chip means a change the learning loop made to it still stands (it approved, retired, reworded, narrowed or re-ranked it, and that was not rolled back or changed since), and its <b>Decisions</b> card says what and can roll it back.</li>
                  <li>Causes: <b>context missing</b> (blue), <b>context available, ignored</b> (red), <b>code not read</b> (green), <b>requirement unstated</b> (grey), <b>verification gap</b> (accent), <b>implementation error</b> (violet). The same colours on Patterns and in the Graph&apos;s node panel (the Graph canvas colours nodes by kind).</li>
                  <li>The pane: the check findings (headed <b>Before you approve</b> on a proposed lesson, <b>What the lesson check found</b> on any other), <b>You said</b> (or <b>The agent reported</b>), <b>What was missed</b>, context that would have prevented it (red <b>was available to the agent</b> or grey <b>not loaded in the session</b>), and fix commits. When &quot;applies when&quot; names only this one case, the check suggests a broader wording: <b>Use it</b> puts it in your draft; it is never applied for you.</li>
                  <li>Edit the title, rule, applies when, scope and <b>triggers</b> (path globs, added-line patterns and symbols, one per line, that bring the lesson to a task or change that matches). Scope is <b>task</b> (work like this one), <b>project</b>, or <b>global</b> (every project): prefer the narrowest; a global lesson narrowed to a project asks which one. <b>Approve</b> saves your edits and serves it; on an approved lesson <b>Save</b> keeps it approved with your edits; <b>Revoke</b> stops agents getting it straight away and moves it to revoked; <b>Back to proposed</b> reopens a rejected or revoked one.</li>
                  <li><b>Convert to fact</b>: a lesson that only states how the code is (often flagged <i>looks like a fact</i>) becomes a project fact you wrote. No scan replaces it, agents get it as a fact, and the lesson is rejected with the note <i>converted to a fact</i>.</li>
                </PageGuide>

                <PageGuide name="Decisions" summary="The learning loop's audit log: every decision, what it changed and why, and a way to undo it.">
                  <li>Filter by <b>status</b> (<i>proposed</i>, waiting for you, is the default; <i>applied</i>, <i>observed</i> (recorded only), <i>rolled back</i>, <i>overridden</i> (its target changed outside the decision: you edited it, or another process did, after it was applied, or before a proposal was approved), <i>rejected</i>, <i>expired</i>, <i>applying</i> (being written now)), type, applied or proposed, confidence band, project, target, dates and text. The filters stay in the address. <b>JSON</b> and <b>CSV</b> export every match.</li>
                  <li>The detail: its tier (<i>housekeeping</i>, <i>agent-facing</i>, <i>always proposed</i>), an accent <b>by loop</b> badge when the loop applied it, the confidence it was made with and how many of your reviews earned it, <b>What changed</b> field by field (before struck through, after, and a <b>now</b> column when the target moved on), <b>Why</b> (rationale, model, policy version), the <b>Evidence</b>, what it depends on and what depends on it, and <b>Notes</b> with agree or disagree.</li>
                  <li><b>Approve</b> or <b>Reject</b> a proposed or observed decision; <b>Keep</b> an applied one (you agree) or <b>Roll back</b> it: the dialog first lists the later decisions it would also undo and anything that blocks it. A later decision still applied to the same target blocks it: the dialog names it, with when it was applied, and opens it, to roll that one back first. When the target changed outside the decision since, the dialog marks it overridden and offers <b>Restore anyway</b>, which writes the old version over that change as your own edit; Cancel keeps the change and shows the decision as it is now. A proposal overridden before it was applied changed nothing, so it has nothing to restore. <Key>j</Key>/<Key>k</Key> move, <Key>a</Key> approves, <Key>x</Key> rejects, <Key>u</Key> rolls back.</li>
                  <li>Approving and <b>Keep</b> raise the loop&apos;s confidence in that type; rejecting and rolling back lower it. A note&apos;s verdict is kept with the decision but changes no confidence. An operator token&apos;s decisions never count.</li>
                </PageGuide>

                <PageGuide name="Learning loop" summary="The loop at work: its mode, this round, live events, and what each type has earned.">
                  <li>The global mode (<i>off</i>, <i>observe</i>, <i>propose</i>, <i>auto</i>) and <b>Pause learning</b>, which takes effect before its next write. A note says when it runs below its mode: paused, <Code>LOOP_DISABLED</Code>, or a tokenless install (<i>observe</i> at most).</li>
                  <li>Tiles: running as, proposals waiting, applied this week, the rollback rate, and the model calls and changes applied on its own today. <b>This round</b> shows its phase, progress and counts, and why targets were skipped; <b>Live</b> streams its events, each linking to its decision.</li>
                  <li><b>Decision types</b> and <b>Calibration</b>: each type&apos;s tier, mode, bar τ, the confidence it has earned from your reviews with its lower bound (green once it clears τ), its rollbacks and its circuit breaker. The gate reads the band of each call&apos;s score, not the type&apos;s total: <b>By confidence band</b> shows each band&apos;s reviews and lower bound.</li>
                  <li><b>Track record</b> of a lesson: how often it was served, how the done check judged it, gaps it caught that were fixed, repeats of its miss, your pushback and edits, and its timeline. <b>Holdout comparison</b>: the lessons the loop never changes against the rest, with a 95% interval.</li>
                </PageGuide>

                <PageGuide name="Graph" shot="graph" summary="The evidence chain behind each miss, or a project's code map." extraShot={{ name: 'graph-code', alt: 'The Graph page in Code mode' }}>
                  <li><b>Evidence</b> mode: feedback, misses, causes, lessons, context, tasks and fix commits, coloured as in the legend (with counts). Causes are the biggest circles, misses medium. Click a node for its text and connections; click a connection to move to it.</li>
                  <li><b>Code</b> mode draws one project&apos;s code map: its top hotspot files sized by score (red when misses touched them; lighter circles are tests), their imports (arrows) and tests (dashed), and the misses (diamonds) and lessons (squares) on them; click a file for its module panel. Files never overlap and folders form their own clusters; a large map takes a few seconds to settle and fit.</li>
                  <li>Twelve key files (files with misses first, then hotspot score, then the most connections) and every file with misses are named at every zoom, over other nodes on a halo if need be; a file with misses wears a red ring and its name says how many. Zoom in to name every file. Hover for the full path, score and misses. <b>Find a file by path</b> opens any mapped file. A note says when the drawing or the map is capped.</li>
                </PageGuide>

                <PageGuide name="Patterns" shot="patterns" summary="Whether misses repeat, why they happen, and where agents struggle.">
                  <li><b>repeat rate</b> = repeats ÷ confirmed feedback, where a repeat is the same kind of miss as an earlier one. It should fall over time.</li>
                  <li><b>checks that caught a gap</b> (the catch rate) = pre-done checks that found a gap ÷ all pre-done checks.</li>
                  <li><b>Why misses happen</b> (one bar per cause), <b>Feedback per week</b> (grey first time, red repeats), <b>Where agents struggle</b> (files a confirmed miss touched, by hotspot score), and <b>Repeated misses</b> grouped with their count, projects, cause and last date. A part that could not load says so, with <b>Retry</b>.</li>
                </PageGuide>

                <PageGuide name="Sessions" shot="sessions" summary="A running summary of each agent session.">
                  <li>A running summary of each session of the selected projects: its goal, what was done and decided, open threads, pushback and files touched.</li>
                  <li><b>active</b> (blue): turns are still coming in. <b>idle</b> (grey): quiet for half an hour and summarized to its last turn, complete for now until it continues. An accent <b>n new</b> badge counts turns not yet in the summary.</li>
                  <li>The worker summarizes a session once it has been quiet for a few minutes, then only the newer turns, merged in. <b>Update history</b> lists each update with the turns it took in. <b>Rebuild summary</b> redoes it from the first turn.</li>
                  <li><b>Flagged in this session</b> links its Inbox items and lessons. Summaries stay on this machine: they are never exported or synced.</li>
                </PageGuide>

                <PageGuide name="Projects" shot="projects" summary="Links, code map, facts, docs and your data, per project." extraShot={{ name: 'projects-facts', alt: 'Code facts on the Projects page' }}>
                  <li><b>Pin</b> lists a project first everywhere. <b>Scan</b> reads its code into facts with the model you choose; the last scan shows status, files, facts and its place in the queue.</li>
                  <li><b>Linked projects</b>: confirmed links (accent relation) give agents here the best matches from the other project. <b>Suggested</b> links show the evidence and its strength in %; they do nothing until you <b>Confirm</b> (<b>Undo</b> stays for a few seconds).</li>
                  <li><b>Code map</b>: files (&quot;400 of 10,290&quot; when capped by <Code>SCAN_MAX_FILES</Code>), symbols, edges, and <b>last checked</b> (when it was built shows under it; hover a time for the exact one). It says when a rebuild is running or was cut short, with the next step; <b>Rebuild map</b> remaps from scratch. Hotspots sort by churn (commits in 90 days), misses, dependents (importers) and <b>score = 4 × misses + log2(1 + churn) + log2(1 + dependents)</b>. A file opens its module panel: what it is, symbols, importers, imports, tests, approved lessons and past misses. A file past the map&apos;s cap opens a panel that says so, how many files the map keeps, and that <Code>SCAN_MAX_FILES</Code> raises it.</li>
                  <li><b>Code facts</b> by relevance: <b>everyday</b> (green, 0.8 and up, agents get it first), <b>sometimes</b> (blue), <b>rare</b> (grey, below 0.4, only when a task is about it), <b>unscored</b>. Evidence: <b>line checked</b>, <b>file only</b>, <b>not checkable (no file)</b>. A <b>manifest</b> badge means read without a model, <b>loop</b> that the learning loop recorded it, and an accent <b>yours</b> that you wrote it. <b>how was this created?</b> shows the model, reason, file version and scan; the band buttons set relevance yourself.</li>
                  <li><b>Docs and discussions</b>: uploads read into facts show queued, reading, <b>not read</b> (with <b>retry</b>) or <b>n facts</b>. <b>Export</b> downloads a JSON bundle; <b>Delete project data</b> removes everything learned, after you type the name. <b>Import bundle</b> brings lessons back as proposed unless you tick keep approved.</li>
                </PageGuide>

                <PageGuide name="Activity" shot="activity" summary="The log of everything created or changed, by whom, and why.">
                  <li>The log of everything the tool created or changed, who or what did it, and why, including each <b>code mapped</b> build with its size and duration. Each row: what happened on one line (hover for all of it) with its kind on the right; under it when (hover for the exact time), who, and the run as small chips, then why. Click a row for its details and the ids it touched.</li>
                  <li>Filter by project, kind and <b>run</b> (type a run id). <b>hide labelled runs</b> is on by default, so a tester&apos;s or a script&apos;s runs do not bury what you and the worker did; the page says how many it hid. <b>Collapse repeated scan retries</b>, also on by default, shows a scan retry, backoff or park only once.</li>
                  <li><b>By</b>: <b>you</b>; <b>operator:&lt;name&gt;</b>, an agent with the operator token acting for you; <b>loop:&lt;v&gt;</b>, the learning loop on its own under policy version <i>v</i> (<b>loop:breaker</b> when its circuit breaker turned a type down to <i>propose</i>); a model id like <Code>ollama:gemma4</Code>; an agent over MCP like <Code>claude-code</Code>; or a pipeline step such as <b>deterministic</b>, <b>skip-rules</b> or <b>lesson-check</b>. Hover an actor, or read the legend above the list, for which kind it is.</li>
                  <li>Kind colours: decisions take the colour of what was decided (green confirmed or approved, red rejected); <i>post-mortem</i> green and <i>post-mortem failed</i> red; <i>project deleted</i> red; <i>cloud sync</i> green, or red when it failed; <i>feedback flagged</i> blue; <i>loop applied</i> green, <i>loop rolled back</i> red and <i>loop paused</i> accent; every other kind grey.</li>
                </PageGuide>

                <PageGuide name="Settings" shot="settings" summary="Which project folders are read, the connections, and the learning loop, in five tabs.">
                  <li>Five tabs: <b>Projects</b>, <b>Integrations</b>, <b>Cloud sync</b>, <b>Learning loop</b>, <b>Clean up</b>. A link to a card opens its tab; unsaved folder changes stay in the bar on every tab.</li>
                  <li><b>Projects</b>: which project folders are read. Tick folders and press <b>Save selection</b>. Badges: <b>selected</b> (green), <b>adding</b> or <b>stopping</b> (unsaved), <b>excluded</b>, <b>clone of</b> another folder, <b>missing folder</b>, <b>has data</b>. A greyed box says why on hover.</li>
                  <li><b>Where folders come from</b> holds the project roots: add or remove them there (there is none by default), and the folders sessions ran in outside them are suggested with their session counts, each one click from being a root. A saved change is mounted when you run <Code>./scripts/setup.sh</Code>, which restarts the containers. A folder that is not a git repo but holds repos one or two levels down is not one project: each git repo inside it is a project of its own.</li>
                  <li><b>Integrations</b> (GitHub, Linear, read-only; a token saved here wins over one in <Code>.env</Code>; Linear syncs nothing until a team is mapped to a project, and says so), the comment <b>skip rules</b> with their counts, <b>Cloud sync</b>, and <b>Clean up</b>, which deletes the data of projects you have not selected. Every other page shows only the selected projects; Settings is the one place that lists every folder.</li>
                  <li><b>Learning loop</b>: what the loop may do on its own: the global mode, a mode and a bar <b>τ</b> per type (τ can only be raised), each type&apos;s earned confidence, reviews, rollbacks and breaker (choose <i>auto</i> again to clear a tripped one), the day&apos;s budget, and <b>Pause learning</b>. <Code>LOOP_DISABLED=1</Code> in <Code>.env</Code> stops it in a way this tab cannot undo. <b>Save loop settings</b> saves it.</li>
                </PageGuide>
              </div>
            </Section>

            <Section title="The learning loop">
              <p>
                The loop runs in the worker after each round of new activity. It reads what happened to the graph since it last ran (misses that repeated,
                what the done check found, which lessons you approved, edited or rejected) and makes <b>decisions</b>: link misses that are the same
                miss, merge duplicate lessons, retire or reject ones that never help, approve or narrow a lesson, reword or split one, record a fact,
                tune ranking weights and thresholds, and triage the Inbox.
              </p>
              <ul className="list-disc space-y-2 pl-6 marker:text-faint">
                <li><b>What it may do alone.</b> It runs in <i>auto</i> by default. Housekeeping (linking, merging, re-ranking, retiring) applies on its own from the start. Anything that changes what agents are told, approving a proposed lesson included, applies on its own only once your own reviews of that type's proposals have earned it in the call's confidence band (at least 20 reviews in that band, with the band's lower bound at its bar τ or above: 0.9 for approving), at most 5 a day and 2 per project; until then it waits as a proposal. Some types are always proposals. To keep every such change yours, set the mode to <i>propose</i>.</li>
                <li><b>Everything is audited.</b> Each decision on the <b>Decisions</b> page shows what changed field by field, why, the evidence and its confidence. <b>Roll back</b> restores exactly what was there, with any later decisions that built on it. Approving, <b>Keep</b> and rollbacks teach it (your notes are kept with the decision but do not change its confidence); an operator token&apos;s never count.</li>
                <li><b>Guard rails.</b> It never changes on its own a lesson you changed in the last 14 days (it only proposes), and never touches lessons you wrote, demo lessons or your own facts. Daily caps, a circuit breaker per type (two rollbacks in a week drop it back to proposals) and <b>Pause learning</b> bound it. A changed lesson is not synced to a team until you keep it or 7 days pass.</li>
                <li><b>Is it helping?</b> A fixed share of lessons (<Code>LOOP_HOLDOUT</Code>, 20%) is never changed, and the <b>Learning loop</b> page compares their repeat rate with the rest.</li>
                <li><b>Modes.</b> <i>off</i>, <i>observe</i> (records what it would do), <i>propose</i> (asks first) and <i>auto</i>, globally or per type, on the Learning loop page or with <Code>fg loop mode</Code>. An install with neither <Code>API_TOKEN</Code> nor <Code>FG_OWNER_TOKEN</Code> runs it in <i>observe</i> only. Upgrading with tokens set, the first start seeds <i>auto</i>; put <Code>LOOP_MODE=observe</Code> or <Code>propose</Code> in <Code>.env</Code> before it to start cautiously.</li>
              </ul>
              <p className="text-muted">The full reference is <Code>docs/guide.md</Code> (Decisions, Learning loop) and <Code>docs/learning-loop-types.md</Code>.</p>
            </Section>

            <Section title="Choosing models">
              <p>
                By default everything runs on Ollama on your machine (<Code>gemma4</Code> and <Code>nomic-embed-text</Code>), so nothing leaves it. Post-mortems are
                much better on Claude: run <Code>claude setup-token</Code>, put the token in <Code>.env</Code> as <Code>CLAUDE_CODE_OAUTH_TOKEN</Code>, and post-mortems switch to
                Claude automatically. Each job (<Code>CLASSIFY_LLM</Code>, <Code>POSTMORTEM_LLM</Code>, <Code>SCAN_LLM</Code>, <Code>CHECK_LLM</Code>, <Code>SUMMARY_LLM</Code> for session
                summaries, where <Code>off</Code> turns them off, <Code>DOCS_LLM</Code> for reading uploads, which needs vision for images, <Code>CHAT_LLM</Code> for Ask,
                <Code>LOOP_LLM</Code> for the learning loop&apos;s rewrites and replay judge) can also
                be set on its own; <Code>.env.example</Code> lists the providers.
              </p>
              <p>
                The CLI agents read code differently. <Code>claude-cli</Code> can read only the project folder it is working on, and not the secret files in
                it. <Code>codex-cli</Code> cannot be confined that way inside the worker, so it runs in its own container: set <Code>CODEX_RUNNER_URL=http://codex-runner:8790</Code> and
                add <Code>codex</Code> to <Code>COMPOSE_PROFILES</Code>. That container holds only the Codex CLI, your Codex login and a copy of the project without its secret
                files, so that copy is all Codex can read. Without it, inside the worker Codex can read every file the worker can, which is every transcript, every project folder with its .env files,
                the worker&apos;s state, your Codex login and the worker&apos;s own secrets, and it only runs once you set <Code>ALLOW_UNCONFINED_CODEX=1</Code> to accept that.
              </p>
              <p>
                <Code>CHECK_LLM</Code> judges <b>check_before_done</b> inside the api, which has no agent CLIs, so it takes Ollama or an API model, not <Code>claude-cli</Code> or <Code>codex-cli</Code>.
              </p>
            </Section>

            <Section title="Limit what it reads">
              <ul className="list-disc space-y-2 pl-6 marker:text-faint">
                <li>The containers see only the project roots you add in <SettingsLink /> (read-only), never your whole home folder.</li>
                <li>You choose the project folders to read in <SettingsLink />: tick them and press <b>Save selection</b>. Each folder shows how many Claude Code and Codex sessions ran in it. Unselecting a folder stops reading it and hides it everywhere but Settings (agents stop getting its lessons too); what was learned is kept until <b>Clean up</b> on the same page removes the data of every unselected project.</li>
                <li><Code>EXCLUDE_PROJECTS</Code>: never these, whatever is selected. <Code>INGEST_PROJECTS</Code> only sets the selection on the very first start.</li>
                <li><Code>TURN_RETENTION_DAYS</Code>: drop old message text after that many days. A turn keeps its text until its session summary covers it; summaries are never dropped.</li>
                <li>Secrets are redacted before anything is stored or sent to a model, and secret files are never read, nor named in a lesson trigger or a check. See <Code>SECURITY.md</Code> for details.</li>
              </ul>
              <p className="text-muted">Restart after changing <Code>.env</Code>: <Code>docker compose up -d</Code>.</p>
            </Section>

            <Section title="GitHub and Linear">
              <p>
                Reviewers push back too. Connect GitHub or Linear and comments on your pull requests and Linear issues arrive in the <b>Inbox</b>, marked{' '}
                <b>GitHub</b> or <b>Linear</b>, with the author, a link to the comment and, for a review comment, the file, line and diff lines. The same
                classifier as for sessions picks out pushback and corrections; you confirm or reject them as usual.
              </p>
              <ol className="list-decimal space-y-2 pl-6 marker:font-semibold marker:text-muted">
                <li>
                  In <SettingsLink />, under <b>Integrations</b>, paste a token and press <b>Connect</b>. It is checked with one read-only call and saved only if
                  it works. For GitHub use a fine-grained token with only your projects&apos; repositories and <b>Pull requests</b> and <b>Issues</b> read-only; for
                  Linear a personal API key. A token in <Code>.env</Code> (<Code>GITHUB_TOKEN</Code>, <Code>LINEAR_API_KEY</Code>) shows as &quot;set in .env&quot;; one saved here wins over it, and <b>Disconnect</b> goes back to it.
                </li>
                <li>Each selected project with a github.com remote is linked to its repository (<Code>GITHUB_REPOS</Code> overrides it). For Linear, pick each project&apos;s team.</li>
                <li>Every 10 minutes (<Code>INTEGRATION_SYNC_MINUTES</Code>) new comments are read; the first sync goes back 14 days. Bots are skipped.</li>
              </ol>
              <p>
                A confirmed comment&apos;s post-mortem reads the agent session that did the work: only a session that worked on the pull request&apos;s branch or
                edited its files, never one for being nearest in time. With none, it works from the comment and the pull request alone, and says so.
              </p>
              <p className="text-muted">
                Tokens stay on this machine (a mode 600 file, never the database) and are never shown again. A revoked token or a rate limit pauses that
                service and says so in Settings and in the connections list in the sidebar.
              </p>
            </Section>

            <Section title="Share with a team">
              <p>
                Cloud sync is optional and off by default: unless you configure it, nothing is sent anywhere. With a Feedback Graph Cloud org, your approved
                lessons become your team&apos;s: teammates&apos; agents get them through the team MCP endpoint, matched by git remote.
              </p>
              <ol className="list-decimal space-y-2 pl-6 marker:font-semibold marker:text-muted">
                <li>In the cloud web app, create an access token with the <b>sync</b> scope.</li>
                <li>Set <Code>CLOUD_URL</Code> (https) and <Code>CLOUD_TOKEN</Code> in <Code>.env</Code>, and restart.</li>
                <li>Press <b>Sync now</b> on the Cloud sync card in <SettingsLink />, or set <Code>SYNC_INTERVAL_MINUTES</Code> to sync on a schedule. <Code>SYNC_PROJECTS</Code> narrows which selected projects are sent.</li>
              </ol>
              <p>
                <b>Sent</b>, per selected project: its key and git remote, its approved lessons (with their triggers), misses (what was missed and why),
                current code facts, document titles and links, and the code map&apos;s file paths with their hotspot numbers. Only approved lessons leave: they become the
                team&apos;s (or wait for an admin, if your org reviews them), and a proposed lesson stays on this machine until it is approved, unless you set{' '}
                <Code>SYNC_SUGGESTIONS</Code> to <Code>true</Code> to send proposed ones to an admin as suggestions; a lesson you reject or move back to proposed, or anything you delete, is taken
                back out of the team graph on the next sync. A lesson or fact the learning loop changed on its own is sent as it was before until you
                <b>Keep</b> that decision or <Code>LOOP_SYNC_HOLD_DAYS</Code> (7) pass without a rollback. A project you stop syncing (unselected, excluded, or left out of <Code>SYNC_PROJECTS</Code>)
                gets one last, empty bundle on the next sync that takes back what was sent for it. Every sync is logged in <b>Activity</b> with the counts and the cloud&apos;s host.
              </p>
              <p className="text-muted">
                Never sent: session transcripts (including the feedback you typed), session summaries, source code, file excerpts, document text, embeddings,
                or anything new from a project you have not selected. A project with no shareable git remote lands in your personal space in the org, visible
                only to you.
              </p>
            </Section>

            <Section title="Runs, sandboxes and testing">
              <p>
                For testers and automation: label a run&apos;s requests and everything it writes can be found, kept apart and removed, without touching yours.
              </p>
              <dl className="space-y-3">
                <Tool name="x-fg-run: <id>">
                  A run id (1 to 64 letters, digits, dots, dashes or underscores) on the request header, <Code>?run=&lt;id&gt;</Code> on <Code>/mcp</Code>, or{' '}
                  <Code>fg --run &lt;id&gt;</Code> (<Code>FG_RUN</Code>). What the run writes records the id, and Activity shows it (hidden by default there:
                  untick <b>hide labelled runs</b>, or filter by the run). A run belongs to whoever opened it: a write under another caller&apos;s run id is refused,
                  and a run never replaces, decides on or removes your records (a 409); your decision on something a run made makes it yours.
                </Tool>
                <Tool name="x-fg-sandbox: 1">
                  With a run id (<Code>fg --run &lt;id&gt; --sandbox</Code>): a sandbox run. Its records reach only that run, in every list, search, count, Ask pack
                  and code map answer, and are never exported or synced.
                </Tool>
                <Tool name="fg cleanup --run <id>">
                  Removes only what that run wrote: a dry run first (counts per kind, what stays and why), <Code>--apply</Code> to do it, keeping anything you
                  decided on since. The operator token may clean up only runs it opened; a run already cleaned up says there is nothing to remove.
                </Tool>
                <Tool name="fg evidence <session>">
                  What the tool saw in one session and what it decided: its turns, the detector&apos;s call on each and the skip rules, the Inbox items with their
                  post-mortem and lesson, and the context served (<Code>GET /api/sessions/:id/evidence</Code>).
                </Tool>
                <Tool name="fg demo seed / fg demo remove">
                  A small corpus marked demo in demo-shop (approved lessons tied to files, a miss, facts), so the lesson path can be tried on a fresh install.
                  Running it is your approval of those demo lessons; <Code>fg demo remove</Code> takes back exactly what it wrote, never a file a scan recorded.
                </Tool>
                <Tool name="fg demo context / fg demo check">
                  Call the agent tools on demo-shop without an agent session: what <Code>get_task_context</Code> serves before an edit of its routes, and what{' '}
                  <Code>check_before_done</Code> says about a diff that breaks a seeded lesson.
                </Tool>
              </dl>
            </Section>

            <Section title="When something looks wrong">
              <ul className="list-disc space-y-2 pl-6 marker:text-faint">
                <li><b>First, run <Code>./scripts/doctor.sh</Code>:</b> it checks Docker, ports, Ollama (with a real structured-output call), the mounts, the Codex login and GitHub and Linear, and says how to fix each failure.</li>
                <li><b>Buttons are disabled and a Read-only banner shows:</b> the install has no owner token. Run <Code>./scripts/setup.sh --yes --enable-auth</Code>, then sign in with <Code>./scripts/fg signin</Code>.</li>
                <li><b>Nothing seems to happen:</b> the empty Inbox, Lessons and Graph pages say where the pipeline stands and every stage&apos;s backlog. The first hours of a big selection go to classifying and scanning.</li>
                <li><b>Inbox is empty:</b> the worker classifies newest sessions first; check the badge (it says <b>no projects selected</b> when nothing is being read), and that the project is ticked in <SettingsLink /> and not excluded.</li>
                <li><b>Badge says classifier unavailable</b> (or post-mortem / scan model unavailable, or summaries paused for the summary model): that model could not be asked at all (not running, not pulled, signed out, rate limited); the tooltip gives the reason. That work waits and nothing is charged against it, so fixing the model is enough. Turns given up on earlier can be tried again with <b>Re-queue</b> in the empty Inbox.</li>
                <li><b>A GitHub comment never reached the Inbox:</b> bots, the pull request author&apos;s replies to a reviewer, status notes and bare review triggers are skipped before the classifier; <SettingsLink /> lists the rules.</li>
                <li><b>Post-mortem never appears:</b> Inbox → Confirmed shows whether it is waiting, failed (with the error) or gave up, with a retry button.</li>
                <li><b>Agents get no lessons:</b> lessons must be approved, and the agent must be working inside a selected project&apos;s folder.</li>
                <li><b>Backups, upgrades, running it for a team:</b> see <Code>docs/operations.md</Code>.</li>
              </ul>
            </Section>
          </article>
        </div>
      </ScrollArea>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section id={slug(title)} aria-labelledby={`${slug(title)}-h`} className={`scroll-mt-16 space-y-4 border-b border-line py-10 last:border-0 lg:scroll-mt-8 ${MEASURE}`}>
      <h2 id={`${slug(title)}-h`} className="text-[24px] leading-tight font-semibold tracking-[-0.015em] [font-stretch:92%] md:text-[26px]">{title}</h2>
      {children}
    </section>
  );
}

/** A heading inside a section. */
function Sub({ children }: { children: ReactNode }) {
  return <h3 className="pt-3 text-[1.1em] leading-snug font-semibold">{children}</h3>;
}

function Tool({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-l-2 border-line-strong pl-4">
      <dt className="font-semibold"><Code>{name}</Code></dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A screenshot from public/guide/, in a bordered frame. The images are added separately; until one exists (or if it
 * fails to load) the frame hides itself, so the page never shows a broken image.
 */
export function GuideShot({ name, alt }: { name: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure style={failed ? { display: 'none' } : undefined} className="my-3 max-w-6xl overflow-hidden rounded-md border border-line bg-sunken shadow-card">
      <img src={`/guide/${name}.png`} alt={alt} loading="lazy" onError={() => setFailed(true)} className="block h-auto w-full" />
    </figure>
  );
}

/** One page of the UI: what it is for in the summary line, and how to read it (with its screenshot, when it has one) when opened. */
function PageGuide({ name, shot, summary, extraShot, children }: { name: string; shot?: string; summary: string; extraShot?: { name: string; alt: string }; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-line bg-surface">
      {/* On a phone the summary goes under the name at full width and a size smaller, rather than in a narrow column beside a fixed one. */}
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 px-4 py-3 select-none hover:bg-sunken sm:flex-nowrap [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-[11px] text-faint transition-transform group-open:rotate-90">▶</span>
        <span className="font-semibold sm:w-24 sm:shrink-0">{name}</span>
        <span className="min-w-0 basis-full pl-[calc(11px+0.75rem)] text-muted max-sm:text-[15px] max-sm:leading-snug sm:basis-auto sm:pl-0">{summary}</span>
      </summary>
      <div className="border-t border-line px-4 pt-2 pb-4">
        {shot && <GuideShot name={shot} alt={`The ${name} page`} />}
        <ul className="max-w-[54em] list-disc space-y-2 pl-6 marker:text-faint">{children}</ul>
        {extraShot && <GuideShot name={extraShot.name} alt={extraShot.alt} />}
      </div>
    </details>
  );
}

function Page({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 md:grid-cols-[7.5rem_minmax(0,1fr)] md:gap-5">
      <dt className="font-semibold">{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A key to press, sized with the text around it (the app's Kbd is drawn for 13px controls). */
const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-block min-w-[1.5em] rounded-[4px] border border-line-strong border-b-2 bg-surface px-[0.35em] text-center font-mono text-[0.8em] leading-[1.45] font-medium text-muted">{children}</kbd>
);
const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[4px] border border-line bg-sunken px-[0.3em] py-px font-mono text-[0.84em] break-words">{children}</code>
);
const Pre = ({ children }: { children: ReactNode }) => (
  <ScrollArea as="pre" className="overflow-x-auto rounded-md border border-line bg-sunken px-4 py-3 font-mono text-[14px] leading-relaxed">{children}</ScrollArea>
);

/** Pages are addressed by the hash, so a plain link switches to Settings. */
function SettingsLink() {
  return <a href="#settings" className="font-semibold text-accent-text underline decoration-accent/50 underline-offset-2 hover:decoration-accent">Settings</a>;
}
