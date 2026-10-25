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
let graphMeta: object | null = null;
let zeroScores = false;
beforeEach(() => {
  urls = [];
  graphMeta = null;
  zeroScores = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/projects') return Response.json([
      { key: 'empty', repoPath: '/x', sessions: 1, feedback: 0, lessons: 0, facts: 0, lastScan: null },
      { key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null },
    ]);
    if (url === '/api/graph?project=empty') return Response.json({ nodes: [], links: [] });
    if (url.startsWith('/api/graph?')) return Response.json(graph);
    if (url.startsWith('/api/pipeline')) return Response.json({ stage: null, progress: null, sessions: 1, classify: null, inbox: { pending: 0, confirmed: 0 }, postmortems: null, lessons: { proposed: 0, approved: 0 }, scans: null });
    if (url.startsWith('/api/projects/shop/codemap/graph')) {
      const g = zeroScores ? { ...codeGraph, files: codeGraph.files.map((f) => ({ ...f, score: 0, misses: 0 })) } : codeGraph;
      return Response.json(graphMeta ? { ...g, meta: graphMeta } : g);
    }
    if (url.startsWith('/api/projects/shop/codemap/hotspots')) return Response.json({ meta: null, hotspots: [{ path: 'src/deep/types.go', churn: 1, misses: 0, dependents: 0, score: 1 }] });
    const m = url.match(/^\/api\/projects\/shop\/codemap\/module\?path=(.+)$/);
    if (m) return Response.json(mod(decodeURIComponent(m[1])));
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a cause node reads as the same label and badge as on Lessons and Patterns, not its raw key', async () => {
  render(<Graph />);
  fireEvent.click(await screen.findByRole('button', { name: 'context available, ignored' }));
  const aside = screen.getByRole('complementary', { name: 'node details' });
  expect(within(aside).getAllByText('context available, ignored').length).toBeGreaterThan(0);
  expect(screen.queryByText('context_available_ignored')).toBeNull();
});

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

test('Code mode says when the map itself is capped, and how to raise the cap', async () => {
  graphMeta = { fingerprint: 'x', builtAt: '2026-10-22T12:00:00Z', stats: { files: 392, symbols: 1, imports: 1, tests: 0 }, candidates: 10_290 };
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  await screen.findByText('src/db/pool.ts');
  const notes = screen.getAllByRole('note').map((n) => n.textContent).join(' ');
  expect(notes).toMatch(/map holds 392 of 10,290 files/);
  expect(notes).toMatch(/SCAN_MAX_FILES/);
});

test('toNodes: files carry their shortest unique label; a file with no drawn neighbour is tied faintly to the top hub', async () => {
  const { toNodes } = await import('./CodeGraph.tsx');
  const g = {
    ...codeGraph,
    files: [...codeGraph.files, fileOf('src/tools/read/index.ts', 5, 0, true), fileOf('src/tools/write/index.ts', 4, 0, true)],
  };
  const { nodes, links } = toNodes(g as Parameters<typeof toNodes>[0]);
  const node = (p: string) => nodes.find((n) => n.path === p)!;
  expect(node('src/tools/read/index.ts').short).toBe('read/index.ts');
  expect(node('src/db/pool.ts').short).toBe('pool.ts');
  expect(node('src/db/pool.ts').top).toBe(true);
  expect(node('src/api/orders.ts').top).toBe(false);
  const near = links.filter((l) => l.type === 'NEAR');
  expect(near).toEqual([
    { source: 'file:src/tools/read/index.ts', target: 'file:src/db/pool.ts', type: 'NEAR' },
    { source: 'file:src/tools/write/index.ts', target: 'file:src/db/pool.ts', type: 'NEAR' },
  ]);
});

test('Code mode: the find-file box opens any mapped file\'s module panel, and the panel links to itself', async () => {
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  await screen.findByText('src/db/pool.ts');
  const box = screen.getByLabelText('find file');
  fireEvent.change(box, { target: { value: 'src/deep/types.go' } });
  fireEvent.submit(box.closest('form')!);
  const panel = await screen.findByRole('region', { name: 'module src/deep/types.go' });
  expect(urls).toContain('/api/projects/shop/codemap/module?path=src%2Fdeep%2Ftypes.go');
  expect(within(panel).getByRole('link', { name: /link to this file/i }).getAttribute('href')).toBe('#projects/shop/src%2Fdeep%2Ftypes.go');
});

test('Code mode says "no hotspots yet" when every file scores 0', async () => {
  zeroScores = true;
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  await screen.findByText('src/db/pool.ts');
  expect(screen.getAllByRole('note').map((n) => n.textContent).join(' ')).toMatch(/No hotspots yet/);
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

test('a project with no evidence graph shows its own pipeline counts', async () => {
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'empty' } });
  expect(await screen.findByText('No evidence graph yet')).toBeTruthy();
  expect((await screen.findByRole('region', { name: 'pipeline' })).textContent).toMatch(/empty: nothing to show here yet/);
  expect(urls).toContain('/api/pipeline?project=empty');
});
