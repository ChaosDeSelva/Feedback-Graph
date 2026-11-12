import { beforeAll, expect, test } from 'vitest';
import { factFingerprint, lessonFingerprint, TargetChangedError } from '../decisions/record.ts';
import { aliasNorm, AliasTakenError, answerClaimIdOf, claimFingerprint, claimIdOf, conflictFingerprint, conflictIdOf, FORGOTTEN_NAME, type ClaimSnapshotFields, type ConflictSnapshotFields } from '../intake/records.ts';
import type { IntakeStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Claim, ClaimDraft, ConflictInput, ConflictSide, QuestionDraft, RunTag } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
/** Between two vectors: closer to `a` the larger `w` is. */
const mix = (a: number, b: number, w: number) => Array.from({ length: 768 }, (_, i) => (i === a ? w : i === b ? 1 - w : 0));
const SECRET = `ghp_${'A1b2'.repeat(9)}`;
const nextMs = () => new Promise((r) => setTimeout(r, 5));

const draft = (statement: string, over: Partial<ClaimDraft> = {}): ClaimDraft => ({
  type: 'decision', statement, quote: statement, speakerId: null, span: { utt: 1, start: 0, end: statement.length }, assertedAt: '2026-11-10T10:00:00.000Z',
  confidence: 0.9, scope: { area: 'retries', files: ['src/retry.ts'] }, about: 'retry timeout', due: null, flags: [], embedding: vec(1), ...over,
});
const ask = (text: string, over: Partial<QuestionDraft> = {}): QuestionDraft => ({ text, kind: 'unanswered', quote: null, askedBy: null, ...over });

