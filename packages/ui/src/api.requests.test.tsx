import { afterEach, expect, test, vi } from 'vitest';
import { api, errorMessage, SIGN_IN_EVENT } from './api.ts';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

/** fetch that records each request and answers with `answer`. */
function serve(answer: (url: string) => Response) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });
    return answer(url);
  }));
}
/** Counts sign-in prompts while `fn` runs. */
async function signIns(fn: () => Promise<unknown>) {
  let n = 0;
  const on = () => { n++; };
  window.addEventListener(SIGN_IN_EVENT, on);
  try { await fn().catch(() => {}); } finally { window.removeEventListener(SIGN_IN_EVENT, on); }
  return n;
}

afterEach(() => { vi.unstubAllGlobals(); });

test('saving local-only projects sends the list as JSON the server can read, not a JSON string of it', async () => {
  serve(() => Response.json({ projects: ['a', 'b'] }));
  await api.cloudLocalOnly(['a', 'b']);
  expect(calls).toEqual([{ url: '/api/cloud/local-only', method: 'PUT', body: { projects: ['a', 'b'] } }]);
});

test('a validation error from the server reads as its field messages; one with no fields as the status text', async () => {
  serve(() => Response.json({ error: { formErrors: [], fieldErrors: { rule: ['too long', 'empty'], scope: ['unknown'] } } }, { status: 400 }));
  await expect(api.decide('c1', 'confirmed')).rejects.toThrow('rule: too long, empty; scope: unknown');
  serve(() => Response.json({ error: { formErrors: [], fieldErrors: {} } }, { status: 400, statusText: 'Bad Request' }));
  await expect(api.decide('c1', 'confirmed')).rejects.toThrow(/^Bad Request$/);
});

test('a decision carries its note only when there is one', async () => {
  serve(() => new Response(null, { status: 204 }));
  await api.decide('c1', 'rejected', 'a bot comment');
  await api.decide('c2', 'confirmed');
  expect(calls.map((c) => c.body)).toEqual([{ status: 'rejected', note: 'a bot comment' }, { status: 'confirmed' }]);
});

test('a paged list that needs a sign-in asks for one and fails with the server reason', async () => {
  serve(() => Response.json({ error: 'sign in first' }, { status: 401 }));
  expect(await signIns(() => api.candidates('pending'))).toBe(1);
  await expect(api.candidates('pending')).rejects.toThrow('sign in first');
  expect(await signIns(() => api.docs('shop'))).toBe(1);
  await expect(api.docs('shop')).rejects.toThrow('sign in first');
  expect(await signIns(() => api.doc('d1'))).toBe(1);
  await expect(api.doc('d1')).rejects.toThrow('sign in first');
});

test('a document page asks for the size given; activity asks for 100 entries unless told otherwise', async () => {
  serve(() => Response.json([]));
  await api.docs('shop', { limit: 5 });
  await api.activity({});
  await api.activity({ limit: 7 });
  expect(calls.map((c) => c.url)).toEqual(['/api/projects/shop/docs?limit=5', '/api/activity?limit=100', '/api/activity?limit=7']);
});

test('a failure shows an Error by its message and anything else thrown as itself', () => {
  expect(errorMessage(new Error('the worker is writing'))).toBe('the worker is writing');
  expect(errorMessage('aborted')).toBe('aborted');
});
