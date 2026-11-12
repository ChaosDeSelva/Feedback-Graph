import type { Claim, Conflict, Question } from '@fb/core';
import { expect, test } from 'vitest';
import { knowledgeMarkdown, knowledgePackLines, type KnowledgeAnswer, type KnowledgeDeps } from './knowledge.ts';

const claim = (id: string, o: Partial<Claim>): Claim => ({
  id, projectKey: 'shop', docId: 'doc:shop:intake:call', window: 0, span: null, type: 'decision', statement: id, quote: `${id} said`, speakerId: 'person:ana',
  assertedAt: '2026-11-10T10:00:00.000Z', confidence: 0.9, scope: { area: null, files: [] }, about: 'retries', due: null, flags: [], status: 'accepted', decidedBy: 'you',
  decidedAt: null, factId: null, createdAt: '2026-11-10T10:00:00.000Z', run: null, sandbox: false, ...o,
});
const question: Question = {
  id: 'question:1', projectKey: 'shop', docId: 'doc:shop:intake:call', window: 0, text: 'Who owns retries?', kind: 'needs_owner', quote: null, askedBy: null, assignee: null,
  status: 'open', answerClaimId: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-10T10:00:00.000Z', run: null, sandbox: false,
};

function deps(claims: Claim[], conflicts: Conflict[] = []): KnowledgeDeps {
  const byId = new Map(claims.map((c) => [c.id, c]));
  return {
    intake: {
      searchClaims: async (q) => claims.filter((c) => (q.status ?? ['accepted']).includes(c.status)).map((c, i) => ({ claim: c, score: 0.95 - i / 100 })),
      listQuestions: async () => [question], conflictsFor: async (ids) => conflicts.filter((k) => ids.includes(k.a.id) || ids.includes(k.b.id)), claim: async (id) => byId.get(id) ?? null,
      person: async (id) => ({ id, displayName: 'Ana Example', isOwner: false, status: 'confirmed', aliases: [], claims: 1, createdAt: 't' }), people: async () => [],
      metas: async () => [{ docId: 'doc:shop:intake:call', kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: null, private: true, participants: [], windowsDone: 1, windowsTotal: 1 }],
    },
    facts: { searchFacts: async () => [], fact: async () => null },
    lessons: { searchLessons: async () => [], lessonDetail: async () => null },
    embed: async (t) => t.map(() => [1]),
  };
}

test("Ask's pack: accepted claims grouped by type with who said them, open questions, and both sides of an open conflict, each cited", async () => {
  const a = claim('Retries wait 30 seconds', {});
  const b = claim('Retries wait 60 seconds', { type: 'plan' });
  const waiting = claim('Retries move to a queue', { status: 'proposed' });
  const k: Conflict = {
    id: 'conflict:1', kind: 'disagreement', status: 'open', projectKey: 'shop', a: { kind: 'claim', id: a.id, fingerprint: 'x', assertedAt: a.assertedAt }, b: { kind: 'claim', id: b.id, fingerprint: 'y', assertedAt: b.assertedAt },
    signals: [], judge: null, resolution: null, decisionId: null, createdAt: 't', resolvedAt: null, resolvedBy: null, run: null, sandbox: false,
  };
  const cited: string[] = [];
  const lines = await knowledgePackLines('shop', 'what do we know about retries', deps([a, b, waiting], [k]), (kind, ref) => { cited.push(`${kind}:${ref}`); return `[S${cited.length}]`; });
  const text = lines.join('\n');
  expect(text).toContain('## What people said');
  expect(text).toMatch(/\[S1\] decision · Ana Example \(call, 2026-11-10\): Retries wait 30 seconds \[disputed: conflict:1\]/);
  expect(text).toMatch(/\[S2\] plan · Ana Example/);
  // An unreviewed claim is the owner's to accept first: not in the pack.
  expect(text).not.toContain('Retries move to a queue');
  expect(text).toMatch(/## Open questions[^]*Who owns retries\?/);
  expect(text).toMatch(/## Unresolved \(the owner has not chosen which is true: present each as disputed[^]*"Retries wait 30 seconds" \(Ana Example, 2026-11-10\) vs "Retries wait 60 seconds"/);
  expect(cited).toEqual([`claim:${a.id}`, `claim:${b.id}`, 'question:question:1', 'conflict:conflict:1']);
  expect(await knowledgePackLines('shop', 'nothing', deps([]), () => '[S1]')).toEqual([]);
});

test('the look-up in words: groups in order, unreviewed and disputed marked, quotes for the owner only, and an honest empty answer', () => {
  const item = (o: Partial<KnowledgeAnswer['items'][number]>): KnowledgeAnswer['items'][number] => ({
    kind: 'claim', group: 'decisions', id: 'claim:x', projectKey: 'shop', text: 'x', score: 0.9, status: 'accepted', type: 'decision', who: null, at: null, source: null, quote: null,
    unreviewed: false, disputed: [], note: null, ...o,
  });
  const a: KnowledgeAnswer = {
    query: 'retries', projects: ['shop'], conflicts: [], people: [], timeline: [],
    items: [item({ group: 'opinions', id: 'claim:o', text: 'too slow', who: { personId: 'p', name: 'Bo', owner: false } }), item({ id: 'claim:d', text: 'wait 30 s', quote: 'thirty', disputed: ['conflict:1'], unreviewed: true, note: 'reads only' })],
  };
  const owner = knowledgeMarkdown(a, { agent: false });
  expect(owner.indexOf('## Decisions')).toBeLessThan(owner.indexOf('## Opinions'));
  expect(owner).toContain('- wait 30 s · claim claim:d [unreviewed; disputed: conflict:1] (the developer\'s note: reads only)');
  expect(owner).toContain('  - said: "thirty"');
  expect(owner).toContain('- too slow · Bo · claim claim:o');
  expect(knowledgeMarkdown(a, { agent: true })).not.toContain('thirty');
  expect(knowledgeMarkdown({ ...a, items: [] }, { agent: true })).toContain('Nothing recorded is close enough');
});
