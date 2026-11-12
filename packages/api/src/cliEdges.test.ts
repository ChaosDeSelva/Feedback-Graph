import { expect, test } from 'vitest';
import { run, waited, type CliIO } from './cli.ts';

/** A CLI whose requests are answered by `answer` and recorded; what it printed, by stream. */
function cli(env: Record<string, string>, answer: (path: string) => unknown) {
  const urls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    env, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {},
    fetch: (async (url: string) => { urls.push(url); return Response.json(answer(new URL(url).pathname)); }) as typeof fetch,
  };
  return { io, urls, out, err };
}
const idle = { version: '0.7.6', workerHealthy: true, stage: { name: 'waiting', startedAt: '2026-10-25T03:50:00Z', current: null } };
const pipeline = (lessons: object) => ({ stage: null, progress: null, sessions: 0, classify: { backlog: 0, capped: false }, inbox: { pending: 0, confirmed: 0 }, postmortems: { queued: 0 }, lessons, scans: { done: 0, queued: 0, running: 0, failed: 0, never: 0 } });

test('a token is never sent to another local port than this checkout\'s API_PORT', async () => {
  const wrong = cli({ API_TOKEN: 't'.repeat(32) }, () => idle);
  expect(await run(['status', '--url', 'http://localhost:9000'], wrong.io)).toBe(2);
  expect(wrong.err.join('\n')).toMatch(/refusing to send this install's token to local port 9000; this checkout's API_PORT is 8787/);
  expect(wrong.urls).toEqual([]);
  // No port means the scheme's default, which is not this install's either.
  const bare = cli({ API_TOKEN: 't'.repeat(32) }, () => idle);
  expect(await run(['status', '--url', 'http://127.0.0.1'], bare.io)).toBe(2);
  expect(bare.err.join('\n')).toMatch(/local port 80;/);
  const mine = cli({ API_TOKEN: 't'.repeat(32), API_PORT: '9000' }, (p) => (p === '/api/pipeline' ? pipeline({ proposed: 0, approved: 0 }) : idle));
  expect(await run(['status', '--url', 'http://localhost:9000'], mine.io)).toBe(0);
  expect(mine.urls[0]).toBe('http://localhost:9000/api/status');
});

test('status says plainly when no lesson was decided in the window', async () => {
  const quality = [{ days: 30, asWritten: 0, edited: 0, rejected: 0, decided: 0 }];
  const f = cli({}, (p) => (p === '/api/pipeline' ? pipeline({ proposed: 3, approved: 0, quality }) : idle));
  expect(await run(['status'], f.io)).toBe(0);
  expect(f.out.join('\n')).toMatch(/lessons\s+last 30 d: no lessons decided/);
});

test('waited rounds a wait to seconds, minutes, hours up to two days, then days', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  expect(waited(ago(40), now)).toBe('40 s');
  expect(waited(ago(14 * 60 + 59), now)).toBe('14 min');
  expect(waited(ago(3 * 3600), now)).toBe('3 h');
  expect(waited(ago(47 * 3600), now)).toBe('47 h');
  expect(waited(ago(48 * 3600), now)).toBe('2 d');
  // A clock a little ahead of the server's never prints a negative wait.
  expect(waited(ago(-30), now)).toBe('0 s');
});
