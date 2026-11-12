import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { symbolsOnDemand } from './symbolsOnDemand.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fbsymbols-'));
  const outside = mkdtempSync(join(tmpdir(), 'fbsymbols-out-'));
  dirs.push(dir, outside);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('src/hub.ts', `export function route() {}\nfunction local() {}\n${'// x\n'.repeat(30_000)}`);
  w('src/small.go', 'package src\n\nfunc Small() int { return 1 }\n');
  w('src/huge.ts', `export const huge = 1;\n${'// x\n'.repeat(300_000)}`);
  w('docs/notes.md', '# Notes\n');
  w('src/.env.ts', 'export const leaked = 1;\n');
  writeFileSync(join(outside, 'secret.ts'), 'export const outsideSymbol = 1;\n');
  symlinkSync(join(outside, 'secret.ts'), join(dir, 'src/linked.ts'));
  return { dir, w };
}

test('a named file past the cap: its symbols are parsed on demand, within the map\'s own limits, and kept until it changes', async () => {
  const { dir, w } = repo();
  const parse = symbolsOnDemand({ maxBytes: 80_000, sourceMaxBytes: 1_000_000 }, 2);
  // A hub file over the scan's 80 kB is still a source file the map parses.
  expect((await parse(dir, 'src/hub.ts'))!.map((s) => [s.id, s.exported])).toEqual([['src/hub.ts#route', true], ['src/hub.ts#local', false]]);
  expect((await parse(dir, 'src/small.go'))!.map((s) => s.name)).toEqual(['Small']);
  // Bounded: over the source limit, not a parsed language, secret-named, a link out of the repo, or leaving it.
  for (const p of ['src/huge.ts', 'docs/notes.md', 'src/.env.ts', 'src/linked.ts', '../x.ts', '/etc/passwd', 'src//a.ts', 'src/missing.ts', '']) {
    expect(await parse(dir, p), p).toBeNull();
  }
  // Kept by content: the same answer object until the file changes.
  const first = await parse(dir, 'src/small.go');
  expect(await parse(dir, 'src/small.go')).toBe(first);
  w('src/small.go', 'package src\n\nfunc Bigger() int { return 2 }\n');
  expect((await parse(dir, 'src/small.go'))!.map((s) => s.name)).toEqual(['Bigger']);
  // At most `cacheFiles` kept: the least recently used is parsed again.
  const hub = await parse(dir, 'src/hub.ts');
  await parse(dir, 'src/small.go');
  w('src/third.ts', 'export const third = 3;\n');
  await parse(dir, 'src/third.ts');
  expect(await parse(dir, 'src/hub.ts')).not.toBe(hub);
  expect(await parse(dir, 'src/hub.ts')).toEqual(hub);
});
