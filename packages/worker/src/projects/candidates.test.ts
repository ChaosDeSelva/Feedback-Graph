import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FileState } from '../state.ts';
import { buildCandidates } from './candidates.ts';

const fx = (name: string) => join(import.meta.dirname, '../../../../fixtures', name);

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'fb-cand-'));
  const vibe = join(base, 'vibe');
  mkdirSync(join(vibe, 'demo-shop', 'app'), { recursive: true });
  mkdirSync(join(vibe, 'plain'));
  mkdirSync(join(vibe, '.hidden'));
  symlinkSync(join(vibe, 'plain'), join(vibe, 'linked'));
  execFileSync('git', ['init', '-q', join(vibe, 'demo-shop')]);
  execFileSync('git', ['-C', join(vibe, 'demo-shop'), 'remote', 'add', 'origin', 'git@github.com:o/demo-shop.git']);

  const claude = join(base, 'claude');
  const claudeFile = (name: string, cwd: string) => {
    mkdirSync(join(claude, name), { recursive: true });
    const p = join(claude, name, 's.jsonl');
    writeFileSync(p, JSON.stringify({ type: 'user', sessionId: name, cwd, timestamp: '2026-10-01T10:00:00Z', message: { content: 'hi' } }) + '\n');
    return p;
  };
  const c1 = claudeFile('a', `${vibe}/demo-shop/app`);
  const c2 = claudeFile('b', `${vibe}/gone`);
  const c3 = claudeFile('c', '/somewhere/else');
  utimesSync(c1, new Date('2026-10-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));

  const codex = join(base, 'codex');
  mkdirSync(codex);
  const codexFile = (fixture: string) => {
    const p = join(codex, `rollout-${fixture}`);
    writeFileSync(p, readFileSync(fx(`codex/${fixture}`), 'utf8').replaceAll('/work/', `${vibe}/`));
    return p;
  };
  const x1 = codexFile('normal.jsonl');
  const x2 = codexFile('legacy-bare.jsonl');
  const x3 = codexFile('subagent.jsonl'); // a reviewer agent, not a person: not counted
  for (const [p, d] of [[x1, '2026-10-22'], [x2, '2026-10-21'], [x3, '2026-10-23'], [c2, '2026-10-19'], [c3, '2026-10-19']] as const) {
    utimesSync(p, new Date(`${d}T00:00:00Z`), new Date(`${d}T00:00:00Z`));
  }
  const file = (path: string, source: 'claude' | 'codex') => {
    const s = execFileSync('stat', ['-f', '%z %m', path]).toString().trim().split(' ').map(Number);
    return { path, size: s[0], mtimeMs: s[1] * 1000, source };
  };
  const files = [file(c1, 'claude'), file(c2, 'claude'), file(c3, 'claude'), file(x1, 'codex'), file(x2, 'codex'), file(x3, 'codex')];
  return { vibe, files };
}

test('every top-level folder is a candidate, with its git remote and Claude Code / Codex session counts', async () => {
  const { vibe, files } = setup();
  const snap = await buildCandidates({ roots: [{ host: vibe, container: vibe }], files, state: new FileState(':memory:'), codexSessionsFound: true, now: () => '2026-10-23T00:00:00Z' });
  expect(snap.builtAt).toBe('2026-10-23T00:00:00Z');
  expect(snap.roots).toEqual([vibe]);
  expect(snap.candidates).toEqual([
    { key: 'demo-shop', path: `${vibe}/demo-shop`, exists: true, git: true, remote: 'github.com/o/demo-shop', claudeSessions: 1, codexSessions: 2, lastActivity: '2026-10-22T00:00:00.000Z' },
    { key: 'gone', path: `${vibe}/gone`, exists: false, git: false, remote: null, claudeSessions: 1, codexSessions: 0, lastActivity: '2026-10-19T00:00:00.000Z' },
    { key: 'plain', path: `${vibe}/plain`, exists: true, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null },
  ]);
  expect(snap.outsideRoots).toEqual({ claudeSessions: 1, codexSessions: 0 });
  expect(snap.codexSessionsFound).toBe(true);
});

test('a git folder that is another clone of an existing project says which, before any of its sessions is read', async () => {
  const { vibe, files } = setup();
  const asked: string[] = [];
  const snap = await buildCandidates({
    roots: [{ host: vibe, container: vibe }], files, state: new FileState(':memory:'), codexSessionsFound: true,
    cloneOf: async (f) => { asked.push(`${f.key} ${f.remote}`); return 'shop-main'; },
  });
  expect(asked).toEqual(['demo-shop github.com/o/demo-shop']); // only folders with a remote
  expect(snap.candidates.map((c) => [c.key, c.cloneOf])).toEqual([['demo-shop', 'shop-main'], ['gone', null], ['plain', null]]);
});

test('a root whose folder is not mounted adds no candidates, and a missing Codex folder is reported', async () => {
  const { vibe, files } = setup();
  const host = '/Users/me/Elsewhere';
  const snap = await buildCandidates({ roots: [{ host: vibe, container: vibe }, { host, container: '/nonexistent-root' }], files, state: new FileState(':memory:'), codexSessionsFound: false });
  expect(snap.roots).toEqual([vibe, host]);
  expect(snap.codexSessionsFound).toBe(false);
  expect(snap.candidates.map((c) => c.key)).toEqual(['demo-shop', 'gone', 'plain']);
});

test('the folder of each file comes back too, so ingest can skip files of folders nobody selected', async () => {
  const { vibe, files } = setup();
  const snap = await buildCandidates({ roots: [{ host: vibe, container: vibe }], files, state: new FileState(':memory:'), codexSessionsFound: true });
  const byName = Object.fromEntries([...snap.folderOf].map(([p, k]) => [p.split('/').slice(-2).join('/'), k]));
  expect(byName['a/s.jsonl']).toBe('demo-shop');
  expect(byName['c/s.jsonl']).toBeNull();
  expect(byName['codex/rollout-normal.jsonl']).toBe('demo-shop');
});

test('a Codex session that moved into another folder counts there too, and ingest is told every folder it was in', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fb-cand-cwd-'));
  const vibe = join(base, 'vibe');
  mkdirSync(join(vibe, 'admin-panel'), { recursive: true });
  // Started outside every root, then switched into demo-shop and admin-panel.
  const text = readFileSync(fx('codex/cwd-change.jsonl'), 'utf8').replace('"cwd":"/work/demo-shop"', '"cwd":"/scratch"').replaceAll('/work/', `${vibe}/`);
  const path = join(base, 'rollout-moved.jsonl');
  writeFileSync(path, text);
  const state = new FileState(':memory:');
  const roots = [{ host: vibe, container: vibe }];
  const build = async () => buildCandidates({ roots, files: [{ path, size: readFileSync(path).length, mtimeMs: 1, source: 'codex' }], state, codexSessionsFound: true, remote: async () => null });

  const snap = await build();
  expect(snap.folderOf.get(path)).toEqual(['demo-shop', 'admin-panel']);
  expect(snap.candidates.map((c) => [c.key, c.codexSessions])).toEqual([['admin-panel', 1], ['demo-shop', 1]]);
  expect(snap.outsideRoots.codexSessions).toBe(0);

  // Appended later: only the new bytes are scanned, and the new folder is added.
  const more = `${JSON.stringify({ timestamp: '2026-10-01T11:00:00.000Z', type: 'turn_context', payload: { cwd: `${vibe}/third/sub` } })}\n`;
  writeFileSync(path, text + more);
  const again = await build();
  expect(again.folderOf.get(path)).toEqual(['demo-shop', 'admin-panel', 'third']);
  expect(state.getCwds(path)?.scanned).toBe(readFileSync(path).length);
});
