import { expect, test } from 'vitest';
import { parseTranscript } from './parseTranscript.ts';

test('a user record whose content is neither text nor parts (a malformed or future shape) is not a human turn', () => {
  const line = (o: object) => JSON.stringify({ sessionId: 's', cwd: '/H/demo', ...o });
  const [s] = parseTranscript([
    line({ type: 'user', uuid: 'u0', timestamp: '2026-10-01T10:00:00Z', message: { content: 'build it' } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:01:00Z', message: { content: { kind: 'unknown' } } }),
    line({ type: 'user', uuid: 'u2', timestamp: '2026-10-01T10:02:00Z', message: {} }),
  ].join('\n'), 's.jsonl');
  expect(s.turns.map((t) => t.uuid)).toEqual(['u0']);
});

test('a timestamp no store can hold (minute 60, 30 February) is the session\'s latest so far, so the transcript still ingests', () => {
  const line = (o: object) => JSON.stringify({ sessionId: 's', cwd: '/H/demo', ...o });
  const [s] = parseTranscript([
    line({ type: 'user', uuid: 'u0', timestamp: '2026-11-10T09:59:00Z', message: { content: 'build it' } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-11-10T09:60:00Z', message: { content: 'No, keep cents in chargeCard' } }),
    line({ type: 'user', uuid: 'u2', timestamp: '2026-02-30T10:00:00Z', message: { content: 'and revert the rest' } }),
  ].join('\n'), 's.jsonl');
  expect(s.turns.map((t) => [t.uuid, t.ts])).toEqual([['u0', '2026-11-10T09:59:00Z'], ['u1', '2026-11-10T09:59:00Z'], ['u2', '2026-11-10T09:59:00Z']]);
  expect(s.endedAt).toBe('2026-11-10T09:59:00Z');
  // The first record has nothing before it: skipped.
  const [t] = parseTranscript([line({ type: 'user', uuid: 'v0', timestamp: '2026-13-01T00:00:00Z', message: { content: 'x' } }), line({ type: 'user', uuid: 'v1', timestamp: '2026-11-10T10:00:00.123+02:00', message: { content: 'y' } })].join('\n'), 't.jsonl');
  expect(t.turns.map((x) => x.uuid)).toEqual(['v1']);
});
