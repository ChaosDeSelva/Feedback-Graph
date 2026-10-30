import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Activity, ActivityEntry } from './Activity.tsx';

const rows = [
  {
    id: 'a1', ts: '2026-10-22T20:33:00Z', kind: 'facts_extracted', actor: 'ollama:gemma4', projectKey: 'demo-shop',
    subject: '2 facts from src/db.ts', why: 'new file, never scanned before',
    details: { scanJobId: 'scan:1', hash: 'abc1234', summary: 'Data layer', facts: [{ kind: 'invariant', statement: 'Use db.scoped(orgId)', why: 'routes leak data otherwise', confidence: 0.9 }] },
    targets: ['demo-shop:src/db.ts'],
  },
  { id: 'a3', ts: '2026-10-22T20:31:00Z', kind: 'project_aliased', actor: 'deterministic', projectKey: 'demo-shop', subject: '"demo-shop-2" is another clone of demo-shop', why: 'both folders have the git remote github.com/me/shop', details: {}, targets: [] },
  { id: 'a2', ts: '2026-10-22T20:30:00Z', kind: 'memory_imported', actor: 'memory-file', projectKey: 'demo-shop', subject: 'lesson "no dashes" imported', why: 'a feedback memory in x.md', details: {}, targets: [] },
];
let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/projects') return Response.json([{ key: 'demo-shop', repoPath: '/x', sessions: 0, feedback: 0, lessons: 0, facts: 2, lastScan: null }]);
    if (url.startsWith('/api/activity')) return Response.json(rows);
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('lists what happened, who did it and why', async () => {
  render(<Activity />);
  expect(await screen.findByText('2 facts from src/db.ts')).toBeTruthy();
  expect(screen.getByText('new file, never scanned before')).toBeTruthy();
  expect(screen.getByText('ollama:gemma4')).toBeTruthy();
  expect(screen.getByText('memory-file')).toBeTruthy();
});

test('expanding an entry shows its details, including each fact and why it was kept', async () => {
  render(<Activity />);
  fireEvent.click(await screen.findByText('2 facts from src/db.ts'));
  expect(await screen.findByText('Use db.scoped(orgId)')).toBeTruthy();
  expect(screen.getByText(/routes leak data otherwise/)).toBeTruthy();
  expect(screen.getByText(/scan:1/)).toBeTruthy();
});

test('an entry whose details the list left out fetches them when expanded, once', async () => {
  const big = { ...rows[2], id: 'a9', subject: 'scan report', details: {}, detailsOmitted: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/activity/a9') return Response.json({ ...big, detailsOmitted: undefined, details: { report: 'the whole long report' } });
    if (url.startsWith('/api/activity')) return Response.json([big]);
    return Response.json([]);
  }));
  render(<Activity />);
  const row = await screen.findByText('scan report');
  expect(urls.filter((u) => u === '/api/activity/a9')).toHaveLength(0);
  fireEvent.click(row);
  expect(await screen.findByText('the whole long report')).toBeTruthy();
  fireEvent.click(row);
  fireEvent.click(row);
  expect(await screen.findByText('the whole long report')).toBeTruthy();
  expect(urls.filter((u) => u === '/api/activity/a9')).toHaveLength(1);
});

test("a context item's why that is only a field name is not printed as a reason", async () => {
  const pm = { ...rows[2], id: 'a8', kind: 'postmortem_done', subject: 'missed the org scope', details: { contextFound: [{ kind: 'code', ref: 'src/a.ts', why: 'wasAvailable' }, { kind: 'code', ref: 'src/b.ts', why: 'it scoped by org' }] } };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/activity') ? Response.json([pm]) : Response.json([]))));
  render(<Activity />);
  fireEvent.click(await screen.findByText('missed the org scope'));
  expect(await screen.findByText(/it scoped by org/)).toBeTruthy();
  expect(screen.queryByText(/wasAvailable/)).toBeNull();
});

