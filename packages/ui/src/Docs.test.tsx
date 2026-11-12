import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, onTestFinished } from 'vitest';
import { Docs } from './Docs.tsx';

afterEach(cleanup);

test('each page in the Docs has a screenshot from /guide/, framed, loaded lazily, that hides itself when it fails to load', () => {
  render(<Docs />);
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  const shots = pages.getAllByRole('img');
  expect(shots.map((i) => i.getAttribute('src'))).toEqual(
    ['dashboard', 'ask', 'inbox', 'lessons', 'graph', 'graph-code', 'patterns', 'sessions', 'projects', 'projects-facts', 'activity', 'settings'].map((n) => `/guide/${n}.png`),
  );
  for (const img of shots) {
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBeTruthy();
  }
  const inbox = pages.getByAltText('The Inbox page');
  const frame = inbox.closest('figure')!;
  expect(frame.className).toMatch(/border-line/);
  expect(frame.style.display).toBe('');
  fireEvent.error(inbox);
  expect(frame.style.display).toBe('none');
  // The other screenshots are not affected.
  expect(pages.getByAltText('The Lessons page').closest('figure')!.style.display).toBe('');
});

test('the Each page section says how to read the badges and numbers, one collapsible entry per page', () => {
  render(<Docs />);
  const section = screen.getByRole('region', { name: 'Each page' });
  const pages = within(section);
  expect(section.querySelectorAll('details')).toHaveLength(12);
  expect(pages.getByText(/confidence %/)).toBeTruthy();
  expect(pages.getByText(/approved by agent/)).toBeTruthy();
  expect(pages.getByText(/operator:<name>/)).toBeTruthy();
  expect(pages.getByText(/the catch rate/).textContent).toMatch(/pre-done checks that found a gap ÷ all pre-done checks/);
  expect(pages.getByText('docs/guide.md')).toBeTruthy();
});

test('Each page has guides for Decisions and the Learning loop (no screenshot yet) and the five Settings tabs', () => {
  render(<Docs />);
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  expect(pages.getByText(/The learning loop's audit log/)).toBeTruthy();
  expect(pages.getByText(/The loop at work/)).toBeTruthy();
  expect(pages.queryByAltText('The Decisions page')).toBeNull();
  expect(pages.getByText(/Five tabs/).textContent).toMatch(/Projects, Integrations, Cloud sync, Learning loop, Clean up/);
  expect(pages.getByText(/loop:breaker/)).toBeTruthy();
});

test('the Docs say the learning loop runs in auto by default and may approve lessons once your reviews earn it', () => {
  render(<Docs />);
  const loop = within(screen.getByRole('region', { name: 'The learning loop' }));
  expect(loop.getByText(/What it may do alone/).closest('li')!.textContent).toMatch(/runs in auto by default.*approving a proposed lesson included/);
  expect(screen.getByText(/You approve\./).closest('li')!.textContent).toMatch(/may approve a lesson itself, but only once your own reviews/);
  // The diagram and its caption say so too, not that every lesson waits for you.
  const figure = document.querySelector('figure')!;
  expect(figure.querySelector('figcaption')!.textContent).toMatch(/approved \(by you, or by the learning loop once your reviews have earned it\)/);
  // A box's subtitle wraps onto lines of its own where the column is narrow.
  expect(figure.querySelector('svg')!.textContent!.replace(/\s+/g, ' ')).toMatch(/you approve, or the loop once earned/);
  expect(figure.querySelector('svg desc')!.textContent).toMatch(/or the learning loop, once your reviews have earned it/);
});

test('the page guides name the learning-loop metrics card and say Patterns lists only files a confirmed miss touched', () => {
  render(<Docs />);
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  expect(pages.getByText('Learning-loop metrics').closest('li')!.textContent).toMatch(/gaps fixed per serving.*95% interval/);
  expect(pages.getByText(/files a confirmed miss touched, by hotspot score/)).toBeTruthy();
});

test('the Docs page explains the code map, its two agent tools and how hotspots are scored', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'The code map' }));
  expect(section.getByText('get_module_context')).toBeTruthy();
  expect(section.getByText('impact')).toBeTruthy();
  expect(section.getByText(/4 × misses \+ log2\(1 \+ churn\) \+ log2\(1 \+ dependents\)/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'The code map' })).toBeTruthy();
  expect(screen.getAllByText('files_changed').length).toBeGreaterThan(0);
});

