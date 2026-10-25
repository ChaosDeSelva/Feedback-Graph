import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodeMap } from './CodeMap.tsx';

const meta = { fingerprint: 'abc', builtAt: '2026-10-22T12:00:00Z', stats: { files: 40, symbols: 200, imports: 90, tests: 12 }, candidates: null };
const hotspots = [
  { path: 'src/db/pool.ts', churn: 7, misses: 2, dependents: 3, score: 13 },
  { path: 'src/api/orders.ts', churn: 30, misses: 0, dependents: 1, score: 5.95 },
  { path: 'src/util.ts', churn: 1, misses: 0, dependents: 9, score: 4.32 },
];
const mod = (path: string) => ({
  file: { path, lang: 'typescript', hash: 'h', loc: 120, isTest: false, churn: { commits: 7, lastTs: '2026-10-20T00:00:00Z' } },
  symbols: [
    { id: `${path}#createPool`, path, name: 'createPool', kind: 'function', exported: true, lines: '10-30' },
    { id: `${path}#helper`, path, name: 'helper', kind: 'function', exported: false, lines: '31-40' },
  ],
  importers: ['src/api/orders.ts'],
  imports: [{ to: 'src/config.ts', names: ['config'] }, { to: 'pkg:pg', names: ['Pool'] }],
  tests: ['test/pool.test.ts'],
  facts: [{ id: 'f1', path, lines: '10-30', kind: 'invariant', statement: 'Every client is released in finally', why: 'w', confidence: 0.9, source: 'ollama:gemma4', createdAt: 't', scanJobId: null, fileHash: null, fileSummary: null }],
  misses: [{ missId: 'miss:1', missed: 'leaked pool clients on error', cause: 'implementation_error', causeExplanation: 'no finally', feedbackId: 'fb:1', feedbackText: 'connections pile up again', sessionId: 's1', ts: '2026-10-01T10:00:00Z', paths: [path], fixedHere: true, lessonId: 'l1' }],
  lessons: [{ id: 'l1', projectKey: 'demo', title: 'Release pool clients', rule: 'always release', appliesWhen: 'db work', scope: 'project', paths: ['src/db/**'], status: 'approved', source: 'postmortem', cause: 'implementation_error', missId: 'miss:1', createdAt: 't', decidedAt: 't' }],
});

let urls: string[];
let noMap = false;
let capped = false;
let noFacts = false;
let zero = false;
let atCap: number | null = null;
let rebuild: { status: number; json: unknown };
let posts: string[];
beforeEach(() => {
  zero = false;
  urls = [];
  posts = [];
  noMap = false;
  capped = false;
  noFacts = false;
  atCap = null;
  rebuild = { status: 202, json: { queued: true } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.method === 'POST') {
      posts.push(url);
      if (url === '/api/projects/demo/codemap/rebuild') return Response.json(rebuild.json, { status: rebuild.status });
    }
    if (atCap !== null && url.startsWith('/api/projects/demo/codemap/hotspots')) {
      return Response.json({ meta: { ...meta, stats: { ...meta.stats, files: atCap } }, capped: { files: atCap, of: null }, hotspots });
    }
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) return Response.json(noMap ? { meta: null, hotspots: [] } : { meta: capped ? { ...meta, candidates: 10_290 } : meta, hotspots: zero ? hotspots.map((h) => ({ ...h, score: 0, misses: 0 })) : hotspots });
    const m = url.match(/^\/api\/projects\/demo\/codemap\/module\?path=(.+)$/);
    if (m) return Response.json(noFacts ? { ...mod(decodeURIComponent(m[1])), facts: [] } : mod(decodeURIComponent(m[1])));
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rows = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);

test('shows the map stats and the hotspots, highest score first', async () => {
  render(<CodeMap projectKey="demo" />);
  expect(await screen.findByText('src/db/pool.ts')).toBeTruthy();
  expect(screen.getByLabelText('files').textContent).toContain('40');
  expect(screen.getByLabelText('symbols').textContent).toContain('200');
  expect(screen.getByLabelText('edges').textContent).toContain('102'); // 90 imports + 12 test links
  expect(screen.getByLabelText('last built').textContent).toMatch(/2026/);
  expect(rows()).toEqual(['src/db/pool.ts', 'src/api/orders.ts', 'src/util.ts']);
});

test('the hotspot table sorts by any column, and again the other way', async () => {
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  fireEvent.click(screen.getByRole('button', { name: /churn/i }));
  expect(rows()).toEqual(['src/api/orders.ts', 'src/db/pool.ts', 'src/util.ts']);
  expect(screen.getByRole('columnheader', { name: /churn/i }).getAttribute('aria-sort')).toBe('descending');
  fireEvent.click(screen.getByRole('button', { name: /churn/i }));
  expect(rows()).toEqual(['src/util.ts', 'src/db/pool.ts', 'src/api/orders.ts']);
  fireEvent.click(screen.getByRole('button', { name: /dependents/i }));
  expect(rows()[0]).toBe('src/util.ts');
  fireEvent.click(screen.getByRole('button', { name: /^file/i }));
  expect(rows()).toEqual(['src/api/orders.ts', 'src/db/pool.ts', 'src/util.ts']);
});