describeStores('IntakeStore', (h) => {
  let s: IntakeStore;
  beforeAll(() => {
    s = h.store.intake;
  });

  /** A source: an intake Doc with its details. */
  const source = async (ref = 'sync.vtt', o: { projectKey?: string; run?: RunTag; participants?: string[] } = {}) => {
    const docId = await h.store.docs.upsertDoc({ projectKey: o.projectKey ?? 'shop', source: 'intake', ref, title: ref, url: null }, [{ text: 'Ana: retries wait 30 seconds', embedding: vec(9) }], { run: o.run });
    expect(await s.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'weekly sync', private: true, participants: o.participants ?? [] })).toBe(true);
    const next = (await s.nextWindow(docId))!;
    return { docId, version: next.version };
  };
  const ownerFact = (statement: string, projectKey = 'shop') => h.store.facts.addOwnerFact(projectKey, { kind: 'convention', statement, path: 'src/retry.ts', lines: null, confidence: 1, why: 'w', embedding: vec(2) }, 'you');
  const side = (c: Claim): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
  const conflictInput = (a: ConflictSide, b: ConflictSide, over: Partial<ConflictInput> = {}): ConflictInput => ({
    kind: 'disagreement', projectKey: 'shop', a, b, signals: [{ family: 'number', key: 'seconds', a: ['30 s'], b: ['60 s'], why: '30 s vs 60 s' }],
    judge: { relation: 'contradicts', aQuote: '30 seconds', bQuote: '60 seconds', explanation: 'the timeouts differ', confidence: 0.9, model: 'ollama:test' }, ...over,
  });
  /** Two accepted claims from one source, and the conflict between them. */
  const disputed = async () => {
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds'), draft('Retries wait 60 seconds', { embedding: vec(3) })], questions: [] });
    const [a, b] = (await s.listClaims({ docId })).sort((x, y) => x.id.localeCompare(y.id));
    const { conflict } = await s.openConflict(conflictInput(side(a), side(b)));
    return { docId, a, b, conflict };
  };

  test('a source\'s details belong to an intake Doc; a missing Doc has none', async () => {
    expect(await s.upsertMeta({ docId: 'doc:none', kind: 'notes', format: 'md', occurredAt: null, origin: null, private: false, participants: [] })).toBe(false);
    const ana = (await s.resolveAlias('Ana Lima', { create: true }))!.person;
    const { docId, version } = await source('sync.vtt', { participants: [ana.id, 'person:gone'] });
    expect(await s.metas([docId, 'doc:none'])).toEqual([{
      docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'weekly sync', private: true, participants: [ana.id], windowsDone: 0, windowsTotal: null,
    }]);
    expect(await s.nextWindow(docId)).toEqual({ window: 0, version });
    expect(await s.nextWindow('doc:none')).toBeNull();
    // The details change in place; the list of who attended is replaced.
    expect(await s.upsertMeta({ docId, kind: 'notes', format: 'md', occurredAt: null, origin: `see ${SECRET}`, private: false, participants: [] })).toBe(true);
    expect(await s.metas([docId])).toEqual([expect.objectContaining({ kind: 'notes', format: 'md', private: false, participants: [], origin: expect.not.stringContaining(SECRET) })]);
  });

  test('saving a window is idempotent: the same records again, decided ones untouched, dropped undecided ones removed', async () => {
    const { docId, version } = await source();
    const save = (claims: ClaimDraft[], questions: QuestionDraft[] = []) => s.saveWindow(docId, { window: 0, version, total: 3, claims, questions });
    expect(await save([draft(`Retries wait 30 seconds, token ${SECRET}`), draft('We ship on 12 December', { type: 'plan', due: '2026-12-12' })], [ask('Who owns the retry change?')])).toBe(true);
    const first = await s.listClaims({ docId });
    expect(first).toHaveLength(2);
    expect(first.every((c) => c.status === 'proposed' && c.projectKey === 'shop' && c.window === 0 && c.run === null && !c.sandbox)).toBe(true);
    expect(first.map((c) => c.statement).join(' ')).not.toContain(SECRET);
    expect((await s.metas([docId]))[0]).toMatchObject({ windowsDone: 1, windowsTotal: 3 });
    expect(await s.nextWindow(docId)).toEqual({ window: 1, version });

    expect(await save([draft(`Retries wait 30 seconds, token ${SECRET}`), draft('We ship on 12 December', { type: 'plan', due: '2026-12-12' })], [ask('Who owns the retry change?')])).toBe(true);
    expect(await s.listClaims({ docId })).toEqual(first);
    expect(await h.probe.count('Question')).toBe(1);

    const kept = first.find((c) => c.type === 'decision')!;
    await s.decideClaim(kept.id, { status: 'accepted' }, { by: 'you' });
    // A window read again with fewer, reworded claims: the accepted one stays as accepted; the other one is gone.
    expect(await save([draft('Retries wait thirty seconds')], [])).toBe(true);
    const after = await s.listClaims({ docId });
    expect(after.map((c) => [c.id, c.status, c.statement])).toEqual([[kept.id, 'accepted', kept.statement]]);
    expect(await h.probe.count('Question')).toBe(0);
    // A later window does not move windowsDone back.
    expect(await s.saveWindow(docId, { window: 2, version, claims: [], questions: [] })).toBe(true);
    expect(await s.saveWindow(docId, { window: 1, version, claims: [], questions: [] })).toBe(true);
    expect((await s.metas([docId]))[0].windowsDone).toBe(3);
    expect(await s.saveWindow('doc:none', { window: 0, version, claims: [], questions: [] })).toBe(false);
  });

  test('a new upload of the source starts the windows again and replaces the old upload\'s undecided records', async () => {
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds'), draft('Use Redis')], questions: [ask('When?')] });
    const [accepted] = await s.listClaims({ docId, type: ['decision'] });
    await s.decideClaim(accepted.id, { status: 'accepted' }, { by: 'you' });
    await nextMs();
    await h.store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: 'sync.vtt', title: 'sync.vtt', url: null }, [{ text: 'Ana: retries wait 30 seconds', embedding: vec(9) }]);
    const next = (await s.nextWindow(docId))!;
    expect(next.window).toBe(0);
    expect(next.version).not.toBe(version);
    expect((await s.metas([docId]))[0]).toMatchObject({ windowsDone: 0, windowsTotal: null });
    // A save of the old upload is refused.
    expect(await s.saveWindow(docId, { window: 1, version, claims: [draft('stale')], questions: [] })).toBe(false);
    expect(await s.saveWindow(docId, { window: 0, version: next.version, claims: [draft('Retries wait 45 seconds')], questions: [] })).toBe(true);
    const claims = await s.listClaims({ docId });
    expect(claims.map((c) => c.statement).sort()).toEqual(['Retries wait 30 seconds', 'Retries wait 45 seconds']);
    expect(claims.find((c) => c.statement.includes('30'))!.id).toBe(accepted.id);
    expect(claims.find((c) => c.statement.includes('45'))!.id).toBe(claimIdOf(docId, next.version, 0, 0));
    expect(await h.probe.count('Question')).toBe(0);
  });

  test('decideClaim changes only the patch\'s keys, records who decided, and refuses a claim changed since (expect)', async () => {
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds')], questions: [] });
    const [c] = await s.listClaims({ docId });
    const before = claimFingerprint(c);
    const edited = (await s.decideClaim(c.id, { statement: `Retries wait 30 s ${SECRET}`, scope: { area: null, files: [] } }, { by: 'you', expect: before }))!;
    expect(edited).toMatchObject({ status: 'proposed', decidedBy: null, decidedAt: null, scope: { area: null, files: [] }, about: 'retry timeout' });
    expect(edited.statement).not.toContain(SECRET);
    // The snapshot taken before the edit no longer matches: nothing is written.
    const err = await s.decideClaim(c.id, { status: 'rejected' }, { by: 'loop:1', expect: before }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err).toMatchObject({ targetId: c.id, expected: before, actual: claimFingerprint(edited) });
    expect((await s.claim(c.id))!.status).toBe('proposed');
    const accepted = (await s.decideClaim(c.id, { status: 'accepted', factId: 'fact:x' }, { by: 'you', expect: claimFingerprint(edited) }))!;
    expect(accepted).toMatchObject({ status: 'accepted', decidedBy: 'you', factId: 'fact:x', decidedAt: expect.any(String) });
    expect(await s.decideClaim('claim:none', { status: 'accepted' }, { by: 'you' })).toBeNull();
    expect(await s.claim('claim:none')).toBeNull();
  });

  test('listClaims filters by status, type, project (with global ones), speaker and run, newest first, paged', async () => {
    const ana = (await s.resolveAlias('Ana', { create: true }))!.person;
    const one = await source('one.vtt');
    await s.saveWindow(one.docId, { window: 0, version: one.version, claims: [draft('a', { speakerId: ana.id }), draft('b', { type: 'opinion' })], questions: [] });
    const other = await source('two.vtt', { projectKey: 'web' });
    await s.saveWindow(other.docId, { window: 0, version: other.version, claims: [draft('c')], questions: [] });
    expect(await s.listClaims()).toHaveLength(3);
    expect((await s.listClaims({ projectKeys: ['web'] })).map((c) => c.statement)).toEqual(['c']);
    expect((await s.listClaims({ type: ['opinion'] })).map((c) => c.statement)).toEqual(['b']);
    expect((await s.listClaims({ speakerId: ana.id })).map((c) => c.statement)).toEqual(['a']);
    expect((await s.listClaims({ status: ['accepted'] }))).toEqual([]);
    expect((await s.listClaims({ limit: 1 }))).toHaveLength(1);
    expect((await s.listClaims({ limit: 2, offset: 2 }))).toHaveLength(1);
    // A sandbox run's source's claims are listed only to that run.
    const sbx = await source('sbx.vtt', { run: { id: 'sbx-1', sandbox: true } });
    await s.saveWindow(sbx.docId, { window: 0, version: sbx.version, claims: [draft('sandboxed')], questions: [] });
    expect((await s.listClaims({ docId: sbx.docId }))).toEqual([]);
    expect((await s.listClaims({ docId: sbx.docId, run: 'sbx-1' }))).toEqual([expect.objectContaining({ statement: 'sandboxed', run: 'sbx-1', sandbox: true })]);
  });

  test('searchClaims finds accepted claims nearest first, within the projects asked for', async () => {
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('near', { embedding: mix(1, 2, 0.9) }), draft('far', { embedding: mix(1, 2, 0.2) }), draft('proposed only', { embedding: vec(1) })], questions: [] });
    const claims = await s.listClaims({ docId });
    for (const c of claims.filter((x) => x.statement !== 'proposed only')) await s.decideClaim(c.id, { status: 'accepted' }, { by: 'you' });
    const hits = await s.searchClaims({ embedding: vec(1), k: 5 });
    expect(hits.map((x) => x.claim.statement)).toEqual(['near', 'far']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect((await s.searchClaims({ embedding: vec(1), k: 5, status: ['proposed'] })).map((x) => x.claim.statement)).toEqual(['proposed only']);
    expect(await s.searchClaims({ embedding: vec(1), k: 5, projectKeys: ['web'] })).toEqual([]);
    expect((await s.searchClaims({ embedding: vec(1), k: 1 })).map((x) => x.claim.statement)).toEqual(['near']);
  });

  test('people: aliases normalised, one person per new name even when resolved at once, the owner made once', async () => {
    const owner = await s.ensureOwner('Robin Vale');
    expect(owner).toMatchObject({ isOwner: true, status: 'confirmed', displayName: 'Robin Vale', aliases: ['robin vale'], claims: 0 });
    expect((await Promise.all([s.ensureOwner('Someone Else'), s.ensureOwner('Robin Vale')])).map((p) => p.id)).toEqual([owner.id, owner.id]);
    expect(aliasNorm('Lima, Ána')).toBe('ana lima');
    expect(await s.resolveAlias('Ana Lima')).toBeNull();
    const made = await Promise.all(['Ana Lima', 'ana  lima', 'Lima, Ána'].map((n) => s.resolveAlias(n, { create: true })));
    expect(new Set(made.map((m) => m!.person.id)).size).toBe(1);
    expect(made.filter((m) => m!.created)).toHaveLength(1);
    expect(made[0]!.person).toMatchObject({ status: 'proposed', isOwner: false, aliases: ['ana lima'] });
    expect(await s.resolveAlias('  ,  ', { create: true })).toBeNull();
    const ana = made[0]!.person;
    const bo = (await s.resolveAlias('Bo', { create: true }))!.person;
    expect((await s.updatePerson(ana.id, { displayName: 'Ana L.', status: 'confirmed', addAliases: ['Ana'], removeAliases: ['Lima, Ana'] }))).toMatchObject({ displayName: 'Ana L.', status: 'confirmed', aliases: ['ana'] });
    await expect(s.updatePerson(ana.id, { addAliases: ['bo'] })).rejects.toBeInstanceOf(AliasTakenError);
    expect((await s.person(ana.id))!.aliases).toEqual(['ana']);
    expect(await s.updatePerson('person:none', { displayName: 'x' })).toBeNull();
    expect((await s.people()).map((p) => p.displayName)).toEqual(['Robin Vale', 'Ana L.', 'Bo']);
    expect((await s.people({ status: ['proposed'] })).map((p) => p.id)).toEqual([bo.id]);
  });

  test('merging people moves aliases, claims, questions and attendance to the one kept; the owner is never merged away', async () => {
    const owner = await s.ensureOwner('Robin Vale');
    const ana = (await s.resolveAlias('Ana', { create: true }))!.person;
    const dup = (await s.resolveAlias('Ana Lima', { create: true }))!.person;
    const { docId, version } = await source('sync.vtt', { participants: [dup.id] });
    await s.saveWindow(docId, { window: 0, version, claims: [draft('Use Redis', { speakerId: dup.id })], questions: [ask('Which cache?', { askedBy: dup.id })] });
    const [q] = await s.listQuestions({ docId });
    await s.updateQuestion(q.id, { assignee: dup.id, status: 'assigned' }, 'you');
    await expect(s.mergePeople(ana.id, ana.id)).rejects.toThrow();
    await expect(s.mergePeople(ana.id, owner.id)).rejects.toThrow(/owner/);
    const kept = (await s.mergePeople(ana.id, dup.id))!;
    expect(kept).toMatchObject({ id: ana.id, aliases: ['ana', 'ana lima'], claims: 1 });
    expect(await s.person(dup.id)).toBeNull();
    expect((await s.listClaims({ docId }))[0].speakerId).toBe(ana.id);
    expect(await s.question(q.id)).toMatchObject({ askedBy: ana.id, assignee: ana.id });
    expect((await s.metas([docId]))[0].participants).toEqual([ana.id]);
    expect((await s.resolveAlias('Ana Lima'))!.person.id).toBe(ana.id);
    expect(await s.mergePeople(ana.id, 'person:none')).toBeNull();
  });

  test('forgetting a person removes their name, aliases and undecided claims; accepted ones stay theirs', async () => {
    const owner = await s.ensureOwner('Robin Vale');
    const bo = (await s.resolveAlias('Bo Park', { create: true }))!.person;
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('Use Redis', { speakerId: bo.id }), draft('Use Postgres', { speakerId: bo.id }), draft('No cache', { speakerId: bo.id })], questions: [] });
    const claims = await s.listClaims({ docId });
    const accepted = claims.find((c) => c.statement === 'Use Postgres')!;
    await s.decideClaim(accepted.id, { status: 'accepted' }, { by: 'you' });
    await s.decideClaim(claims.find((c) => c.statement === 'No cache')!.id, { status: 'rejected' }, { by: 'you' });
    await expect(s.forgetPerson(owner.id)).rejects.toThrow(/owner/);
    const out = (await s.forgetPerson(bo.id))!;
    expect(out.claimsRemoved).toBe(2);
    expect(out.person).toMatchObject({ displayName: FORGOTTEN_NAME, status: 'forgotten', aliases: [], claims: 1 });
    expect((await s.listClaims({ docId })).map((c) => [c.id, c.speakerId])).toEqual([[accepted.id, bo.id]]);
    expect(await s.resolveAlias('Bo Park')).toBeNull();
    expect(await s.forgetPerson('person:none')).toBeNull();
  });

  test('questions: updated, answered with an accepted claim (again replaces it), added once per source and text', async () => {
    const owner = await s.ensureOwner('Robin Vale');
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [], questions: [ask('Who owns retries?', { kind: 'needs_owner', quote: 'someone should' })] });
    const [q] = await s.listQuestions({ status: ['open'] });
    expect(q).toMatchObject({ docId, projectKey: 'shop', kind: 'needs_owner', quote: 'someone should', status: 'open', window: 0 });
    expect(await s.updateQuestion(q.id, { status: 'dismissed' }, 'you')).toMatchObject({ status: 'dismissed', decidedBy: 'you' });
    expect(await s.updateQuestion('question:none', { status: 'dismissed' }, 'you')).toBeNull();
    const answer = { statement: 'Ana owns retries', type: 'fact' as const, speakerId: owner.id, scope: { area: 'retries', files: [] }, about: 'retries', embedding: vec(4) };
    const first = (await s.answerQuestion(q.id, answer, 'you'))!;
    expect(first.question).toMatchObject({ status: 'answered', answerClaimId: answerClaimIdOf(q.id), decidedBy: 'you' });
    expect(first.claim).toMatchObject({ id: answerClaimIdOf(q.id), docId: `answer:${q.id}`, status: 'accepted', decidedBy: 'you', speakerId: owner.id, projectKey: 'shop', window: null });
    const again = (await s.answerQuestion(q.id, { ...answer, statement: 'Bo owns retries' }, 'you'))!;
    expect(again.claim).toMatchObject({ id: first.claim.id, statement: 'Bo owns retries', createdAt: first.claim.createdAt });
    expect(await s.answerQuestion('question:none', answer, 'you')).toBeNull();
    const added = await s.addQuestion({ ...ask('Is it 30 or 60 seconds?', { kind: 'contradictory' }), docId, projectKey: 'shop' });
    expect(added.created).toBe(true);
    expect((await s.addQuestion({ ...ask('Is it 30 or 60 seconds?', { kind: 'contradictory' }), docId, projectKey: 'shop' }))).toEqual({ question: added.question, created: false });
    expect((await s.listQuestions({ kind: ['contradictory'] })).map((x) => x.id)).toEqual([added.question.id]);
  });

  test('a conflict is one per pair; conflictsFor finds the open ones naming any record', async () => {
    const { a, b, conflict } = await disputed();
    expect(conflict).toMatchObject({ id: conflictIdOf(side(a), side(b)), status: 'open', kind: 'disagreement', projectKey: 'shop', resolution: null, decisionId: null });
    expect(conflict.a).toEqual(side(a));
    expect(conflict.judge).toMatchObject({ relation: 'contradicts' });
    // Found again, the other way round: the same conflict, unchanged.
    expect(await s.openConflict(conflictInput(side(b), side(a), { kind: 'supersession' }))).toEqual({ conflict, created: false });
    const fact = await ownerFact('Retries wait 60 seconds');
    const withFact = (await s.openConflict(conflictInput(side(a), { kind: 'fact', id: fact.id, fingerprint: factFingerprint({ ...fact, current: true }), assertedAt: fact.createdAt }))).conflict;
    expect((await s.conflictsFor([a.id])).map((c) => c.id).sort()).toEqual([conflict.id, withFact.id].sort());
    expect((await s.conflictsFor([fact.id])).map((c) => c.id)).toEqual([withFact.id]);
    expect(await s.conflictsFor(['claim:none'])).toEqual([]);
    expect(await s.conflictsFor([])).toEqual([]);
    expect((await s.listConflicts({ status: ['open'] }))).toHaveLength(2);
    expect((await s.listConflicts({ projectKeys: ['web'] }))).toEqual([]);
    expect(await s.conflict('conflict:none')).toBeNull();
  });

  test('a dismissed conflict stays suppressed until a side changes', async () => {
    const { a, b, conflict } = await disputed();
    const dismiss: ConflictSnapshotFields = { status: 'dismissed', resolution: { choice: 'none', note: null, reason: 'scope', createdFactId: null }, resolvedBy: 'you', resolvedAt: '2026-11-11T00:00:00.000Z', decisionId: 'dec:1' };
    await s.writeSnapshots([{ kind: 'conflict', id: conflict.id, fields: dismiss, expect: conflictFingerprint(conflict) }]);
    expect(await s.conflictsFor([a.id])).toEqual([]);
    expect((await s.conflictsFor([a.id], { status: ['dismissed'] })).map((c) => c.id)).toEqual([conflict.id]);
    expect((await s.openConflict(conflictInput(side(a), side(b)))).created).toBe(false);
    const edited = (await s.decideClaim(b.id, { statement: 'Retries wait 90 seconds' }, { by: 'you' }))!;
    const again = await s.openConflict(conflictInput(side(a), side(edited)));
    expect(again.created).toBe(true);
    expect(again.conflict).toMatchObject({ id: conflict.id, status: 'open', resolution: null, resolvedBy: null, resolvedAt: null, decisionId: null, createdAt: conflict.createdAt });
    expect(again.conflict.b.fingerprint).toBe(claimFingerprint(edited));
  });

  test('writeSnapshots supersedes the loser in one transaction, refuses everything when one target changed, and rolls back', async () => {
    const { a, b, conflict } = await disputed();
    const loser = (await s.claim(a.id))!;
    const lost: ClaimSnapshotFields = { status: 'superseded', statement: loser.statement, type: loser.type, scope: loser.scope, decidedBy: 'you', decidedAt: '2026-11-11T00:00:00.000Z', factId: null };
    const resolved: ConflictSnapshotFields = { status: 'resolved', resolution: { choice: 'b', note: `checked ${SECRET}`, reason: null, createdFactId: null }, resolvedBy: 'you', resolvedAt: '2026-11-11T00:00:00.000Z', decisionId: 'dec:1' };
    const link = { from: { kind: 'claim' as const, id: a.id }, to: { kind: 'claim' as const, id: b.id }, conflictId: conflict.id };

    // The conflict changed since the snapshot: neither it nor the claim is written, and no link is made.
    await expect(s.writeSnapshots([
      { kind: 'claim', id: a.id, fields: lost, expect: claimFingerprint(loser) },
      { kind: 'conflict', id: conflict.id, fields: resolved, expect: 'f'.repeat(64) },
    ], { supersede: [link] })).rejects.toMatchObject({ name: 'TargetChangedError', targetId: conflict.id, actual: conflictFingerprint(conflict) });
    expect((await s.claim(a.id))!.status).toBe('proposed');
    expect(await s.supersessions([a.id])).toEqual([]);
    await expect(s.writeSnapshots([{ kind: 'claim', id: 'claim:gone', fields: lost, expect: 'x' }])).rejects.toMatchObject({ actual: null });

    await s.writeSnapshots([
      { kind: 'claim', id: a.id, fields: lost, expect: claimFingerprint(loser) },
      { kind: 'conflict', id: conflict.id, fields: resolved, expect: conflictFingerprint(conflict) },
    ], { supersede: [link] });
    const after = (await s.conflict(conflict.id))!;
    expect(after).toMatchObject({ status: 'resolved', resolvedBy: 'you', decisionId: 'dec:1', resolution: { choice: 'b' } });
    expect(after.resolution!.note).not.toContain(SECRET);
    expect(new Date(after.resolvedAt!).toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect((await s.claim(a.id))!).toMatchObject({ status: 'superseded', decidedBy: 'you' });
    expect(await s.supersessions([b.id])).toEqual([link]);
    expect(await s.conflictsFor([a.id])).toEqual([]);

    // The rollback: back as it was, compared with what the decision wrote.
    const nowA = (await s.claim(a.id))!;
    await s.writeSnapshots([
      { kind: 'claim', id: a.id, fields: { ...lost, status: 'proposed', decidedBy: null, decidedAt: null }, expect: claimFingerprint(nowA) },
      { kind: 'conflict', id: conflict.id, fields: { status: 'open', resolution: null, resolvedBy: null, resolvedAt: null, decisionId: null }, expect: conflictFingerprint(after) },
    ], { unsupersede: [link] });
    expect(claimFingerprint((await s.claim(a.id))!)).toBe(claimFingerprint(loser));
    expect(conflictFingerprint((await s.conflict(conflict.id))!)).toBe(conflictFingerprint(conflict));
    expect(await s.supersessions([a.id, b.id])).toEqual([]);
  });

  test('supersessions and claim links reach facts and lessons; links to missing records are skipped', async () => {
    const { a, b, conflict } = await disputed();
    const fact = await ownerFact('Retries wait 60 seconds');
    await h.store.knowledge.upsertLesson({
      id: 'lesson:retry', projectKey: 'shop', title: 'Retry timeout', rule: 'Wait 60 seconds', appliesWhen: 'retrying', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vec(5),
    });
    const lesson = (await h.store.knowledge.listLessons({ ids: ['lesson:retry'] }))[0];
    expect(lessonFingerprint(lesson)).toMatch(/^[0-9a-f]{64}$/);
    await s.writeSnapshots([], { supersede: [
      { from: { kind: 'fact', id: fact.id }, to: { kind: 'claim', id: a.id }, conflictId: conflict.id },
      { from: { kind: 'lesson', id: 'lesson:retry' }, to: { kind: 'claim', id: a.id }, conflictId: conflict.id },
      { from: { kind: 'fact', id: 'fact:none' }, to: { kind: 'claim', id: a.id }, conflictId: conflict.id },
    ] });
    expect((await s.supersessions([a.id])).map((x) => x.from)).toEqual([{ kind: 'fact', id: fact.id }, { kind: 'lesson', id: 'lesson:retry' }].sort((x, y) => x.id.localeCompare(y.id)));
    expect(await s.addLinks([
      { from: b.id, to: { kind: 'lesson', id: 'lesson:retry' }, rel: 'corroborates' },
      { from: a.id, to: { kind: 'claim', id: b.id }, rel: 'refines' },
      { from: a.id, to: { kind: 'fact', id: 'fact:none' }, rel: 'refines' },
    ])).toBe(2);
    expect(await s.addLinks([{ from: a.id, to: { kind: 'claim', id: b.id }, rel: 'refines' }])).toBe(0);
    expect(await s.links([b.id])).toEqual([
      { from: a.id, to: { kind: 'claim', id: b.id }, rel: 'refines' },
      { from: b.id, to: { kind: 'lesson', id: 'lesson:retry' }, rel: 'corroborates' },
    ].sort((x, y) => x.from.localeCompare(y.from)));
  });

  test('removeSource everything: every claim whatever its status, the people only it named, and the claims\' text in Activity', async () => {
    const ana = (await s.resolveAlias('Test Person A', { create: true }))!.person;
    const bo = (await s.resolveAlias('Test Person B', { create: true }))!.person;
    const cy = (await s.resolveAlias('Test Person C', { create: true }))!.person;
    const one = await source('one.vtt', { participants: [ana.id, bo.id, cy.id] });
    const other = await source('other.vtt', { participants: [cy.id] });
    await s.saveWindow(one.docId, { window: 0, version: one.version, claims: [draft('kept', { speakerId: ana.id }), draft('turned down', { speakerId: bo.id }), draft('open')], questions: [] });
    await s.saveWindow(other.docId, { window: 0, version: other.version, claims: [draft('elsewhere', { speakerId: cy.id })], questions: [] });
    const claims = await s.listClaims({ docId: one.docId });
    const kept = claims.find((c) => c.statement === 'kept')!;
    await s.decideClaim(kept.id, { status: 'accepted' }, { by: 'you' });
    await s.decideClaim(claims.find((c) => c.statement === 'turned down')!.id, { status: 'rejected' }, { by: 'you' });
    await h.store.activity.record({ kind: 'claim_decided', actor: 'you', projectKey: 'shop', subject: 'accepted decision claim "kept"', why: 'w', details: {}, targets: [kept.id] });
    expect(await s.removeSource(one.docId, { everything: true })).toEqual({ claim: 3, question: 0, people: 2 });
    expect(await s.listClaims({ docId: one.docId })).toEqual([]);
    expect(await s.person(ana.id)).toBeNull();
    expect(await s.person(bo.id)).toBeNull();
    // Named by another source too: stays.
    expect((await s.person(cy.id))?.displayName).toBe('Test Person C');
    expect(await s.resolveAlias('Test Person A')).toBeNull();
    expect((await h.store.activity.list({ kind: 'claim_decided', limit: 10 })).find((a) => a.targets.includes(kept.id))?.subject).toBe('a claim since removed');
    expect((await s.listClaims({ docId: other.docId })).map((c) => c.statement)).toEqual(['elsewhere']);
  });

  test('deleteClaims removes a claim whatever its status, and the conflicts it is a side of', async () => {
    const { a, b, conflict } = await disputed();
    await s.decideClaim(a.id, { status: 'accepted' }, { by: 'you' });
    expect(await s.deleteClaims([a.id])).toBe(1);
    expect(await s.claim(a.id)).toBeNull();
    expect(await s.conflict(conflict.id)).toBeNull();
    expect(await s.claim(b.id)).not.toBeNull();
    expect(await s.deleteClaims([a.id])).toBe(0);
  });

  test('removeSource drops the undecided claims, the questions and the details; accepted claims stay', async () => {
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('keep'), draft('drop'), draft('rejected')], questions: [ask('q')] });
    const claims = await s.listClaims({ docId });
    await s.decideClaim(claims.find((c) => c.statement === 'keep')!.id, { status: 'accepted' }, { by: 'you' });
    await s.decideClaim(claims.find((c) => c.statement === 'rejected')!.id, { status: 'rejected' }, { by: 'you' });
    expect(await s.removeSource(docId)).toEqual({ claim: 2, question: 1, people: 0 });
    expect((await s.listClaims({ docId })).map((c) => c.statement)).toEqual(['keep']);
    expect(await s.metas([docId])).toEqual([]);
    expect(await s.nextWindow(docId)).toBeNull();
  });

  test('removeRun deletes what a run made but what it keeps; the owner\'s records stay', async () => {
    const tester: RunTag = { id: 'run-1', sandbox: false };
    const theirs = await source('run.vtt', { run: tester });
    await s.saveWindow(theirs.docId, { window: 0, version: theirs.version, claims: [draft('one'), draft('two')], questions: [ask('q')] });
    const mine = await source('mine.vtt');
    await s.saveWindow(mine.docId, { window: 0, version: mine.version, claims: [draft('owner')], questions: [] });
    const [one, two] = (await s.listClaims({ docId: theirs.docId })).sort((x, y) => x.id.localeCompare(y.id));
    const [owner] = await s.listClaims({ docId: mine.docId });
    const { conflict } = await s.openConflict(conflictInput(side(one), side(owner), { run: tester }));
    await s.writeSnapshots([], { supersede: [{ from: { kind: 'claim', id: owner.id }, to: { kind: 'claim', id: two.id }, conflictId: conflict.id }] });
    expect((await s.runItems('run-1')).map((i) => [i.kind, i.id])).toEqual([
      ['claim', one.id], ['claim', two.id], ['conflict', conflict.id], ['question', (await s.listQuestions({ docId: theirs.docId }))[0].id],
    ].sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])));
    expect(await s.removeRun('run-1', [two.id])).toEqual({ claim: 1, question: 1, conflict: 1 });
    expect((await s.listClaims()).map((c) => c.id).sort()).toEqual([owner.id, two.id].sort());
    expect(await s.conflict(conflict.id)).toBeNull();
    expect(await s.supersessions([owner.id])).toEqual([]);
    expect(await s.runItems('nobody')).toEqual([]);
  });

  test('deleting a project removes its claims, questions, sources and the conflicts naming its records; people stay', async () => {
    const ana = (await s.resolveAlias('Ana', { create: true }))!.person;
    const shop = await source('shop.vtt', { participants: [ana.id] });
    await s.saveWindow(shop.docId, { window: 0, version: shop.version, claims: [draft('shop claim', { speakerId: ana.id })], questions: [ask('shop q')] });
    const web = await source('web.vtt', { projectKey: 'web' });
    await s.saveWindow(web.docId, { window: 0, version: web.version, claims: [draft('web claim')], questions: [ask('web q')] });
    const [shopClaim] = await s.listClaims({ docId: shop.docId });
    const [webClaim] = await s.listClaims({ docId: web.docId });
    const fact = await ownerFact('Retries wait 60 seconds');
    // Filed under web, but one side is shop's fact.
    await s.openConflict(conflictInput(side(webClaim), { kind: 'fact', id: fact.id, fingerprint: 'f', assertedAt: null }, { projectKey: 'web' }));
    await s.openConflict(conflictInput(side(shopClaim), side(webClaim)));
    const webOnly = await s.resolveAlias('Web person', { create: true });
    await s.openConflict(conflictInput(side(webClaim), { kind: 'claim', id: 'claim:other', fingerprint: 'f', assertedAt: null }, { projectKey: 'web' }));
    await h.store.portability.deleteProject('shop');
    expect((await s.listClaims()).map((c) => c.id)).toEqual([webClaim.id]);
    expect((await s.listQuestions()).map((q) => q.text)).toEqual(['web q']);
    expect(await s.metas([shop.docId, web.docId])).toHaveLength(1);
    expect((await s.listConflicts()).map((c) => c.b.id)).toEqual(['claim:other']);
    expect((await s.people()).map((p) => p.id).sort()).toEqual([ana.id, webOnly!.person.id].sort());
  });

  test('redactStoredIntake puts stored claims, questions and intake documents under the current secret and contact rules', async () => {
    const { docId, version } = await source();
    await s.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds'), draft('Nothing to hide')], questions: [ask('Who owns it?')] });
    const claim = (await s.listClaims({ docId })).find((x) => x.statement.startsWith('Retries'))!;
    const [question] = await s.listQuestions({ docId });
    // Text stored under older rules: an address the door would now redact.
    await h.probe.seedIntakeText({ claimId: claim.id, questionId: question.id, docId, text: 'Mail ana@example.test about it' });
    await h.store.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'other.md', title: 'ana@example.test', url: null }, [{ text: 'ana@example.test', embedding: vec(9) }]);
    expect(await s.redactStoredIntake()).toEqual({ sources: 1, claims: 1, questions: 1 });
    expect((await s.claim(claim.id))!).toMatchObject({ statement: 'Mail [email] about it', quote: 'Mail [email] about it' });
    expect((await s.question(question.id))!.text).toBe('Mail [email] about it');
    // Another source's documents are not intake's to change.
    expect((await h.store.docs.listDocs('shop', { source: 'upload' }))[0].title).toBe('ana@example.test');
    expect(await s.redactStoredIntake()).toEqual({ sources: 0, claims: 0, questions: 0 });
  });
});