test('the Docs page explains cloud sync: off by default, what is sent and what never is', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'Share with a team' }));
  expect(section.getByText(/off by default/i)).toBeTruthy();
  expect(section.getByText('CLOUD_URL')).toBeTruthy();
  expect(section.getByText('CLOUD_TOKEN')).toBeTruthy();
  expect(section.getByText('SYNC_INTERVAL_MINUTES')).toBeTruthy();
  expect(section.getByText(/Never sent/)).toBeTruthy();
  expect(section.getByText('SYNC_SUGGESTIONS')).toBeTruthy();
  expect(section.getByText(/Only approved lessons leave/)).toBeTruthy();
  expect(section.getByText(/a lesson you reject or move back to proposed, or anything you delete, is taken\s+back out of the team graph/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Share with a team' })).toBeTruthy();
});

test('the Docs page says what each CLI agent can read, how codex-cli runs confined, and that it needs an acknowledgement without that', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'Choosing models' }));
  expect(section.getByText(/only the project folder it is working on/)).toBeTruthy();
  expect(section.getByText('CODEX_RUNNER_URL=http://codex-runner:8790')).toBeTruthy();
  expect(section.getByText(/holds only the Codex CLI, your Codex login and a copy of the project/)).toBeTruthy();
  expect(section.getByText('ALLOW_UNCONFINED_CODEX=1')).toBeTruthy();
  expect(section.getByText(/every transcript, every project folder with its \.env files/)).toBeTruthy();
  expect(section.getByText(/judges/).textContent).toMatch(/CHECK_LLM judges check_before_done inside the api, which has no agent CLIs/);
});

test('the Docs page explains an unavailable-model badge and re-queueing given-up turns', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'When something looks wrong' }));
  expect(section.getByText(/classifier unavailable/)).toBeTruthy();
  expect(section.getByText(/Re-queue/)).toBeTruthy();
});

test('the Docs page covers the Graph page Code mode, hotspots without tests, GDScript and Swift imports, and nested repos', () => {
  render(<Docs />);
  const map = within(screen.getByRole('region', { name: 'The code map' }));
  expect(map.getByText(/Test files are left out of the hotspots unless you tick include tests/)).toBeTruthy();
  expect(map.getByText(/GDScript preload, load and extends paths/)).toBeTruthy();
  expect(map.queryByText(/Imports are not resolved for\s+GDScript and Swift/)).toBeNull();
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  expect(pages.getByText(/mode draws one project's code map/).textContent).toMatch(/Code mode draws one project's code map/);
  expect(pages.getByText(/each git repo inside it is a project of its own/)).toBeTruthy();
});

test('the Docs page names SUMMARY_LLM as a job model and says retention keeps text a summary has not covered', () => {
  render(<Docs />);
  const models = within(screen.getByRole('region', { name: 'Choosing models' }));
  expect(models.getByText('SUMMARY_LLM')).toBeTruthy();
  const limit = within(screen.getByRole('region', { name: 'Limit what it reads' }));
  expect(limit.getByText(/until its session summary covers it/)).toBeTruthy();
});

test('the Docs page covers 0.6.2: runs, sandboxes, cleanup, evidence and the demo corpus, each with its command', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'Runs, sandboxes and testing' }));
  for (const name of ['x-fg-run: <id>', 'x-fg-sandbox: 1', 'fg cleanup --run <id>', 'fg evidence <session>', 'fg demo seed / fg demo remove']) expect(section.getByText(name)).toBeTruthy();
  expect(section.getByText(/never exported or synced/)).toBeTruthy();
  expect(section.getByText(/a dry run first/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Runs, sandboxes and testing' })).toBeTruthy();
});

test('connecting agents covers how check_before_done reads the diff, headless Claude Code and Codex, and a second install', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'Connect your agents' }));
  expect(section.getByText(/Cannot tell from the diff/)).toBeTruthy();
  expect(section.getByText(/--allowedTools "mcp__plugin_feedback-graph_fg"/)).toBeTruthy();
  expect(section.getByText(/default_tools_approval_mode/)).toBeTruthy();
  expect(section.getByText('FG_INSTANCE')).toBeTruthy();
  expect(section.getByText('feedback-graph-<name>')).toBeTruthy();
});

