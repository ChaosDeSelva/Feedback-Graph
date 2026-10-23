import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
