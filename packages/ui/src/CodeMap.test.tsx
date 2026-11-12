import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodeMap, ModulePanel } from './CodeMap.tsx';
import { heldAnswer } from './testing/heldAnswer.ts';

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const rows = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);

test('shows the map stats and the hotspots, highest score first', async () => {
  render(<CodeMap projectKey="demo" />);
  expect(await screen.findByText('src/db/pool.ts')).toBeTruthy();
  expect(screen.getByLabelText('files').textContent).toContain('40');
  expect(screen.getByLabelText('symbols').textContent).toContain('200');
  expect(screen.getByLabelText('edges').textContent).toContain('102'); // 90 imports + 12 test links
  // Relative age, the exact time on hover.
  expect(screen.getByLabelText('last checked').textContent).toMatch(/\d+(?:m|h|d|mo|y) ago|just now/);
  expect(screen.getByLabelText('last checked').querySelector('time')!.getAttribute('title')).toMatch(/2026/);
  expect(rows()).toEqual(['src/db/pool.ts', 'src/api/orders.ts', 'src/util.ts']);
});

test('a map whose first build never finished (no build time) says so instead of "NaNy ago" or a 1970 date', async () => {
  const unbuilt = { ...meta, fingerprint: null, builtAt: null, checkedAt: null, lastFailureAt: '2026-10-22T12:00:00Z', lastFailure: 'statement timed out' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.startsWith('/api/projects/demo/codemap/hotspots') ? { meta: unbuilt, hotspots: [] } : [])));
  render(<CodeMap projectKey="demo" />);
  const tile = await screen.findByLabelText('last checked');
  expect(tile.textContent).toContain('never');
  expect(tile.textContent).toContain('the first build has not finished');
  expect(tile.querySelector('time')).toBeNull();
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(/^The last build failed .+: statement timed out\. There is no map until a build finishes\./);
  expect(document.body.textContent).not.toMatch(/NaN|1970/);
});

test('an unchanged map shows when it was last checked, with its older build date beside it', async () => {
  const day = 86_400_000;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/projects/demo/codemap/hotspots')
    ? Response.json({ meta: { ...meta, builtAt: new Date(Date.now() - 12 * day).toISOString(), checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }, hotspots })
    : Response.json([]))));
  render(<CodeMap projectKey="demo" />);
  const tile = await screen.findByLabelText('last checked');
  const [checked, built] = tile.querySelectorAll('time');
  expect(checked.textContent).toBe('2h ago');
  expect(built.textContent).toBe('12d ago');
  expect(tile.textContent).toMatch(/built 12d ago; rebuilt when the repo changes/);
  expect(built.getAttribute('title')).toMatch(/\d{4}/);
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
  expect(urls.filter((u) => u.includes('/codemap/'))).toEqual(['/api/projects/demo/codemap/hotspots?limit=200']);
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

test('after Rebuild map the card polls until the new map is built, then shows it without a reload', async () => {
  // Polling runs on fake timers that also follow the clock, so the check for no further polls can step well past it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let built = meta.builtAt;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.method === 'POST') return Response.json({ queued: true }, { status: 202 });
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) {
      return Response.json({ meta: { ...meta, builtAt: built, stats: { ...meta.stats, files: built === meta.builtAt ? 40 : 55 } }, hotspots });
    }
    return Response.json([]);
  }));
  render(<CodeMap projectKey="demo" pollMs={10} />);
  await screen.findByText('src/db/pool.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild map' }));
  expect(await screen.findByText(/rebuild queued/i)).toBeTruthy();
  await waitFor(() => expect(urls.filter((u) => u.startsWith('/api/projects/demo/codemap/hotspots')).length).toBeGreaterThan(2));
  // Still the old map: the card keeps waiting and says so.
  expect(screen.getByLabelText('files').textContent).toContain('40');
  built = '2026-10-22T13:00:00Z';
  await waitFor(() => expect(screen.getByLabelText('files').textContent).toContain('55'));
  expect(screen.getByText(/map rebuilt/i)).toBeTruthy();
  const n = urls.length;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(urls.length).toBe(n);
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

test('a file past the code map cap opens a panel that says why it has nothing: the cap, how many files it keeps, and how to raise it', async () => {
  capped = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) return Response.json({ meta: { ...meta, candidates: 10_290 }, hotspots });
    if (url.startsWith('/api/projects/demo/codemap/module')) return Response.json({ error: 'not in the code map' }, { status: 404 });
    return Response.json([]);
  }));
  render(<ModulePanel projectKey="demo" path="docs/far/away.md" onOpen={() => {}} onClose={() => {}} />);
  const panel = await screen.findByRole('region', { name: 'module docs/far/away.md' });
  await waitFor(() => expect(panel.textContent).toMatch(/past the code map's cap/));
  expect(panel.textContent).toMatch(/40 of 10,290 files/);
  expect(panel.textContent).toMatch(/SCAN_MAX_FILES/);
  expect(within(panel).queryByRole('alert')).toBeNull();
});