test('Each page explains the queue lines, the lesson quality numbers and the Activity run filter', () => {
  render(<Docs />);
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  expect(pages.getByText(/a line per busy queue/)).toBeTruthy();
  expect(pages.getByText(/how your lessons were judged/)).toBeTruthy();
  expect(pages.getByText('fg lessons quality')).toBeTruthy();
  expect(pages.getByText(/hide labelled runs/)).toBeTruthy();
  expect(pages.getByText(/context pack/)).toBeTruthy();
});

test('code blocks, which scroll sideways, can be reached and scrolled by keyboard', async () => {
  const { overflowAll, unreachableScrollers } = await import('./ui/scrollReach.ts');
  onTestFinished(overflowAll());
  const { container } = render(<Docs />);
  expect(container.querySelector('pre')).toBeTruthy();
  expect(unreachableScrollers(container).map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
});

test('Connect your agents names every skill install-agent links (one per plugin/skills folder) and no old folder name', async () => {
  const { readdirSync } = await import('node:fs');
  const { CLAUDE_SKILLS } = await import('./Docs.tsx');
  const folders = readdirSync(`${import.meta.dirname}/../../../plugin/skills`).filter((f) => !f.startsWith('.')).sort();
  expect([...CLAUDE_SKILLS].sort()).toEqual(folders);
  render(<Docs />);
  const section = screen.getByRole('region', { name: 'Connect your agents' });
  expect(section.textContent).toContain(`${folders.length} skills (${CLAUDE_SKILLS.join(', ')}) linked into ~/.claude/skills`);
  expect(section.textContent).toContain('From the folder you cloned Feedback Graph into, run:');
  expect(section.textContent).not.toMatch(/feedback_tool|two skills/);
});

test('the contents button opens and closes the list on narrow screens, and a section button closes it and scrolls there', () => {
  const scrolled: Element[] = [];
  const had = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  onTestFinished(() => { Element.prototype.scrollIntoView = had; });
  render(<Docs />);
  const nav = within(screen.getByRole('navigation', { name: 'on this page' }));
  const toggle = nav.getByRole('button', { name: 'On this page' });
  const list = document.getElementById('docs-toc')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(list.className.split(' ')).toContain('hidden');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(list.className.split(' ')).not.toContain('hidden');
  fireEvent.click(nav.getByRole('button', { name: 'The code map' }));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(scrolled).toEqual([screen.getByRole('region', { name: 'The code map' })]);
});

test('the article uses the full width with large body text; prose keeps a readable measure, code and page guides do not', () => {
  const { container } = render(<Docs />);
  expect(container.innerHTML).not.toMatch(/max-w-5xl|max-w-\[44rem\]/);
  const article = container.querySelector('article')!;
  expect(article.className).toMatch(/text-\[17px\]/);
  const section = screen.getByRole('region', { name: 'Each page' });
  expect(section.className).toContain('[&>:not(pre,.wide)]:max-w-[54em]');
  expect(section.querySelector(':scope > .wide')).toBeTruthy();
});

test('the Docs page covers 0.7.6: signing in, read-only installs, the demo, the plugin, lesson triggers and the miss gate', () => {
  render(<Docs />);
  const first = within(screen.getByRole('region', { name: 'Your first hour' }));
  expect(first.getAllByText('./scripts/setup.sh --yes --enable-auth')).toHaveLength(1);
  expect(first.getByText('./scripts/fg signin')).toBeTruthy();
  for (const c of ['./scripts/setup.sh --yes --demo', './scripts/fg demo context', './scripts/fg demo check']) expect(first.getByText(c)).toBeTruthy();
  const connect = within(screen.getByRole('region', { name: 'Connect your agents' }));
  expect(connect.getByRole('heading', { name: 'Claude Code plugin' })).toBeTruthy();
  expect(connect.getByText(/\/plugin install feedback-graph@feedback-graph/)).toBeTruthy();
  expect(connect.getByText('MISS_MIN_SIMILARITY')).toBeTruthy();
  expect(connect.getByText('CHECK_WAIT_SECONDS')).toBeTruthy();
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  expect(pages.getByText('Use it')).toBeTruthy();
  expect(pages.getByText('The agent reported')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'The code map' })).getByText('CODE_MAP_MAX_BYTES')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'When something looks wrong' })).getByText(/Read-only banner/)).toBeTruthy();
});

