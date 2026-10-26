import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
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
  expect(section.querySelectorAll('details')).toHaveLength(10);
  expect(pages.getByText(/confidence %/)).toBeTruthy();
  expect(pages.getByText(/approved by agent/)).toBeTruthy();
  expect(pages.getByText(/operator:<name>/)).toBeTruthy();
  expect(pages.getByText(/the catch rate/).textContent).toMatch(/pre-done checks that found a gap ÷ all pre-done checks/);
  expect(pages.getByText('docs/guide.md')).toBeTruthy();
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
  expect(section.getByText(/Only lessons you approved leave/)).toBeTruthy();
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