test('a file past the cap has a module panel from the import index: importers and tests, and a note where its symbols would be', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/projects/demo/codemap/module')) return Response.json({ ...mod('src/far/hub.ts'), symbols: [], outside: true });
    return Response.json([]);
  }));
  render(<ModulePanel projectKey="demo" path="src/far/hub.ts" onOpen={() => {}} onClose={() => {}} />);
  const panel = await screen.findByRole('region', { name: 'module src/far/hub.ts' });
  await waitFor(() => expect(panel.textContent).toMatch(/Past the code map's cap, and none could be read from the file now/));
  expect(panel.textContent).not.toMatch(/No symbols found/);
});

test('a file not in an uncapped map says the map does not read it, or it is newer than the map', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) return Response.json({ meta, hotspots });
    if (url.startsWith('/api/projects/demo/codemap/module')) return Response.json({ error: 'not in the code map' }, { status: 404 });
    return Response.json([]);
  }));
  render(<ModulePanel projectKey="demo" path="README.md" onOpen={() => {}} onClose={() => {}} />);
  const panel = await screen.findByRole('region', { name: 'module README.md' });
  await waitFor(() => expect(panel.textContent).toMatch(/not in the code map/));
  expect(panel.textContent).toMatch(/Rebuild map/);
  expect(panel.textContent).not.toMatch(/cap/);
});

test('the card states the map once, from /api/status and the map: rebuilding now, cut short, or failed with a next step', async () => {
  const day = 86_400_000;
  const serve = (m: object, codeMaps: object[]) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/status') return Response.json({ codeMaps });
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) return Response.json({ meta: { ...meta, builtAt: new Date(Date.now() - 3 * day).toISOString(), ...m }, hotspots });
    return Response.json([]);
  }));
  serve({ fingerprint: null, writingAt: new Date().toISOString() }, [{ projectKey: 'demo', rebuilding: true }]);
  render(<CodeMap projectKey="demo" />);
  expect((await screen.findByText(/Rebuilding now/)).textContent).toMatch(/The map built 3d ago stays in use/);
  expect(screen.queryByRole('alert')).toBeNull();
  cleanup();

  serve({ fingerprint: null, writingAt: new Date(Date.now() - day).toISOString() }, [{ projectKey: 'demo', interrupted: true }]);
  render(<CodeMap projectKey="demo" />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/stopped part way[\s\S]*built 3d ago stays in use[\s\S]*Next: Rebuild map retries it now/);
  cleanup();

  const neo = 'Neo.TransientError.General.MemoryPoolOutOfMemoryError: The allocation of an extra 2.0 MiB would use more than the limit 64.0 MiB';
  serve({ lastFailureAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), lastFailure: neo }, [{ projectKey: 'demo', lastFailureAt: 'x', lastFailure: neo }]);
  render(<CodeMap projectKey="demo" />);
  const failed = (await screen.findByRole('alert')).textContent!;
  expect(failed).toMatch(/The last rebuild failed 2h ago: Neo\.TransientError/);
  expect(failed).toMatch(/Next: Neo4j ran out of transaction memory: raise NEO4J_TRANSACTION_MAX/);
});

/** The fake API, with the given answers in front of it. */
function answering(over: (url: string, method: string) => Response | null) {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => over(url, init?.method ?? 'GET') ?? inner(url, init)));
}

test('a rebuild that fails after you asked stops the wait and the card says what failed and what to do', async () => {
  // Polling runs on fake timers that also follow the clock, so the check for no further polls can step well past it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let failedAt: string | null = null;
  answering((url) => (url.startsWith('/api/projects/demo/codemap/hotspots')
    ? Response.json({ meta: { ...meta, lastFailureAt: failedAt, lastFailure: failedAt && 'connect ECONNREFUSED neo4j:7687' }, hotspots }) : null));
  render(<CodeMap projectKey="demo" pollMs={10} />);
  await screen.findByText('src/db/pool.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild map' }));
  expect(await screen.findByText(/rebuild queued/i)).toBeTruthy();
  failedAt = new Date(Date.now() + 1000).toISOString();
  expect(await screen.findByText(/The last rebuild failed .*ECONNREFUSED/)).toBeTruthy();
  expect(screen.getByText(/The graph store was unreachable/)).toBeTruthy();
  expect(screen.queryByText(/rebuild queued/i)).toBeNull();
  const n = urls.length;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(urls.length).toBe(n);
});

