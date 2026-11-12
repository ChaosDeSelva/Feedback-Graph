import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { heldAnswer } from './testing/heldAnswer.ts';

// The canvas graph can't render in jsdom: stand in a list of node buttons, and a camera that records what is asked of it.
vi.mock('react-force-graph-2d', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef((p: { graphData: { nodes: { id: string; label: string }[] }; onNodeClick: (n: object) => void; onRenderFramePost?: unknown }, ref) => {
      // The last props, so a test can draw a frame on a recording canvas (drawFrame); per graph too (Code mode draws captions).
      (globalThis as { lastGraphProps?: unknown }).lastGraphProps = p;
      graphs[p.onRenderFramePost ? 'code' : 'evidence'] = p;
      useImperativeHandle(ref, () => camera, []);
      return <ul>{p.graphData.nodes.map((n) => <li key={n.id}><button onClick={() => p.onNodeClick(n)}>{n.label}</button></li>)}</ul>;
    }),
  };
});
/** force-graph's props per drawing, as last rendered. */
const graphs: Record<'code' | 'evidence', any> = { code: null, evidence: null };
/** What fitting and laying out asked of force-graph: zoom levels, centres, forces set and simulation restarts. */
const camera = {
  level: 1,
  calls: [] as unknown[][],
  forces: new Map<string, Record<string, unknown>>(),
  zoomToFit(...a: unknown[]) { this.calls.push(['zoomToFit', ...a]); },
  zoom(k?: number, ms?: number) { if (k === undefined) return this.level; this.calls.push(['zoom', k, ms]); this.level = k; return this; },
  centerAt(x?: number, y?: number, ms?: number) { if (x === undefined) return { x: 10, y: 20 }; this.calls.push(['centerAt', x, y, ms]); return this; },
  d3ReheatSimulation() { this.calls.push(['reheat']); },
  d3Force(name: string, f?: unknown) {
    if (f !== undefined) { this.forces.set(name, f as Record<string, unknown>); return this; }
    const rec: Record<string, unknown> = {};
    for (const k of ['strength', 'distance', 'distanceMax']) rec[k] = (v: unknown) => { rec[`_${k}`] = v; return rec; };
    this.forces.set(name, rec);
    return rec;
  },
};
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
  camera.level = 1; camera.calls = []; camera.forces.clear(); graphs.code = graphs.evidence = null;
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
/**
 * Draws one frame of the code graph as force-graph would at `scale`, its nodes laid out 30 screen pixels apart (a map
 * map zoomed out to fit), on a canvas that records the captions written.
 */
function drawFrame(scale: number): string[] {
  const p = (globalThis as { lastGraphProps?: any }).lastGraphProps;
  const texts: string[] = [];
  let font = '';
  const ctx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'measureText') return (t: string) => ({ width: (t.length * 6) / scale });
      if (k === 'fillText') return (t: string) => texts.push(t);
      if (k === 'font') return font;
      return () => {};
    },
    set: (_t, k, v) => { if (k === 'font') font = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  p.onRenderFramePre?.();
  p.graphData.nodes.forEach((n: { x?: number; y?: number }, j: number) => {
    // Spread as a layout would, not in score order: the top files are not all side by side.
    const i = (j * 37) % p.graphData.nodes.length;
    n.x = ((i % 12) * 30) / scale;
    n.y = (Math.floor(i / 12) * 30) / scale;
    p.nodeCanvasObject(n, ctx, scale);
  });
  p.onRenderFramePost(ctx, scale);
  return texts;
}

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
  const shop = heldAnswer(graph);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([
      { key: 'empty', repoPath: '/x', sessions: 1, feedback: 0, lessons: 0, facts: 0, lastScan: null },
      { key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null },
    ]);
    if (url === '/api/graph?project=shop') return shop.answer();
    if (url === '/api/graph?project=empty') return Response.json(other);
    return Response.json([]);
  }));
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'empty' } });
  expect(await screen.findByText('empty project feedback')).toBeTruthy();
  await shop.deliver();
  expect(screen.getByText('empty project feedback')).toBeTruthy();
  expect(screen.queryByText('no tenant scoping')).toBeNull();
});

