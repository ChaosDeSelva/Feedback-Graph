import { claimFingerprint, decisionExecutor, factFingerprint, lessonFingerprint, resolutionDecision, type Claim, type ConflictSide, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { findContradictions, NOTES_MAX_BYTES, submitNotes } from './agentIntake.ts';
import { checkBeforeDone, getTaskContext, searchGraph, type ContextDeps } from './context.ts';
import { prepareIntakeSource, storeIntakeSource } from './intake.ts';

/**
 * Conflicts as caveats to agents (0.9.0 §6, §8), on each store: what an open conflict marks in get_task_context, its
 * brief, search_graph and check_before_done; that only accepted text is quoted; that a resolution changes what is
 * served; and the agent tools find_contradictions and submit_notes.
 */
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const embed = async (t: string[]) => t.map(() => vec(1));

describeStores('disputed knowledge served to agents', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });
  const deps = (o: Partial<ContextDeps> = {}): ContextDeps => ({
    roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
    embed,
    k: store.knowledge as never,
    facts: store.facts,
    judge: async () => [],
    activity: { record: async () => {} },
    intake: {
      store: store.intake,
      fact: (id) => store.facts.fact(id),
      lesson: async (id) => (await store.knowledge.lessonDetail(id))?.lesson ?? null,
      submit: async (project, n) => {
        const p = prepareIntakeSource(project, { projectKey: project.key, kind: 'notes', format: 'md', title: n.title, text: n.text, occurredAt: n.occurredAt, origin: n.origin, private: true });
        if ('error' in p) throw new Error(p.error);
        return { id: await storeIntakeSource({ store: store.intake, archive: false, docs: store.docs, embed, activity: store.activity }, p, { actor: n.origin, why: 'test' }), utterances: p.utterances.length };
      },
    },
    ...o,
  });

  /** A lesson and a fact agents are told, a claim Ana said (accepted) and one nobody accepted, and a conflict on each. */
  const seed = async (tag: string) => {
    await store.knowledge.upsertLesson({
      id: `lesson:${tag}`, projectKey: 'shop', title: `Retry timeout ${tag}`, rule: 'Retries wait 60 seconds', appliesWhen: 'changing the retry timeout', scope: 'project',
      paths: ['src/retry.ts'], status: 'approved', source: 'memory', embedding: vec(1),
    });
    const lesson = (await store.knowledge.lessonDetail(`lesson:${tag}`))!.lesson;
    const fact = await store.facts.addOwnerFact('shop', { kind: 'convention', statement: 'Retries wait 30 seconds between attempts', path: 'src/retry.ts', lines: null, confidence: 1, why: 'w', relevance: 0.9, embedding: vec(1) }, 'you');
    const docId = await store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: `${tag}.vtt`, title: tag, url: null }, [{ text: 'Ana: retries wait 30 seconds', embedding: vec(9) }]);
    const ana = (await store.intake.resolveAlias(`Ana ${tag}`, { create: true }))!.person;
    await store.intake.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'sync', private: true, participants: [ana.id] });
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (statement: string) => ({
      type: 'decision' as const, statement, quote: statement, speakerId: ana.id, span: null, assertedAt: '2026-11-10T10:00:00.000Z', confidence: 0.9,
      scope: { area: 'retries', files: ['src/retry.ts'] }, about: 'retry timeout', due: null, flags: [], embedding: vec(5),
    });
    await store.intake.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds'), draft('UNREVIEWED retries never wait')], questions: [] });
    const [said, unreviewed] = (await store.intake.listClaims({ docId })).sort((a, b) => a.statement.localeCompare(b.statement));
    const accepted = (await store.intake.decideClaim(said.id, { status: 'accepted' }, { by: 'you' }))!;
    const side = (c: Claim): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
    const open = async (a: ConflictSide, b: ConflictSide) => (await store.intake.openConflict({ kind: 'disagreement', projectKey: 'shop', a, b, signals: [], judge: null })).conflict;
    const onLesson = await open(side(accepted), { kind: 'lesson', id: lesson.id, fingerprint: lessonFingerprint(lesson), assertedAt: null });
    const onFact = await open(side(unreviewed), { kind: 'fact', id: fact.id, fingerprint: factFingerprint({ ...fact, current: true }), assertedAt: fact.createdAt });
    return { lesson, fact, accepted, unreviewed, ana, onLesson, onFact };
  };

  test('a fact an accepted claim became carries the conflict its claim is a side of', async () => {
    const s = await seed('claimfact');
    const fact = await store.facts.addOwnerFact('shop', { kind: 'decision', statement: 'Retries wait 30 seconds', path: 'src/retry.ts', lines: null, confidence: 1, why: 'Ana, 2026-11-10 call', relevance: 0.9, embedding: vec(1) }, 'you', null, { origin: 'claim' });
    await store.intake.decideClaim(s.accepted.id, { factId: fact.id }, { by: 'you' });
    expect((await store.intake.conflictsFor([fact.id])).map((k) => k.id)).toEqual([s.onLesson.id]);
    const full = (await getTaskContext({ project: 'shop', task: 'change the retry timeout in src/retry.ts' }, deps())).markdown;
    expect(full).toMatch(new RegExp(`- \\S+ \\(decision\\): Retries wait 30 seconds[^\\n]*\\[disputed: ${s.onLesson.id}\\]`));
  });

  test('open conflicts mark the lesson and fact they name, and a Disputed section quotes only what agents may see; resolutions change what is served', async () => {
    const s = await seed('ctx');
    const task = 'change the retry timeout in src/retry.ts';
    const full = (await getTaskContext({ project: 'shop', task }, deps())).markdown;
    expect(full).toContain(`Retries wait 60 seconds [disputed: ${s.onLesson.id}]`);
    expect(full).toMatch(new RegExp(`Retries wait 30 seconds between attempts.*\\[disputed: ${s.onFact.id}\\]`));
    const section = full.slice(full.indexOf('## Disputed'));
    expect(section).toContain(`Unresolved (${s.onLesson.id}): ${s.ana.displayName} (call, 2026-11-10) says "Retries wait 30 seconds"; lesson ${s.lesson.id} says "Retries wait 60 seconds". Do not state either as settled`);
    expect(section).toContain(`Unresolved (${s.onFact.id}): a statement from a call the developer has not accepted; fact ${s.fact.id} says`);
    // A claim nobody accepted is never quoted to an agent.
    expect(full).not.toContain('UNREVIEWED');

    const brief = (await getTaskContext({ project: 'shop', task, brief: true }, deps())).markdown;
    expect(brief).toContain(`[disputed: ${s.onLesson.id}]`);
    expect(brief).toContain('## Disputed');
    expect(brief.length).toBeLessThan(1_700);
    const search = (await searchGraph({ project: 'shop', query: task }, deps())).markdown;
    expect(search).toContain(`[disputed: ${s.onLesson.id}]`);
    expect(search).toContain('Items marked [disputed: …]');

    // The claim wins over the lesson: the lesson is superseded and no longer served. Both partly on the fact: served with the note.
    const x = decisionExecutor(store, { embed });
    for (const [k, r] of [[s.onLesson, { choice: 'a' as const }], [s.onFact, { choice: 'both' as const, note: 'reads 30 s, writes 60 s' }]] as const) {
      await x.apply((await store.decisions.propose(await resolutionDecision(store, (await store.intake.conflict(k.id))!, r, { by: 'you' }))).decision, { by: 'you' });
    }
    const after = (await getTaskContext({ project: 'shop', task }, deps())).markdown;
    expect(after).not.toContain(s.lesson.id);
    expect(after).not.toContain('[disputed:');
    expect(after).not.toContain('## Disputed');
    expect(after).toMatch(/Retries wait 30 seconds between attempts.*\(the developer's note: reads 30 s, writes 60 s\)/);
  });

  test('check_before_done does not call a gap on a disputed lesson: it is Cannot tell, with the conflict', async () => {
    const s = await seed('check');
    const r = await checkBeforeDone({ project: 'shop', task: 'change the retry timeout', summary: 'set the retry timeout', filesChanged: ['src/retry.ts'] },
      deps({ judge: async () => [{ lessonId: s.lesson.id, status: 'not_addressed', why: 'the timeout is still 30 s' }] }));
    expect(r.gaps.map((g) => g.lessonId)).not.toContain(s.lesson.id);
    expect(r.cannotTell).toEqual(expect.arrayContaining([expect.objectContaining({ lessonId: s.lesson.id, conflictId: s.onLesson.id })]));
    expect(r.markdown).toContain(`this lesson is disputed (${s.onLesson.id})`);
  });

  test('find_contradictions lists what may contradict a statement and the open conflicts there; without intake it says so', async () => {
    const s = await seed('find');
    const md = (await findContradictions({ project: 'shop', statement: 'Retries wait 45 seconds', files: ['src/retry.ts'] }, deps())).markdown;
    expect(md).toContain('## May contradict your statement');
    expect(md).toMatch(new RegExp(`fact ${s.fact.id}: "Retries wait 30 seconds between attempts" · .*30`));
    expect(md).toContain(`lesson ${s.lesson.id}`);
    expect(md).toContain(`Unresolved (${s.onLesson.id})`);
    expect(md).not.toContain('UNREVIEWED');
    expect((await findContradictions({ project: 'shop', statement: 'x' }, deps({ intake: undefined }))).markdown).toMatch(/intake is off/);
  });

  test('submit_notes stores an agent-submitted notes source for review, capped in size', async () => {
    const r = await submitNotes({ project: 'shop', notes: 'Bo: we will move retries to the queue worker\nAna: agreed', title: 'Retry follow-up', client: 'codex 1.2 (MCP)' }, deps());
    expect(r.isError).toBeUndefined();
    const id = /source (\S+) in shop/.exec(r.markdown)![1];
    expect(await store.intake.metas([id])).toEqual([expect.objectContaining({ kind: 'notes', origin: 'agent:codex 1.2', private: true })]);
    expect(r.markdown).toContain('nothing from them reaches agents until the developer accepts it');
    const big = await submitNotes({ project: 'shop', notes: 'x'.repeat(NOTES_MAX_BYTES + 1) }, deps());
    expect(big).toMatchObject({ isError: true });
    expect(big.markdown).toContain('at most 200 KB');
  });
});
