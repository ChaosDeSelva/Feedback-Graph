import { afterEach, expect, test, vi } from 'vitest';
import { similarReports } from './dedupe.ts';
import { feedbackSkipRule } from './feedbackRules.ts';
import { filterOverrides, worktreeGitArgs } from './git.ts';
import { ollamaEmbed, ollamaPing } from './ollama.ts';
import { encodedCredential, looksLikeSecret, randomRun, redactDeep, redactStoredFact, redactStoredLesson } from './redact.ts';
import { archiveBeforeRedaction, archiveRedactionInput, setRedactionArchive } from './redactionArchive.ts';
import { readSummary } from './sessions.ts';
import type { ExternalRef } from './types.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.unstubAllGlobals());

test('similar reports need two meaningful words each', () => {
  expect(similarReports('the build is broken again', 'build broken again today')).toBe(true);
  expect(similarReports('broken', 'broken build')).toBe(false);
});

test('an approval whose praise follows an optional remark is still an approval when the review approved', () => {
  const ext = (reviewState?: 'APPROVED') => ({ source: 'github', kind: 'review', author: 'bob', authorKind: 'human', ...(reviewState ? { reviewState } : {}) }) as unknown as ExternalRef;
  expect(feedbackSkipRule('Approved with one optional remark. Thanks!', ext('APPROVED'))?.name).toBe('approval-summary');
  expect(feedbackSkipRule('Approved with one optional remark. Thanks!', ext())?.name).not.toBe('approval-summary');
});

test('a worktree whose .git names a relative git dir, or one visible as it is, needs no mapping', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fb-wt-'));
  const repo = join(base, 'wt');
  mkdirSync(repo);
  writeFileSync(join(repo, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
  expect(await worktreeGitArgs(repo, [{ host: base, container: '/vibe' }])).toEqual([]);
  mkdirSync(join(base, 'gitdir'));
  writeFileSync(join(repo, '.git'), `gitdir: ${join(base, 'gitdir')}\n`);
  expect(await worktreeGitArgs(repo, [{ host: base, container: '/vibe' }])).toEqual([]);
});

test('Ollama: the global fetch by default; an answer that is not OK says its status', async () => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { seen.push(url); return Response.json({ embeddings: [[1, 2]] }); });
  expect(await ollamaEmbed({ url: 'http://o:11434/', model: 'm', input: ['x'] })).toEqual([[1, 2]]);
  expect(seen).toEqual(['http://o:11434/api/embed']);
  const down = await ollamaPing({ url: 'http://o', models: ['m'], fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch });
  expect(down).toEqual({ url: 'http://o', ok: false, reason: 'Ollama at http://o answered HTTP 500' });
});

test('secret shapes: a file name is not one; digits with symbols are; a key of consonant runs and digits is random', () => {
  expect(looksLikeSecret('2024-report.pdf')).toBe(false);
  expect(looksLikeSecret('4821-9933!')).toBe(true);
  expect(randomRun('bcdfg123456hjklm789012')).toBe(true);
  // Not base64 that decodes (padding in the middle): not a credential.
  expect(encodedCredential('ab=')).toBe(false);
});

test('stored text with nothing in its optional fields is redacted as it is', () => {
  expect(redactStoredFact({ statement: 'uses sk-ant-api03-' + 'a'.repeat(40), why: null, current: true, origin: 'you' })).toMatchObject({ why: null, close: false });
  expect(redactStoredFact({ statement: 's', why: 'seen with sk-ant-api03-' + 'a'.repeat(40), current: true, origin: 'you' }).why).not.toContain('a'.repeat(40));
  const approved = redactStoredLesson({ status: 'approved', title: 'Rotate', rule: 'password = hunter22 is the staging one', appliesWhen: null, checks: null });
  expect(approved).toMatchObject({ appliesWhen: null, flagged: true });
  expect(redactStoredLesson({ status: 'proposed', title: 'T', rule: 'R', appliesWhen: null, checks: null })).toBeNull();
});

test('redactDeep passes number lists (embeddings) through untouched', () => {
  const v = { vector: [0.1, 0.2], tags: ['token=sk-ant-api03-' + 'b'.repeat(40)] };
  const out = redactDeep(v);
  expect(out.vector).toBe(v.vector);
  expect(out.tags[0]).not.toContain('b'.repeat(40));
});

test('with no archive set, redaction archives nothing and does not fail', async () => {
  setRedactionArchive(undefined);
  await expect(archiveBeforeRedaction('fact', 'f1', 'v')).resolves.toBeUndefined();
  await expect(archiveRedactionInput('fact', 'f1', 'a', 'b')).resolves.toBeUndefined();
});

test('a stored summary without an outcome reads as an empty one', () => {
  expect(readSummary({ goal: 'g', done: [] })).toMatchObject({ goal: 'g', outcome: '' });
});

test('a filter key with no driver name in it is no filter', () => {
  expect(filterOverrides('filter.lfs\0filter..clean\0')).toEqual([]);
});