test('a project with no evidence graph shows its own pipeline counts', async () => {
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'empty' } });
  expect(await screen.findByText('No evidence graph yet')).toBeTruthy();
  expect((await screen.findByRole('region', { name: 'pipeline' })).textContent).toMatch(/empty: No evidence chains yet\./);
  expect(urls).toContain('/api/pipeline?project=empty');
});

test('Code mode at the default zoom names the key files and every file with misses, and marks those with how many', async () => {
  // A map zoomed out to fit: 60 files 30 px apart, closer than their captions are wide; one low-scoring file has a miss.
  const files = Array.from({ length: 60 }, (_, i) => fileOf(`src/mod${i}/index${i}.ts`, 60 - i, 0, true));
  files[50] = fileOf('src/cart/total.ts', 0.5, 1, false);
  const big = { ...codeGraph, files, imports: [], tests: [], lessons: [], misses: [{ ...codeGraph.misses[0], paths: ['src/cart/total.ts'] }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null }]);
    if (url.startsWith('/api/projects/shop/codemap/graph')) return Response.json(big);
    if (url.startsWith('/api/graph?')) return Response.json(graph);
    return Response.json([]);
  }));
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  await screen.findByText('src/cart/total.ts');
  const texts = drawFrame(0.4);
  expect(texts).toContain('total.ts (1 miss)');
  // The twelve top files by score are named too, not one.
  for (let i = 0; i < 12; i++) expect(texts).toContain(`index${i}.ts`);
});

/** A canvas that records each drawing call and property set, in order. */
function recordingCanvas() {
  const ops: unknown[][] = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 6 }) : (...a: unknown[]) => { ops.push([k, ...a]); }),
    set: (_t, k, v) => { ops.push([`${String(k)}=`, v]); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

async function codeMode() {
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  await screen.findByText('src/db/pool.ts');
}

test('Code mode spreads a new map out before it settles, then fits it once under the overlay, never zoomed past 3x', async () => {
  await codeMode();
  await waitFor(() => expect(camera.calls).toContainEqual(['reheat']));
  expect(camera.forces.get('charge')?._strength).toBe(-(80 + 5 * 1.2));
  expect([...camera.forces.keys()].sort()).toEqual(['charge', 'collide', 'link', 'x', 'y']);
  camera.calls = [];
  camera.level = 5;
  graphs.code.onEngineStop();
  expect(camera.calls).toEqual([['zoomToFit', 400, 48]]);
  // The canvas is 600 px high (its size before the observer reports one) and the overlay 0 + 12 px margin.
  await waitFor(() => expect(camera.calls.length).toBe(4));
  const z = 3 * (588 / 600);
  expect(camera.calls.slice(1)).toEqual([['zoom', 3, 250], ['zoom', z, 250], ['centerAt', 10, 20 - 6 / z, 250]]);
  // The fit's follow-up zoom runs 420 ms after an engine stop: on a fake timer, so it is past when this checks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    graphs.code.onEngineStop();
    vi.advanceTimersByTime(1000);
  } finally {
    vi.useRealTimers();
  }
  expect(camera.calls.length).toBe(4);
});