test('a rebuild the worker has not done within 15 minutes stops the wait and says to look again later', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    render(<CodeMap projectKey="demo" pollMs={10} />);
    await screen.findByText('src/db/pool.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild map' }));
    expect(await screen.findByText(/rebuild queued/i)).toBeTruthy();
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    expect(await screen.findByText(/The worker has not rebuilt the map yet/)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

test('a map with no files says so instead of an empty table', async () => {
  answering((url) => (url.startsWith('/api/projects/demo/codemap/hotspots') ? Response.json({ meta, hotspots: [] }) : null));
  render(<CodeMap projectKey="demo" />);
  expect(await screen.findByText('The map has no files yet.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

test('a long hotspot list shows the top rows, all of them on request, and the top again', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${String(i).padStart(2, '0')}.ts`, churn: 1, misses: 0, dependents: 1, score: 30 - i }));
  answering((url) => (url.startsWith('/api/projects/demo/codemap/hotspots') ? Response.json({ meta, hotspots: many }) : null));
  render(<CodeMap projectKey="demo" />);
  await screen.findByText('src/f00.ts');
  const shown = rows().length;
  expect(shown).toBeLessThan(30);
  fireEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
  expect(rows()).toHaveLength(30);
  fireEvent.click(screen.getByRole('button', { name: `Show the top ${shown}` }));
  expect(rows()).toHaveLength(shown);
});

test('a module panel that cannot load says why', async () => {
  answering((url) => (url.startsWith('/api/projects/demo/codemap/module') ? Response.json({ error: 'the graph store timed out' }, { status: 503 }) : null));
  render(<ModulePanel projectKey="demo" path="src/db/pool.ts" onOpen={() => {}} onClose={() => {}} />);
  expect(await screen.findByText('the graph store timed out')).toBeTruthy();
});

test('while a rebuild has no map written yet the card keeps waiting, then shows the new one', async () => {
  let phase: 'old' | 'none' | 'new' = 'old';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.method === 'POST') return Response.json({ queued: true }, { status: 202 });
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) {
      return Response.json(phase === 'none' ? { meta: null, hotspots: [] } : { meta: { ...meta, builtAt: phase === 'old' ? meta.builtAt : '2026-10-22T13:00:00Z' }, hotspots });
    }
    return Response.json([]);
  }));
  render(<CodeMap projectKey="demo" pollMs={10} />);
  await screen.findByText('src/db/pool.ts');
  phase = 'none';
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild map' }));
  await waitFor(() => expect(urls.filter((u) => u.startsWith('/api/projects/demo/codemap/hotspots')).length).toBeGreaterThan(3));
  expect(screen.getByText('src/db/pool.ts')).toBeTruthy();
  phase = 'new';
  expect(await screen.findByText(/map rebuilt/i)).toBeTruthy();
});

test('a map that cannot load says why; a file clicked again closes its panel', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'the store is starting' }, { status: 503 })));
  const { unmount } = render(<CodeMap projectKey="demo" />);
  expect(await screen.findByText('the store is starting')).toBeTruthy();
  unmount();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/module') ? { ...mod('src/db/pool.ts'), file: { ...mod('src/db/pool.ts').file, isTest: true } } : { meta, hotspots })));
  render(<CodeMap projectKey="demo" />);
  const file = await screen.findByRole('button', { name: 'src/db/pool.ts' });
  fireEvent.click(file);
  expect(await screen.findByText('test file')).toBeTruthy();
  fireEvent.click(file);
  expect(screen.queryByRole('region', { name: 'module src/db/pool.ts' })).toBeNull();
});

test('a file past a cap whose total was never counted says the map is capped', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/projects/demo/codemap/hotspots')) return Response.json({ meta, capped: { files: 4000, of: null }, hotspots });
    return Response.json({ error: 'not in the code map' }, { status: 404 });
  }));
  render(<ModulePanel projectKey="demo" path="docs/far.md" onOpen={() => {}} onClose={() => {}} />);
  const panel = await screen.findByRole('region', { name: 'module docs/far.md' });
  await waitFor(() => expect(panel.textContent).toMatch(/the map is capped at 4,000 files/));
});

test('a module that fails after you moved to another file leaves the new one alone', async () => {
  const slow = heldAnswer({ error: 'boom' }, { status: 500 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('path=src%2Fslow.ts')) return slow.answer();
    return Response.json(mod('src/fast.ts'));
  }));
  const { rerender } = render(<ModulePanel projectKey="demo" path="src/slow.ts" onOpen={() => {}} onClose={() => {}} />);
  rerender(<ModulePanel projectKey="demo" path="src/fast.ts" onOpen={() => {}} onClose={() => {}} />);
  await screen.findByRole('region', { name: 'module src/fast.ts' });
  await slow.deliver();
  expect(screen.queryByText('boom')).toBeNull();
});