test('filters by project and kind', async () => {
  render(<Activity />);
  await screen.findByText('2 facts from src/db.ts');
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'demo-shop' } });
  fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'memory_imported' } });
  await waitFor(() => expect(urls).toContain('/api/activity?project=demo-shop&kind=memory_imported&limit=300'));
});

test('a second clone recognised by its git remote is labelled as a project alias', async () => {
  render(<Activity />);
  expect(await screen.findByText('"demo-shop-2" is another clone of demo-shop')).toBeTruthy();
  expect(screen.getAllByText('project alias').length).toBeGreaterThan(0);
});

test('a slow answer for the filters you left never replaces the rows for the ones you picked', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ key: 'demo-shop', repoPath: '/x', sessions: 0, feedback: 0, lessons: 0, facts: 2, lastScan: null }]);
    if (url === '/api/activity?limit=300') { await new Promise((r) => setTimeout(r, 80)); return Response.json(rows); }
    if (url.startsWith('/api/activity?kind=memory_imported')) return Response.json([rows[2]]);
    return Response.json([]);
  }));
  render(<Activity />);
  fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'memory_imported' } });
  expect(await screen.findByText('lesson "no dashes" imported')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 120));
  expect(screen.getByText('lesson "no dashes" imported')).toBeTruthy();
  expect(screen.queryByText('2 facts from src/db.ts')).toBeNull();
});

test('a link to one kind (#activity/candidate_flagged) opens filtered to it, with the classifier backlog on top', async () => {
  location.hash = '#activity/candidate_flagged';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/pipeline') return Response.json({ classify: { backlog: 40, capped: true } });
    return Response.json([]);
  }));
  render(<Activity />);
  await waitFor(() => expect(urls).toContain('/api/activity?kind=candidate_flagged&limit=300'));
  expect((screen.getByLabelText('kind') as HTMLSelectElement).value).toBe('candidate_flagged');
  expect(await screen.findByText(/40\+ turns are waiting for the classifier/)).toBeTruthy();
  location.hash = '';
});

test('each actor says what kind of actor it is: a person, an agent with the operator token, a model, a pipeline step', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/activity')) {
      return Response.json(['you', 'operator:codex', 'ollama:gemma4', 'claude-cli', 'skip-rules', 'claude-code'].map((actor, i) => ({
        id: `x${i}`, ts: '2026-10-22T20:33:00Z', kind: 'lesson_decided', actor, projectKey: null, subject: `by ${actor}`, why: '', details: {}, targets: [],
      })));
    }
    return Response.json([]);
  }));
  render(<Activity />);
  await screen.findByText('by you');
  const title = (actor: string) => screen.getByText(actor, { selector: '[title]' }).getAttribute('title');
  expect(title('you')).toMatch(/^person/);
  expect(title('operator:codex')).toMatch(/^agent with the operator token/);
  expect(title('ollama:gemma4')).toMatch(/^model/);
  expect(title('claude-cli')).toMatch(/^model/);
  expect(title('skip-rules')).toMatch(/^pipeline step/);
  expect(title('claude-code')).toMatch(/^agent over MCP/);
  // A legend says the same once for the page.
  expect(screen.getByLabelText('who did it')).toBeTruthy();
});