test('Code mode draws misses as diamonds and lessons as squares, rings a file with misses, and outlines the selected node', async () => {
  await codeMode();
  const nodes = graphs.code.graphData.nodes as { id: string; kind: string; x?: number; y?: number }[];
  const draw = (id: string) => {
    const { ctx, ops } = recordingCanvas();
    graphs.code.onRenderFramePre();
    graphs.code.nodeCanvasObject({ ...nodes.find((n) => n.id === id)!, x: 0, y: 0 }, ctx, 1);
    return ops;
  };
  const miss = draw('miss:miss:1');
  expect(miss.filter(([k]) => k === 'lineTo')).toHaveLength(3);
  expect(draw('lesson:l1').some(([k]) => k === 'rect')).toBe(true);
  // The file with misses: its circle, then a ring 3 px out in the miss colour.
  const pool = draw('file:src/db/pool.ts').filter(([k]) => k === 'arc');
  expect(pool).toHaveLength(2);
  expect((pool[1][3] as number) - (pool[0][3] as number)).toBe(3);
  expect(draw('file:src/api/orders.ts').filter(([k]) => k === 'arc')).toHaveLength(1);
  expect(draw('file:src/api/orders.ts')).toContainEqual(['lineWidth=', 1.5]);
  fireEvent.click(screen.getByText('src/api/orders.ts'));
  await screen.findByRole('region', { name: 'module src/api/orders.ts' });
  expect(draw('file:src/api/orders.ts')).toContainEqual(['lineWidth=', 3]);
});

test('Code mode keeps every node clickable when zoomed out: its hit area is at least 5 screen pixels', async () => {
  await codeMode();
  const lesson = graphs.code.graphData.nodes.find((n: { id: string }) => n.id === 'lesson:l1');
  const { ctx, ops } = recordingCanvas();
  graphs.code.nodePointerAreaPaint({ ...lesson, x: 1, y: 2 }, '#010203', ctx, 0.1);
  expect(ops).toContainEqual(['fillStyle=', '#010203']);
  expect(ops).toContainEqual(['arc', 1, 2, 50, 0, 2 * Math.PI]);
  const { ctx: near, ops: nearOps } = recordingCanvas();
  graphs.code.nodePointerAreaPaint({ ...lesson, x: 1, y: 2 }, '#010203', near, 4);
  expect(nearOps).toContainEqual(['arc', 1, 2, Math.sqrt(1.5) * 3, 0, 2 * Math.PI]);
});

test('Code mode tells links apart: tests dashed, misses and lessons dotted, a faint tie thin with no arrow', async () => {
  await codeMode();
  const p = graphs.code;
  expect(p.linkLineDash({ type: 'IMPORTS' })).toBeNull();
  expect(p.linkLineDash({ type: 'TESTS' })).toEqual([3, 2]);
  expect(p.linkLineDash({ type: 'EDITED' })).toEqual([1, 2]);
  expect(p.linkLineDash({ type: 'APPLIES_TO' })).toEqual([1, 2]);
  expect(p.linkLineDash({ type: 'NEAR' })).toEqual([1, 6]);
  expect([p.linkWidth({ type: 'NEAR' }), p.linkWidth({ type: 'IMPORTS' })]).toEqual([0.3, 0.6]);
  expect([p.linkDirectionalArrowLength({ type: 'NEAR' }), p.linkDirectionalArrowLength({ type: 'TESTS' })]).toEqual([0, 3]);
  expect(p.linkLabel({ type: 'NEAR' })).toMatch(/past the cap/);
  expect(p.linkLabel({ type: 'IMPORTS' })).toBe('IMPORTS');
});

test('Code mode: a lesson node shows the lesson, linked, and the files it applies to', async () => {
  await codeMode();
  fireEvent.click(screen.getByText('Release pool clients'));
  const aside = screen.getAllByRole('complementary', { name: 'node details' }).find((a) => a.textContent?.includes('approved lesson'))!;
  expect(within(aside).getByRole('link', { name: 'Release pool clients' }).getAttribute('href')).toBe('#lessons/l1');
  fireEvent.click(within(aside).getByText('src/db/pool.ts'));
  expect(await screen.findByRole('region', { name: 'module src/db/pool.ts' })).toBeTruthy();
});

test('Code mode with an empty map says the worker has not mapped the project yet', async () => {
  const inner = fetch as unknown as (url: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/projects/shop/codemap/graph')
    ? Response.json({ files: [], imports: [], tests: [], misses: [], lessons: [] }) : inner(url))));
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  expect(await screen.findByText('No code map yet')).toBeTruthy();
});

