import { beforeAll, expect, test } from 'vitest';
import { syncBundle, type SentRecord } from '../cloud.ts';
import { factFingerprint } from '../decisions/record.ts';
import type { IntakeStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { ClaimDraft } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const TRANSCRIPT = 'Ana: retries wait 30 seconds, the vendor said so';

const draft = (statement: string, quote: string, speakerId: string, files: string[]): ClaimDraft => ({
  type: 'decision', statement, quote, speakerId, span: { utt: 0, start: 0, end: quote.length }, assertedAt: '2026-11-10T10:00:00.000Z',
  confidence: 0.9, scope: { area: 'retries', files }, about: 'retry timeout', due: null, flags: [], embedding: vec(1),
});

/** What people said (0.9.0 §7): claims' facts stay home unless SYNC_CLAIMS, private sources' always; nothing of the source leaves. */
describeStores('intake export, cloud sync and forgetting', (h) => {
  let s: IntakeStore;
  beforeAll(() => {
    s = h.store.intake;
  });

  /** A source with one claim by `speaker`, accepted into a fact as the API does (origin claim, why "<speaker>, <date> <kind>"). */
  const accepted = async (ref: string, o: { private: boolean; speaker: string; files: string[]; statement: string; quote: string }) => {
    const docId = await h.store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref, title: ref, url: null }, [{ text: TRANSCRIPT, embedding: vec(9) }]);
    await s.upsertMeta({ docId, kind: o.private ? 'transcript' : 'notes', format: 'txt', occurredAt: '2026-11-10', origin: 'weekly sync', private: o.private, participants: [] });
    const person = (await s.resolveAlias(o.speaker, { create: true }))!.person;
    const { version } = (await s.nextWindow(docId))!;
    await s.saveWindow(docId, { window: 0, version, claims: [draft(o.statement, o.quote, person.id, o.files)], questions: [{ text: 'Who owns the vendor contract?', kind: 'needs_owner', quote: o.quote, askedBy: null }] });
    const [claim] = await s.listClaims({ docId });
    await s.decideClaim(claim.id, { status: 'accepted' }, { by: 'you' });
    const fact = await h.store.facts.addOwnerFact('shop', {
      kind: 'decision', statement: o.statement, path: o.files[0] ?? `source:${docId}`, lines: null, confidence: 1,
      why: `${person.displayName}, 2026-11-10 ${o.private ? 'call' : 'notes'}`, embedding: vec(2),
    }, 'you', null, { origin: 'claim' });
    await s.decideClaim(claim.id, { factId: fact.id }, { by: 'you' });
    return { docId, fact, person, claim };
  };
  const setup = async () => {
    await h.store.facts.addOwnerFact('shop', { kind: 'convention', statement: 'Retries use exponential backoff', path: 'src/retry.ts', lines: null, confidence: 1, why: 'you said so', embedding: vec(3) }, 'you');
    const call = await accepted('call.vtt', { private: true, speaker: 'Ana Lima', files: ['src/retry.ts'], statement: 'Retries wait 30 seconds', quote: 'retries wait 30 seconds' });
    const notes = await accepted('Bo Quinn 1-1.md', { private: false, speaker: 'Bo Quinn', files: [], statement: 'We ship on 12 December', quote: 'we ship on 12 December' });
    return { call, notes };
  };

  test('export: claims\' facts say if their source is private and who said them; no source, quote, question or transcript text', async () => {
    const { call, notes } = await setup();
    const b = await h.store.portability.exportData({ projectKey: 'shop' });
    expect(b.facts.find((f) => f.statement === 'Retries wait 30 seconds')?.claim).toEqual({ private: true, speaker: 'Ana Lima' });
    expect(b.facts.find((f) => f.statement === 'We ship on 12 December')?.claim).toEqual({ private: false, speaker: 'Bo Quinn' });
    expect(b.facts.find((f) => f.statement === 'Retries use exponential backoff')).not.toHaveProperty('claim');
    expect(b.docs.map((d) => d.id)).not.toContain(call.docId);
    const text = JSON.stringify(b);
    for (const leak of [TRANSCRIPT, 'retries wait 30 seconds', 'we ship on 12 December', 'Who owns the vendor contract?']) expect(text).not.toContain(leak);
    // Your own file keeps where a fact is filed (its source's id); only sync hashes it.
    expect(b.facts.find((f) => f.statement === 'We ship on 12 December')?.path).toBe(`source:${notes.docId}`);
  });

  test('sync: no claim\'s fact by default; SYNC_CLAIMS sends the non-private ones without the name; SYNC_PEOPLE adds it', async () => {
    const { notes } = await setup();
    const statements = (b: Awaited<ReturnType<typeof syncBundle>>) => b!.facts.map((f) => f.statement).sort();
    const plain = await syncBundle(h.store.portability, 'shop');
    expect(statements(plain)).toEqual(['Retries use exponential backoff']);

    const claims = await syncBundle(h.store.portability, 'shop', undefined, { claims: true });
    expect(statements(claims)).toEqual(['Retries use exponential backoff', 'We ship on 12 December']);
    const shipped = claims!.facts.find((f) => f.statement === 'We ship on 12 December')!;
    expect(shipped.why).toBe('a participant, 2026-11-10 notes');
    // Filed under its source: the doc id names the file ("Bo Quinn 1-1.md"), so it goes as a hash.
    expect(shipped.path).toMatch(/^source:[0-9a-f]{16}$/);
    for (const leak of ['Bo Quinn', 'Ana Lima', notes.docId, TRANSCRIPT, 'Who owns']) expect(JSON.stringify(claims)).not.toContain(leak);

    const people = await syncBundle(h.store.portability, 'shop', undefined, { claims: true, people: true });
    expect(people!.facts.find((f) => f.statement === 'We ship on 12 December')!.why).toBe('Bo Quinn, 2026-11-10 notes');
    expect(JSON.stringify(people)).not.toContain('Ana Lima');
  });

  test('sync: a claim\'s fact superseded, or its source removed, goes out as withdrawn', async () => {
    const { notes } = await setup();
    const first = (await syncBundle(h.store.portability, 'shop', undefined, { claims: true }))!;
    const sent: SentRecord = { fingerprint: 'f', remote: null, lessons: [], misses: [], docs: first.docs.map((d) => d.id), files: [...new Set(first.facts.map((f) => f.path))] };
    const path = first.facts.find((f) => f.statement === 'We ship on 12 December')!.path;

    // Its source deleted (keep facts): with no source left to say it was not private, it stays home from now on.
    await h.store.docs.deleteDoc(notes.docId);
    await s.removeSource(notes.docId);
    const gone = (await syncBundle(h.store.portability, 'shop', sent, { claims: true }))!;
    expect(gone.facts.map((f) => f.statement)).not.toContain('We ship on 12 December');
    expect(gone.withdrawn).toEqual([{ kind: 'file', id: path, projectKey: 'shop' }]);

    // Superseded (closed by a resolution): no longer current, so taken back too.
    const other = await accepted('later.md', { private: false, speaker: 'Bo Quinn', files: ['src/ship.ts'], statement: 'We ship in January', quote: 'we ship in January' });
    const again = (await syncBundle(h.store.portability, 'shop', undefined, { claims: true }))!;
    expect(again.facts.map((f) => f.path)).toContain('src/ship.ts');
    const now = (await h.store.facts.fact(other.fact.id))!;
    await h.store.facts.writeFactSnapshots([{ id: now.id, expect: factFingerprint(now), fields: { relevance: null, relevanceBy: null, current: false } }]);
    const after = (await syncBundle(h.store.portability, 'shop', { ...sent, files: [...new Set(again.facts.map((f) => f.path))] }, { claims: true }))!;
    expect(after.withdrawn).toContainEqual({ kind: 'file', id: 'src/ship.ts', projectKey: 'shop' });
  });

  test('an answer\'s fact is as private as the source its question came from', async () => {
    const { call } = await setup();
    const owner = await s.ensureOwner('Robin Vale');
    const [q] = await s.listQuestions({ docId: call.docId });
    const { claim } = (await s.answerQuestion(q.id, { statement: 'Ana owns the vendor contract', type: 'fact', speakerId: owner.id, scope: { area: null, files: [] }, about: 'vendor', embedding: vec(4) }, 'you'))!;
    const fact = await h.store.facts.addOwnerFact('shop', { kind: 'decision', statement: claim.statement, path: 'src/vendor.ts', lines: null, confidence: 1, why: 'Robin Vale, answering a question', embedding: vec(5) }, 'you', null, { origin: 'claim' });
    await s.decideClaim(claim.id, { factId: fact.id }, { by: 'you' });
    const b = await h.store.portability.exportData({ projectKey: 'shop' });
    expect(b.facts.find((f) => f.statement === 'Ana owns the vendor contract')?.claim).toEqual({ private: true, speaker: 'Robin Vale' });
    expect((await syncBundle(h.store.portability, 'shop', undefined, { claims: true }))!.facts.map((f) => f.statement)).not.toContain('Ana owns the vendor contract');
  });

  test('forgetting a person takes their name out of the facts their claims became and the Activity about them', async () => {
    const { call } = await setup();
    await h.store.activity.record({ kind: 'person_changed', actor: 'you', projectKey: null, subject: 'changed person "Ana Lima"', why: 'w', details: { aliases: ['Ana L.'] }, targets: [call.person.id] });
    await h.store.activity.record({ kind: 'person_changed', actor: 'you', projectKey: null, subject: 'changed person "Bo Quinn"', why: 'w', details: { aliases: ['Bo'] }, targets: ['person:other'] });
    expect(await s.forgetPerson(call.person.id)).toMatchObject({ person: { displayName: 'former participant' } });
    expect((await h.store.facts.fact(call.fact.id))!.why).toBe('former participant, 2026-11-10 call');
    const entries = await h.store.activity.list({ kind: 'person_changed', limit: 10 });
    expect(entries.find((a) => a.targets.includes(call.person.id))).toMatchObject({ subject: 'changed person "former participant"', details: {} });
    expect(entries.find((a) => a.targets.includes('person:other'))).toMatchObject({ subject: 'changed person "Bo Quinn"', details: { aliases: ['Bo'] } });
    expect(JSON.stringify(await h.store.portability.exportData({ projectKey: 'shop' }))).not.toContain('Ana Lima');
  });

  test('re-embedding takes a claim\'s fact from its statement alone, as accepting it did; a scanned fact keeps its path first', async () => {
    await setup();
    const seen: string[] = [];
    await h.store.embeddings.reembed('another-model', async (texts) => { seen.push(...texts); return texts.map(() => vec(7)); });
    expect(seen).toEqual(expect.arrayContaining(['Retries wait 30 seconds', 'We ship on 12 December', 'src/retry.ts: Retries use exponential backoff']));
  });
});
