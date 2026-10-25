import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ImportBundle } from './ImportBundle.tsx';

const result = {
  lessons: { added: 3, approved: 1, proposed: 2, existing: 1, excluded: 0, skipped: 0 },
  facts: { added: 12, projects: ['demo-shop'], skippedProjects: [] },
  notImported: { misses: 4, docs: 1, codeFiles: 30 },
};

let calls: { url: string; method?: string; body?: unknown }[];
let reply: () => Response;
beforeEach(() => {
  calls = [];
  reply = () => Response.json(result);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return reply();
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const bundle = { format: 'feedback-graph-export', schemaVersion: 1, lessons: [] };
const pick = (text: string) => fireEvent.change(screen.getByLabelText('import bundle file'), { target: { files: [new File([text], 'export.json', { type: 'application/json' })] } });

test('imports a bundle file and says what came in; lessons wait for approval unless you keep them approved', async () => {
  const done = vi.fn();
  render(<ImportBundle onImported={done} />);
  pick(JSON.stringify(bundle));
  expect(await screen.findByText(/3 lessons \(1 approved, 2 proposed\), 12 facts/)).toBeTruthy();
  expect(calls).toEqual([{ url: '/api/import', method: 'POST', body: bundle }]);
  expect(done).toHaveBeenCalled();

  fireEvent.click(screen.getByLabelText('keep approved lessons approved'));
  pick(JSON.stringify(bundle));
  await screen.findByText(/3 lessons/);
  expect(calls.at(-1)?.url).toBe('/api/import?keepApproved=1');
});

test('the message can be dismissed, and clears by itself after a while', async () => {
  // Long enough that a loaded test run still sees the message before it clears.
  render(<ImportBundle clearAfterMs={400} />);
  pick('not json');
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
  pick('not json');
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 3000 });
});

test('a file that is not JSON, or a bundle the server refuses, shows why', async () => {
  render(<ImportBundle />);
  pick('not json');
  expect((await screen.findByRole('alert')).textContent).toMatch(/not a JSON/);
  expect(calls).toEqual([]);
  reply = () => Response.json({ error: 'this bundle has schemaVersion 2' }, { status: 400 });
  pick(JSON.stringify(bundle));
  expect(await screen.findByText(/schemaVersion 2/)).toBeTruthy();
});