test('Code mode with no project selected says to choose folders in Settings', async () => {
  const inner = fetch as unknown as (url: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/projects' ? Response.json([]) : inner(url))));
  render(<Graph />);
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
  expect(await screen.findByText('No project yet')).toBeTruthy();
});

test('the evidence graph fits once when it settles, never zooming a handful of nodes past 3x, and outlines the selected node', async () => {
  render(<Graph />);
  await screen.findByText('no tenant scoping');
  camera.level = 8;
  graphs.evidence.onEngineStop();
  graphs.evidence.onEngineStop();
  expect(camera.calls).toEqual([['zoomToFit', 400, 48]]);
  await waitFor(() => expect(camera.calls).toEqual([['zoomToFit', 400, 48], ['zoom', 3, 250]]));
  const node = graphs.evidence.graphData.nodes.find((n: { id: string }) => n.id === 'miss:m1');
  const width = () => { const { ctx, ops } = recordingCanvas(); graphs.evidence.nodeCanvasObject({ ...node, x: 0, y: 0 }, ctx, 2); return ops.find(([k]) => k === 'lineWidth=')![1]; };
  expect(width()).toBe(0.75);
  fireEvent.click(screen.getByText('no tenant scoping'));
  await screen.findByRole('complementary', { name: 'node details' });
  expect(width()).toBe(1.5);
});

test('a small evidence graph that fits at 3x or less keeps its fitted zoom', async () => {
  render(<Graph />);
  await screen.findByText('no tenant scoping');
  camera.level = 2;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    graphs.evidence.onEngineStop();
    vi.advanceTimersByTime(1000);
  } finally {
    vi.useRealTimers();
  }
  expect(camera.calls).toEqual([['zoomToFit', 400, 48]]);
});

/** Code mode on a graph of `g`'s shape (the fixture's, changed). */
async function codeModeWith(g: object | Error) {
  const inner = fetch as unknown as (url: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/projects/shop/codemap/graph')
    ? (g instanceof Error ? Response.json({ error: g.message }, { status: 500 }) : Response.json(g)) : inner(url))));
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('shop'));
  fireEvent.click(screen.getByRole('button', { name: 'code' }));
}

test('Code mode: a code map that cannot load says why', async () => {
  await codeModeWith(new Error('the map is being rebuilt'));
  expect(await screen.findByText('the map is being rebuilt')).toBeTruthy();
});

test('Code mode: a map capped only by its neighbours says so; one capped only by its files says their neighbours are all there', async () => {
  await codeModeWith({ ...codeGraph, cap: { limit: 60, eligible: 1, neighbors: 2, neighborsFound: 9 } });
  expect(await screen.findByText(/Showing the top 1 of 1 file by hotspot score and 2 of their 9 neighbours/)).toBeTruthy();
  cleanup();
  await codeModeWith({ ...codeGraph, cap: { limit: 60, eligible: 140, neighbors: 2, neighborsFound: 2 } });
  expect(await screen.findByText(/Showing the top 1 of 140 files by hotspot score and their neighbours\./)).toBeTruthy();
});

test('Code mode: a map whose total was counted says how many it holds; one whose total was not says it is capped', async () => {
  await codeModeWith({ ...codeGraph, capped: { files: 4000, of: 10290 } });
  expect(await screen.findByText(/The map holds 4,000 of 10,290 files; files past the cap are not drawn\./)).toBeTruthy();
  cleanup();
  await codeModeWith({ ...codeGraph, capped: { files: 4000, of: null } });
  expect(await screen.findByText(/The map is capped at 4,000 files; files past the cap are not drawn\./)).toBeTruthy();
});

