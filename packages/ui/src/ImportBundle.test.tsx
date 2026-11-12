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
  // Dismissed by hand: the message would not clear by itself during this test.
  const { unmount } = render(<ImportBundle clearAfterMs={600_000} />);
  pick('not json');
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
  unmount();
  // Cleared by itself: it may go before a slow run looks for it, so its showing is recorded as it happens.
  let shown = false;
  const watch = new MutationObserver(() => { shown ||= !!document.querySelector('[role="alert"]'); });
  watch.observe(document.body, { childList: true, subtree: true });
  render(<ImportBundle clearAfterMs={50} />);
  pick('not json');
  await waitFor(() => expect(shown).toBe(true));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  watch.disconnect();
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

test('on a read-only install the file picker and "keep approved" are both off and say why', async () => {
  const { OwnerWrites, READ_ONLY_TITLE } = await import('./ownerAccess.tsx');
  render(<OwnerWrites.Provider value={false}><ImportBundle /></OwnerWrites.Provider>);
  const keep = screen.getByLabelText('keep approved lessons approved') as HTMLInputElement;
  expect(keep.disabled).toBe(true);
  expect(keep.closest('label')!.title).toBe(READ_ONLY_TITLE);
  const file = screen.getByLabelText('import bundle file') as HTMLInputElement;
  expect(file.disabled).toBe(true);
  expect(file.closest('label')!.getAttribute('aria-disabled')).toBe('true');
});

test('revoked lessons and projects whose facts were kept are named in the summary', async () => {
  reply = () => Response.json({ ...result, lessons: { ...result.lessons, revoked: 2 }, facts: { ...result.facts, skippedProjects: ['shop', 'api'] } });
  render(<ImportBundle />);
  pick(JSON.stringify(bundle));
  expect(await screen.findByText(/1 approved, 2 proposed, 2 revoked\).*Facts kept for shop, api \(already scanned\)\./)).toBeTruthy();
});

test('claims and settled conflicts from knowledge intake are counted in the summary', async () => {
  reply = () => Response.json({ ...result, claims: { added: 3, facts: 1, existing: 2, skipped: 0 }, conflicts: { added: 1, existing: 0, skipped: 0 }, people: { added: 1, matched: 1 } });
  render(<ImportBundle />);
  pick(JSON.stringify(bundle));
  expect(await screen.findByText(/3 claims \(1 given to agents as facts\) and 1 settled conflict from knowledge intake\. 2 claims already here, left alone\./)).toBeTruthy();
});

test('closing the file picker without a file imports nothing', () => {
  render(<ImportBundle />);
  fireEvent.change(screen.getByLabelText('import bundle file'), { target: { files: [] } });
  expect(calls).toEqual([]);
  expect(screen.queryByRole('status')).toBeNull();
});