test('an entry made in a labelled run says which run, and whether it was a sandbox (labelled runs shown)', async () => {
  const labelled = { ...rows[2], id: 'a7', subject: 'context for "tune it"', run: 'run-1', sandbox: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/activity') ? Response.json([labelled, rows[1]]) : Response.json([]))));
  render(<Activity />);
  await screen.findByText(rows[1].subject);
  fireEvent.click(screen.getByLabelText('hide labelled runs'));
  expect(await screen.findByText('context for "tune it"')).toBeTruthy();
  expect(screen.getByText('run run-1 · sandbox')).toBeTruthy();
  expect(screen.getAllByText(/^run run-/)).toHaveLength(1);
});

test('one row per entry: the subject on one line (whole on hover), then the time, actor and run as chips; the kind badge on the right', async () => {
  const long = 'v062-e2e-' + 'x'.repeat(50);
  const entry = { ...rows[2], id: 'a5', kind: 'feedback_decided', actor: 'operator:v062-e2e', subject: 'confirmed "the modal does not close on Escape"', run: long, ts: new Date(Date.now() - 3 * 3600_000).toISOString(), details: { status: 'confirmed' } };
  render(<ul><ActivityEntry a={entry as never} /></ul>);
  const subject = screen.getByText(entry.subject);
  expect(subject.getAttribute('title')).toBe(entry.subject);
  expect(subject.className).toMatch(/truncate/);
  const row = subject.closest('button')!;
  // The time: relative, with the exact one in words on hover (never the ISO string).
  const time = row.querySelector('time')!;
  expect(time.textContent).toBe('3h ago');
  expect(time.getAttribute('datetime')).toBe(entry.ts);
  expect(time.getAttribute('title')).not.toMatch(/T\d\d:/);
  expect(time.className).toMatch(/whitespace-nowrap/);
  // The actor and the run are chips that cut a long id and show it whole on hover.
  const actor = screen.getByText('operator:v062-e2e');
  expect(actor.className).toMatch(/truncate/);
  const run = screen.getByText(`run ${long}`);
  expect(run.className).toMatch(/truncate/);
  expect(run.closest('[title]')!.getAttribute('title')).toContain(long);
  // The kind badge sits at the end of the first line, never in a column of its own.
  const badge = screen.getByText('your decision');
  expect(subject.parentElement!.contains(badge)).toBe(true);
});

test('labelled runs are hidden by default, saying how many; unhiding asks the API for them too', async () => {
  const labelled = { ...rows[2], id: 'a7', subject: 'context for "tune it"', run: 'run-1' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return url.startsWith('/api/activity') ? Response.json([labelled, rows[1]]) : Response.json([]); }));
  render(<Activity />);
  await screen.findByText(rows[1].subject);
  expect((screen.getByLabelText('hide labelled runs') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText('context for "tune it"')).toBeNull();
  expect(screen.getByText(/1 entry from a labelled run is hidden/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('hide labelled runs'));
  expect(await screen.findByText('context for "tune it"')).toBeTruthy();
  await waitFor(() => expect(urls).toContain('/api/activity?limit=300&runs=1'));
});

test('filters by run: the entries of that one run, whatever the hide setting', async () => {
  const labelled = { ...rows[2], id: 'a7', subject: 'context for "tune it"', run: 'run-1' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith('/api/activity?run=run-1')) return Response.json([labelled]);
    return url.startsWith('/api/activity') ? Response.json([rows[1]]) : Response.json([]);
  }));
  render(<Activity />);
  await screen.findByText(rows[1].subject);
  fireEvent.change(screen.getByLabelText('run'), { target: { value: 'run-1' } });
  fireEvent.submit(screen.getByLabelText('run').closest('form')!);
  expect(await screen.findByText('context for "tune it"')).toBeTruthy();
  expect(urls).toContain('/api/activity?run=run-1&limit=300');
  expect(screen.queryByText(rows[1].subject)).toBeNull();
});


test('repeated scan retry entries can collapse without deleting historical entries', async () => {
  const retry = { ...rows[0], kind: 'scan_finished', subject: 'scan parked: provider unavailable', why: 'retry with backoff', details: {} };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.startsWith('/api/activity') ? [{ ...retry, id: 'r2' }, { ...retry, id: 'r1' }] : [])));
  render(<Activity />);
  expect(await screen.findByText(/1 repeated scan retry entries collapsed/)).toBeTruthy();
  expect(screen.getAllByText('scan parked: provider unavailable')).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Collapse repeated scan retries' }));
  expect(screen.getAllByText('scan parked: provider unavailable')).toHaveLength(2);
});