test('Code mode outlines a selected miss or lesson node, and names a plain file in normal weight once zoomed in', async () => {
  await codeMode();
  const nodes = graphs.code.graphData.nodes as { id: string }[];
  const width = (id: string) => {
    const { ctx, ops } = recordingCanvas();
    graphs.code.onRenderFramePre();
    graphs.code.nodeCanvasObject({ ...nodes.find((n) => n.id === id)!, x: 0, y: 0 }, ctx, 1);
    return ops.filter(([k]) => k === 'lineWidth=').map(([, v]) => v)[0];
  };
  fireEvent.click(screen.getByText('Release pool clients'));
  await waitFor(() => expect(width('lesson:l1')).toBe(3));
  expect(width('miss:miss:1')).toBe(1.5);
  // Zoomed in, the plain file's caption is drawn in the regular weight; a key file's in bold.
  const { ctx, ops } = recordingCanvas();
  graphs.code.onRenderFramePre();
  for (const n of graphs.code.graphData.nodes) graphs.code.nodeCanvasObject({ ...n, x: nodes.indexOf(n) * 200, y: 0 }, ctx, 4);
  graphs.code.onRenderFramePost(ctx, 4);
  const fonts = ops.filter(([k]) => k === 'font=').map(([, v]) => v);
  expect(fonts).toContain('600 2.75px sans-serif');
  expect(fonts).toContain('2.75px sans-serif');
});

test('Code mode does not shrink the fitted map under an overlay as tall as half the canvas', async () => {
  await codeMode();
  const overlay = screen.getByRole('list', { name: 'legend' }).closest('div')!.parentElement!;
  Object.defineProperty(overlay, 'offsetHeight', { value: 400 });
  camera.calls = [];
  camera.level = 1;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    graphs.code.onEngineStop();
    vi.advanceTimersByTime(1000);
  } finally {
    vi.useRealTimers();
  }
  expect(camera.calls).toEqual([['zoomToFit', 400, 48]]);
});

test('Code mode names a test file with misses at any zoom, though only plain files are key files', async () => {
  const files = [...codeGraph.files.slice(0, 2), { ...codeGraph.files[2], misses: 1 }];
  await codeModeWith({ ...codeGraph, files });
  await screen.findByText('test/pool.test.ts');
  expect(drawFrame(0.2)).toContain('pool.test.ts (1 miss)');
});

test('the evidence graph draws a cause biggest and a miss bigger than the rest; a node without a status names only its kind', async () => {
  render(<Graph />);
  await screen.findByText('no tenant scoping');
  const radius = (id: string) => {
    const { ctx, ops } = recordingCanvas();
    graphs.evidence.nodeCanvasObject({ ...graphs.evidence.graphData.nodes.find((n: { id: string }) => n.id === id), x: 0, y: 0 }, ctx, 1);
    return ops.find(([k]) => k === 'arc')![3] as number;
  };
  expect(radius('cause:context_available_ignored')).toBeGreaterThan(radius('miss:m1'));
  expect(radius('miss:m1')).toBeGreaterThan(radius('feedback:f1'));
  fireEvent.click(screen.getByText('no tenant scoping'));
  const aside = await screen.findByRole('complementary', { name: 'node details' });
  expect(within(aside).getByText('miss')).toBeTruthy();
  fireEvent.click(screen.getByText("this isn't good enough", { selector: 'button' }));
  expect(await within(aside).findByText('feedback · approved')).toBeTruthy();
});

test('the evidence graph opens on the first project when none has feedback, and says why when projects cannot load', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ key: 'quiet', repoPath: '/x', sessions: 1, feedback: 0, lessons: 0, facts: 0, lastScan: null }]);
    return url.startsWith('/api/graph?') ? Response.json({ nodes: [], links: [] }) : Response.json([]);
  }));
  render(<Graph />);
  await waitFor(() => expect((screen.getByLabelText('project') as HTMLSelectElement).value).toBe('quiet'));
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'the store is starting' }, { status: 503 })));
  render(<Graph />);
  expect(await screen.findByText('the store is starting')).toBeTruthy();
});
