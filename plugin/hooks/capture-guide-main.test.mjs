import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { main } from '../../scripts/capture-guide.mjs';

// The browser, in-process: every eval answers an empty list (nothing to mask), except the leak check on the shots in
// `leaking`; a screenshot writes its file. The settings request is answered with no candidates.
let out, requests, calls;
function browser(leaking = []) {
  let shot = null;
  return async (cmd, ...args) => {
    calls.push(cmd);
    if (cmd === 'open') shot = args[0].split('#')[1];
    if (cmd === 'screenshot') writeFileSync(args[0], 'png');
    if (cmd !== 'eval') return '';
    const value = args[0].includes('findLeaks') && leaking.includes(shot) ? ['@ in "x"'] : [];
    return `result: ${JSON.stringify(JSON.stringify(value))}\n`;
  };
}
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'fg-capture-main-'));
  requests = []; calls = [];
  vi.stubGlobal('fetch', async (url) => { requests.push(String(url)); return Response.json({ candidates: [] }); });
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(out, { recursive: true, force: true }); });

test('with no arguments every shot is taken from the app on localhost:8787, and the exit code is 0', async () => {
  const logs = [];
  const code = await main([], { git: () => { throw new Error('not a repository'); }, axi: browser(), env: {}, out, log: (m) => logs.push(m), error: () => {} });
  expect(code).toBe(0);
  expect(requests).toEqual(['http://localhost:8787/api/settings/projects']);
  // Outside a repository there is no private-names file: only the built-in personal terms are checked.
  expect(logs[0]).toBe('checking 3 terms');
  expect(logs).toContain('saved dashboard.png');
  expect(existsSync(join(out, 'settings.png'))).toBe(true);
});

test('a base URL, a list of shots and the owner\'s names are taken from the command line, the repository and the environment', async () => {
  const names = join(out, 'private-names');
  writeFileSync(names, 'Jordan Owner\n');
  const logs = [];
  const code = await main(['http://fg.test/', 'dashboard,inbox'], { git: (...args) => (args.join(' ') === 'rev-parse --git-path info/private-names' ? names : ''), axi: browser(), env: { CAPTURE_PRIVATE_TERMS: 'acme' }, out, log: (m) => logs.push(m), error: () => {} });
  expect(code).toBe(0);
  expect(requests).toEqual(['http://fg.test/api/settings/projects']);
  expect(logs).toEqual(['checking 5 terms', 'saved dashboard.png', 'saved inbox.png']);
});

test('a refused shot, or a capture that fails, exits 1', async () => {
  const errors = [];
  expect(await main(['http://fg.test', 'dashboard,inbox'], { git: () => '', axi: browser(['inbox']), env: {}, out, log: () => {}, error: (m) => errors.push(m) })).toBe(1);
  expect(errors.at(-1)).toBe('not saved: inbox');
  vi.stubGlobal('fetch', async () => { throw new Error('connection refused'); });
  calls = [];
  expect(await main(['http://fg.test'], { git: () => '', axi: browser(), env: {}, out, log: () => {}, error: (m) => errors.push(m) })).toBe(1);
  expect(errors.at(-1)).toEqual(new Error('connection refused'));
  expect(calls).toEqual([]);
});