test('the Docs page opens with the how-it-works diagram, described for screen readers, and explains the learning loop', () => {
  const { container } = render(<Docs />);
  const diagram = container.querySelector('figure svg[role="img"]')!;
  const label = diagram.getAttribute('aria-labelledby')!.split(' ').map((id) => diagram.querySelector(`#${id}`)?.textContent);
  expect(label[0]).toBe('How Feedback Graph works');
  expect(label[1]).toMatch(/learning loop/);
  // Drawn with the theme's colours, so it follows the theme toggle.
  expect(diagram.querySelector('style')?.textContent).toMatch(/var\(--color-/);
  const loop = within(screen.getByRole('region', { name: 'The learning loop' }));
  expect(loop.getByText(/Roll back/)).toBeTruthy();
  expect(loop.getByText('LOOP_HOLDOUT')).toBeTruthy();
  const scrolled: string[] = [];
  const target = document.getElementById('doc-the-learning-loop')!;
  target.scrollIntoView = () => scrolled.push(target.id);
  fireEvent.click(screen.getAllByRole('button', { name: 'The learning loop' })[0]!);
  expect(scrolled).toEqual(['doc-the-learning-loop']);
});

test('the diagram is chosen by the column: four columns from 976px, three below, and under 460px it scrolls with a cue', () => {
  const { container } = render(<Docs />);
  const figure = container.querySelector('figure')!;
  // jsdom lays nothing out: the container queries are the classes, on the figure (the column), not the window.
  expect(figure.className.split(' ')).toContain('@container');
  const narrow = figure.querySelector('[data-diagram="narrow"]')!;
  const wide = figure.querySelector('[data-diagram="wide"]')!;
  expect(narrow.className.split(' ')).toEqual(expect.arrayContaining(['min-w-[460px]', '@min-[976px]:hidden']));
  expect(wide.className.split(' ')).toEqual(expect.arrayContaining(['hidden', '@min-[976px]:block']));
  expect(narrow.querySelector('svg')!.getAttribute('viewBox')).toMatch(/^0 0 580 /);
  expect(wide.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 1240 690');
  const cue = within(figure).getByText(/Scroll sideways/);
  expect(cue.className.split(' ')).toContain('@min-[460px]:hidden');
  // Both are in the page, so no id may repeat (the label, description and arrowhead each have one).
  const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
  expect(ids.length).toBe(new Set(ids).size);
  for (const svg of figure.querySelectorAll('svg')) {
    for (const ref of svg.getAttribute('aria-labelledby')!.split(' ')) expect(svg.querySelector(`#${ref}`)).not.toBeNull();
  }
});

test('the page guides describe the metrics card, every decision status and what overridden means', () => {
  render(<Docs />);
  const pages = within(screen.getByRole('region', { name: 'Each page' }));
  expect(pages.getByText('Learning-loop metrics').closest('li')!.textContent).toMatch(/gaps fixed per serving.*not applicable.*95% interval.*proposals per week.*rolled back, by type/is);
  const items = [...screen.getByRole('region', { name: 'Each page' }).querySelectorAll('li')].map((li) => li.textContent!);
  const decisions = items.find((t) => t.startsWith('Filter by status'))!;
  expect(decisions).toMatch(/applying \(being written now\)/);
  expect(decisions).toMatch(/overridden \(its target changed outside the decision: you edited it, or another process did, after it was applied, or before a proposal was approved\)/);
  expect(items.find((t) => t.includes('Restore anyway'))).toMatch(/A proposal overridden before it was applied changed nothing/);
});

test('a page guide\'s summary goes under its name on a phone, not into a narrow column beside it', () => {
  render(<Docs />);
  const summary = screen.getByText('Ask first, then where everything stands, each part linked to its page.');
  expect(summary.className.split(' ')).toEqual(expect.arrayContaining(['basis-full', 'sm:basis-auto']));
  expect(summary.previousElementSibling!.className).not.toMatch(/(^| )w-24/);
});