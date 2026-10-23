import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Activity } from './Activity.tsx';

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
