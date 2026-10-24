import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The canvas graph can't render in jsdom: stand in a list of node buttons.
vi.mock('react-force-graph-2d', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef((p: { graphData: { nodes: { id: string; label: string }[] }; onNodeClick: (n: object) => void }, _ref) => (
      <ul>{p.graphData.nodes.map((n) => <li key={n.id}><button onClick={() => p.onNodeClick(n)}>{n.label}</button></li>)}</ul>
    )),
  };
});
const { Graph } = await import('./Graph.tsx');

const graph = {
  nodes: [
    { id: 'feedback:f1', kind: 'feedback', label: "this isn't good enough", status: 'approved' },
    { id: 'miss:m1', kind: 'miss', label: 'no tenant scoping', status: null },
    { id: 'cause:context_available_ignored', kind: 'cause', label: 'context_available_ignored', status: null },
  ],
  links: [
    { source: 'miss:m1', target: 'feedback:f1', type: 'EXPLAINS' },
    { source: 'miss:m1', target: 'cause:context_available_ignored', type: 'CAUSED_BY' },
  ],
};
let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/projects') return Response.json([
      { key: 'empty', repoPath: '/x', sessions: 1, feedback: 0, lessons: 0, facts: 0, lastScan: null },
      { key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null },
    ]);
    if (url.startsWith('/api/graph?')) return Response.json(graph);
    if (url.startsWith('/api/projects/shop/codemap/graph')) return Response.json(codeGraph);
    const m = url.match(/^\/api\/projects\/shop\/codemap\/module\?path=(.+)$/);
    if (m) return Response.json(mod(decodeURIComponent(m[1])));
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fileOf = (path: string, score: number, misses: number, top: boolean, isTest = false) => ({ path, churn: 1, misses, dependents: 1, score, lang: 'typescript', loc: 10, isTest, top });
const codeGraph = {
  files: [fileOf('src/db/pool.ts', 9, 2, true), fileOf('src/api/orders.ts', 3, 0, false), fileOf('test/pool.test.ts', 0, 0, false, true)],
  imports: [{ from: 'src/api/orders.ts', to: 'src/db/pool.ts' }],
  tests: [{ test: 'test/pool.test.ts', target: 'src/db/pool.ts' }],
  misses: [{ missId: 'miss:1', missed: 'leaked pool clients on error', cause: 'implementation_error', causeExplanation: 'x', feedbackId: 'fb:1', feedbackText: 't', sessionId: 's1', ts: '2026-10-01T10:00:00Z', paths: ['src/db/pool.ts'], fixedHere: true, lessonId: 'l1' }],
  lessons: [{ id: 'l1', title: 'Release pool clients', paths: ['src/db/pool.ts'] }],
  cap: { limit: 60, eligible: 140, neighbors: 2, neighborsFound: 9 },
};
const mod = (path: string) => ({
  file: { path, lang: 'typescript', hash: 'h', loc: 120, isTest: false, churn: null },
  symbols: [{ id: `${path}#createPool`, path, name: 'createPool', kind: 'function', exported: true, lines: '1-9' }],
  importers: ['src/api/orders.ts'], imports: [], tests: ['test/pool.test.ts'], facts: [], misses: [], lessons: [],
});

test('Code mode draws the project\'s code map, says when it is capped, and a file opens its module panel', async () => {
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  expect(await screen.findByText('src/db/pool.ts')).toBeTruthy();
  expect(urls).toContain('/api/projects/shop/codemap/graph');
  for (const label of ['src/api/orders.ts', 'test/pool.test.ts', 'leaked pool clients on error', 'Release pool clients']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole('note').textContent).toMatch(/top 1 of 140 files by hotspot score and 2 of their 9 neighbours/);

  fireEvent.click(screen.getByText('src/db/pool.ts'));
  const panel = await screen.findByRole('region', { name: 'module src/db/pool.ts' });
  expect(await within(panel).findByText('createPool')).toBeTruthy();
  expect(urls).toContain('/api/projects/shop/codemap/module?path=src%2Fdb%2Fpool.ts');
  // A file named in the panel opens in its place.
  fireEvent.click(within(panel).getByText('src/api/orders.ts'));
  expect(await screen.findByRole('region', { name: 'module src/api/orders.ts' })).toBeTruthy();
});

test('Code mode: a miss shows its cause, feedback and files; include tests asks again with tests=1', async () => {
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  fireEvent.click(await screen.findByText('leaked pool clients on error'));
  const aside = screen.getAllByRole('complementary', { name: 'node details' }).find((a) => a.textContent?.includes('Files its session edited'))!;
  expect(within(aside).getByText('your feedback').getAttribute('href')).toContain('fb%3A1');
  fireEvent.click(within(aside).getByText('src/db/pool.ts'));
  expect(await screen.findByRole('region', { name: 'module src/db/pool.ts' })).toBeTruthy();

  fireEvent.click(screen.getByLabelText('include tests'));
  await waitFor(() => expect(urls).toContain('/api/projects/shop/codemap/graph?tests=1'));
});

test('opens on the first project with feedback and draws its evidence graph', async () => {
  render(<Graph />);
  expect(await screen.findByText('no tenant scoping')).toBeTruthy();
  expect(urls).toContain('/api/graph?project=shop');
});

test('clicking a node shows its details and its connections', async () => {
  render(<Graph />);
  fireEvent.click(await screen.findByText('no tenant scoping'));
  const panel = await screen.findByRole('complementary', { name: 'node details' });
  await waitFor(() => expect(panel.textContent).toContain('miss'));
  expect(panel.textContent).toContain('EXPLAINS');
  expect(panel.textContent).toContain('CAUSED_BY');
  expect(panel.textContent).toContain("this isn't good enough");
});

test('a slow graph for the project you left never replaces the one you picked', async () => {
  const other = { nodes: [{ id: 'feedback:f9', kind: 'feedback', label: 'empty project feedback', status: 'approved' }], links: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([
      { key: 'empty', repoPath: '/x', sessions: 1, feedback: 0, lessons: 0, facts: 0, lastScan: null },
      { key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null },
    ]);
    if (url === '/api/graph?project=shop') { await new Promise((r) => setTimeout(r, 80)); return Response.json(graph); }
    if (url === '/api/graph?project=empty') return Response.json(other);
    return Response.json([]);
  }));
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'empty' } });
  expect(await screen.findByText('empty project feedback')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 120));
  expect(screen.getByText('empty project feedback')).toBeTruthy();
  expect(screen.queryByText('no tenant scoping')).toBeNull();
});
