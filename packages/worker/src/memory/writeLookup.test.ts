import type { Candidate, GraphStore } from '@fb/core';
import { expect, test } from 'vitest';
import { memoryWriteLookup } from './memory.ts';

test('one memory pass asks the store once per page and per turn; reset forgets, so new feedback is seen next pass', async () => {
  let pages = 0;
  let calls = 0;
  const candidates = [{ id: 'fb1', turnUuid: 't1' }] as Candidate[];
  let written = false;
  const repo = {
    listCandidates: async () => { pages++; return candidates; },
    callsAfter: async () => { calls++; return { calls: written ? [{ name: 'Write', ts: 't', filePath: '/h/.claude/projects/x/memory/notes.md' }] : [] }; },
  } as unknown as Pick<GraphStore, 'listCandidates' | 'callsAfter'>;
  const lookup = memoryWriteLookup(repo);
  expect(await lookup.find('demo', 'memory/notes.md')).toBeNull();
  written = true;
  // Same pass: the cached (empty) calls are used.
  expect(await lookup.find('demo', 'notes.md')).toBeNull();
  expect([pages, calls]).toEqual([1, 1]);
  lookup.reset();
  expect(await lookup.find('demo', 'notes.md')).toBe('fb1');
  expect([pages, calls]).toEqual([2, 2]);
});