test('clicking a file opens its module panel with links to its lessons and Inbox items', async () => {
  render(<CodeMap projectKey="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'src/db/pool.ts' }));
  const panel = await screen.findByRole('region', { name: /module src\/db\/pool\.ts/ });
  await within(panel).findByText('createPool');
  expect(urls).toContain('/api/projects/demo/codemap/module?path=src%2Fdb%2Fpool.ts');
  const p = within(panel);
  expect(p.getByText('helper')).toBeTruthy();
  expect(p.getByText('Every client is released in finally')).toBeTruthy();
  expect(p.getByText('test/pool.test.ts')).toBeTruthy();
  expect(p.getByText('pkg:pg')).toBeTruthy();
  expect(p.getByText('leaked pool clients on error')).toBeTruthy();
  expect(p.getByRole('link', { name: 'Release pool clients' }).getAttribute('href')).toBe('#lessons/l1');
  expect(p.getByRole('link', { name: /feedback/i }).getAttribute('href')).toBe('#inbox/fb%3A1');
});

test('an importer in the module panel opens that file', async () => {
  render(<CodeMap projectKey="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'src/db/pool.ts' }));
  const panel = await screen.findByRole('region', { name: /module src\/db\/pool\.ts/ });
  fireEvent.click(await within(panel).findByRole('button', { name: 'src/api/orders.ts' }));
  expect(await screen.findByRole('region', { name: /module src\/api\/orders\.ts/ })).toBeTruthy();
  await waitFor(() => expect(urls).toContain('/api/projects/demo/codemap/module?path=src%2Fapi%2Forders.ts'));
});

test('hotspots leave test files out until "include tests" is ticked', async () => {
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  expect(urls).toEqual(['/api/projects/demo/codemap/hotspots?limit=200']);
  const box = screen.getByLabelText('include tests') as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  await waitFor(() => expect(urls).toContain('/api/projects/demo/codemap/hotspots?limit=200&tests=1'));
  expect(await screen.findByText('src/db/pool.ts')).toBeTruthy();
});

test('a capped map says how many files it left out and how to raise the cap', async () => {
  capped = true;
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  expect(screen.getByRole('note').textContent).toMatch(/Showing 40 of 10,290 files[\s\S]*raise SCAN_MAX_FILES/);
  expect(screen.getByLabelText('files').textContent).toContain('of 10,290');
});

test('a map built before the total was counted still says it is capped, at its cap, and how to see the total', async () => {
  atCap = 4000;
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  expect(screen.getByRole('note').textContent).toMatch(/capped at 4,000 files[\s\S]*Rebuild map[\s\S]*raise SCAN_MAX_FILES/i);
  expect(screen.getByLabelText('files').textContent).toContain('4,000');
});

test('Rebuild map asks the worker for a fresh map and says so; a refusal is shown', async () => {
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild map' }));
  expect(await screen.findByText(/rebuild queued/i)).toBeTruthy();
  expect(posts).toEqual(['/api/projects/demo/codemap/rebuild']);
  cleanup();
  rebuild = { status: 403, json: { error: 'only you can make this decision, from the Feedback Graph UI' } };
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild map' }));
  expect(await screen.findByText(/only you can make this decision/)).toBeTruthy();
});

test('an uncapped map says nothing about a cap', async () => {
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  expect(screen.queryByRole('note')).toBeNull();
});

test('a file no scan fact cites does not claim the project has no facts', async () => {
  noFacts = true;
  render(<CodeMap projectKey="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'src/db/pool.ts' }));
  const panel = await screen.findByRole('region', { name: /module src\/db\/pool\.ts/ });
  await within(panel).findByText('createPool');
  expect(within(panel).queryByText(/No facts yet/)).toBeNull();
  expect(within(panel).getByText(/No scan fact cites this file/)).toBeTruthy();
});

test('a project with no map yet says the worker builds it', async () => {
  noMap = true;
  render(<CodeMap projectKey="demo" />);
  expect(await screen.findByText(/no code map yet/i)).toBeTruthy();
});

test('when every file scores 0 the card says "no hotspots yet" instead of listing docs and config as hotspots', async () => {
  zero = true;
  render(<CodeMap projectKey="demo" />);
  expect(await screen.findByText(/No hotspots yet/)).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /show the files anyway/i }));
  expect(screen.getByRole('table')).toBeTruthy();
});

test('a focus request (a fact file name on the Projects page) opens that file panel, again each time', async () => {
  const { rerender } = render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/db/pool.ts');
  rerender(<CodeMap projectKey="demo" focus={{ path: 'src/deep/a.ts', at: 1 }} />);
  expect(await screen.findByRole('region', { name: 'module src/deep/a.ts' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'close module' }));
  rerender(<CodeMap projectKey="demo" focus={{ path: 'src/deep/a.ts', at: 2 }} />);
  expect(await screen.findByRole('region', { name: 'module src/deep/a.ts' })).toBeTruthy();
});
