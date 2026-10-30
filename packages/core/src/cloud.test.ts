import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { bundleCounts, CloudSyncError, nextSyncDelayMs, PREVIEW_CONCURRENCY, previewCloudSync, pushBundle, runCloudSync, storedSyncMemory, syncBundle, syncMemoryCursor, syncProjects, type SyncResponse } from './cloud.ts';
import type { CloudConfig } from './config.ts';
import { EXPORT_FORMAT, type ExportBundle } from './graph/portability.ts';
import type { ActivityInput } from './types.ts';

const TOKEN = `fgc_pat_0123456789abcdef_${'A'.repeat(43)}`;
const cloud: CloudConfig = { url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: 60, projects: [], suggestions: false, machine: null };

const TRANSCRIPT = 'no, you broke checkout again, read the README first';
const SOURCE = 'export function charge(card) { return stripe.charge(card) }';

function bundle(key = 'shop', o: Partial<ExportBundle> = {}): ExportBundle {
  return {
    format: EXPORT_FORMAT, schemaVersion: 1, toolVersion: '0.2.0', exportedAt: '2026-10-23T10:00:00.000Z', projectKey: key,
    projects: [{ key, remote: 'github.com/acme/shop' }],
    lessons: [
      { id: 'lesson:1', projectKey: key, title: 'Run the checkout tests', rule: 'Run pnpm test:checkout before done', appliesWhen: 'touching checkout', scope: 'project', paths: ['src/checkout.ts'], status: 'approved', source: 'postmortem', cause: 'verification_gap', missId: 'miss:1', createdAt: '2026-10-01T00:00:00Z', decidedAt: '2026-10-02T00:00:00Z' },
      { id: 'lesson:2', projectKey: key, title: 'Proposed', rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: '2026-10-01T00:00:00Z', decidedAt: null },
    ],
    misses: [{
      id: 'miss:1', projectKey: key, missed: 'checkout tests were not run', cause: 'verification_gap', causeExplanation: 'the agent stopped early',
      feedbackText: TRANSCRIPT, ts: '2026-10-01T00:00:00Z',
      contextItems: [{ kind: 'file', ref: 'src/checkout.ts', excerpt: SOURCE, why: 'the charge path lives here' }],
    }],
    facts: [{ path: 'src/checkout.ts', lines: '1-20', kind: 'convention', statement: `uses the key ${TOKEN}`, why: 'seen in code', confidence: 0.9, source: 'scan', createdAt: '2026-10-01T00:00:00Z', projectKey: key }],
    docs: [{ id: `doc:${key}:upload:a.md`, projectKey: key, source: 'upload', ref: 'a.md', title: 'Architecture', url: null }],
    codeFiles: [{ projectKey: key, path: 'src/checkout.ts', lang: 'ts', loc: 120, isTest: false, churn: 4, misses: 1, dependents: 3, score: 9 }],
    ...o,
  };
}

const store = (bundles: Record<string, ExportBundle>) => ({
  exportData: vi.fn(async (o?: { projectKey?: string; approvedOnly?: boolean }) => {
    const b = bundles[o?.projectKey ?? ''];
    // What the real store returns for a key it does not know: an empty bundle.
    return b ?? bundle(o?.projectKey ?? '', { projects: [], lessons: [], misses: [], facts: [], docs: [], codeFiles: [] });
  }),
});

const ok: SyncResponse = {
  syncId: 'sync_1', org: 'acme', projects: [{ localKey: 'shop', key: 'github.com/acme/shop', remote: 'github.com/acme/shop', namespace: 'team' }],
  lessons: { team: 1, suggested: 0, skipped: 0, pendingRevisions: 0 }, withdrawn: { lessons: 0, misses: 0, docs: 0, files: 0 },
  misses: 1, facts: { files: 1, unchanged: 0 }, docs: 1,
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/api/v1/sync-policy')) return new Response(null, { status: 404 });
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? Response.json(ok);
    if (r instanceof Error) throw r;
    return r;
  });
  return { f: f as unknown as typeof fetch, calls };
}
const noSleep = vi.fn(async (_ms: number) => {});

test('the bundle carries knowledge and metadata only: no transcript text, no source, no vectors, no secrets', async () => {
  const b = await syncBundle(store({ shop: bundle() }), 'shop');
  expect(b).not.toBeNull();
  const json = JSON.stringify(b);
  expect(json).not.toContain(TRANSCRIPT);
  expect(json).not.toContain(SOURCE);
  expect(json).not.toContain('A'.repeat(43));
  expect(json).not.toMatch(/embedding|vector/i);
  // No long number arrays anywhere (an embedding would be one).
  const arrays: unknown[][] = [];
  JSON.parse(json, (_k, v) => (Array.isArray(v) && arrays.push(v), v));
  expect(arrays.every((a) => !a.length || typeof a[0] !== 'number')).toBe(true);
  // By default only what you approved leaves: the proposed lesson stays home.
  expect(b!.lessons.map((l) => [l.id, l.status])).toEqual([['lesson:1', 'approved']]);
  expect(b!.complete).toBe(true);
  expect(b!.withdrawn).toEqual([]);
  expect(b!.misses[0]).toMatchObject({ id: 'miss:1', missed: 'checkout tests were not run', feedbackText: '' });
  expect(b!.misses[0].contextItems).toEqual([{ kind: 'file', ref: 'src/checkout.ts', excerpt: '', why: 'the charge path lives here' }]);
  expect(b!.docs).toEqual([{ id: 'doc:shop:upload:a.md', projectKey: 'shop', source: 'upload', ref: 'a.md', title: 'Architecture', url: null }]);
  expect(b!.codeFiles[0]).toEqual({ projectKey: 'shop', path: 'src/checkout.ts', lang: 'ts', loc: 120, isTest: false, churn: 4, misses: 1, dependents: 3, score: 9 });
  expect(b!.projects).toEqual([{ key: 'shop', remote: 'github.com/acme/shop' }]);
  expect(b!.format).toBe(EXPORT_FORMAT);
});

test('nothing you have not approved leaves by default: proposed, rejected and superseded lessons never sent before stay home', async () => {
  const lessons = bundle().lessons;
  const mixed = bundle('shop', {
    lessons: [
      ...lessons,
      { ...lessons[1], id: 'lesson:3', status: 'rejected', decidedAt: '2026-10-03T00:00:00Z' },
      { ...lessons[1], id: 'lesson:4', status: 'superseded', decidedAt: '2026-10-03T00:00:00Z' },
    ],
  });
  const b = await syncBundle(store({ shop: mixed }), 'shop');
  expect(b!.lessons.map((l) => l.id)).toEqual(['lesson:1']);
  expect(JSON.stringify(b)).not.toContain('Proposed');
  // complete: true stays right: what was never sent has nothing to withdraw.
  expect(b!.complete).toBe(true);
  expect(b!.withdrawn).toEqual([]);
});

test('SYNC_SUGGESTIONS=true also sends proposed lessons (as suggestions for an admin) and every other status', async () => {
  const b = await syncBundle(store({ shop: bundle() }), 'shop', undefined, { suggestions: true });
  expect(b!.lessons.map((l) => [l.id, l.status])).toEqual([['lesson:1', 'approved'], ['lesson:2', 'proposed']]);
  const sent = fakeFetch([]);
  await runCloudSync({ cloud: { ...cloud, suggestions: true }, portability: store({ shop: bundle() }), projects: async () => ['shop'], trigger: 'manual', fetch: sent.f, sleep: noSleep });
  expect(JSON.parse(sent.calls[0].init.body as string).lessons).toHaveLength(2);
  expect((await previewCloudSync(store({ shop: bundle() }), ['shop'], { suggestions: true })).total.lessons).toBe(2);
});

test('a lesson approved, synced, then moved back to proposed is still sent, with its status, so the team copy is demoted', async () => {
  const bundles = { shop: bundle('shop') };
  const memory = new Map();
  const first = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: first.f, sleep: noSleep, memory });
  expect(sentBody(first.calls[0]).lessons.map((l) => l.id)).toEqual(['lesson:1']);
  bundles.shop = bundle('shop', { lessons: bundle('shop').lessons.map((l) => (l.id === 'lesson:1' ? { ...l, status: 'proposed' as const, decidedAt: null } : l)) });
  const second = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: second.f, sleep: noSleep, memory });
  expect(second.calls).toHaveLength(1);
  const body = sentBody(second.calls[0]);
  // The one the cloud has goes with its new status; the one it never had still stays home.
  expect(body.lessons.map((l) => [l.id, l.status])).toEqual([['lesson:1', 'proposed']]);
  expect(body.withdrawn).toEqual([]);
  expect(body.complete).toBe(true);
  // And it keeps going with its status on later syncs (the cloud still has it).
  const third = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', force: true, fetch: third.f, sleep: noSleep, memory });
  expect(sentBody(third.calls[0]).lessons.map((l) => [l.id, l.status])).toEqual([['lesson:1', 'proposed']]);
});

test('only known fields leave: anything new the store adds stays home until the sync is taught about it', async () => {
  const extra = bundle() as ExportBundle & { turns: string[] };
  extra.turns = [TRANSCRIPT];
  (extra.lessons[0] as unknown as Record<string, unknown>).embedding = [0.1, 0.2];
  (extra.facts[0] as unknown as Record<string, unknown>).snippet = SOURCE;
  const json = JSON.stringify(await syncBundle(store({ shop: extra }), 'shop'));
  expect(json).not.toContain(TRANSCRIPT);
  expect(json).not.toContain(SOURCE);
  expect(json).not.toContain('embedding');
});

test('the export is asked for the whole project, every lesson status; a project with nothing stored sends nothing', async () => {
  const s = store({ shop: bundle() });
  await syncBundle(s, 'shop');
  expect(s.exportData).toHaveBeenCalledWith({ projectKey: 'shop', approvedOnly: false });
  expect(await syncBundle(s, 'unknown')).toBeNull();
});

test('pushBundle posts JSON with the bearer token to /api/v1/sync and returns the result', async () => {
  const { f, calls } = fakeFetch([Response.json(ok)]);
  expect(await pushBundle({ cloud, bundle: bundle(), fetch: f, sleep: noSleep })).toEqual(ok);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://cloud.example.com/api/v1/sync');
  const h = new Headers(calls[0].init.headers);
  expect(h.get('authorization')).toBe(`Bearer ${TOKEN}`);
  expect(h.get('content-type')).toBe('application/json');
  expect(calls[0].init.method).toBe('POST');
  // A redirect could carry the token somewhere else: never follow one.
  expect(calls[0].init.redirect).toBe('error');
  expect(JSON.parse(calls[0].init.body as string).projectKey).toBe('shop');
});

test('pushBundle names this machine in x-fg-machine when CLOUD_MACHINE is set, and sends no such header otherwise', async () => {
  const one = fakeFetch([Response.json(ok)]);
  await pushBundle({ cloud: { ...cloud, machine: 'work-laptop' }, bundle: bundle(), fetch: one.f, sleep: noSleep });
  expect(new Headers(one.calls[0].init.headers).get('x-fg-machine')).toBe('work-laptop');
  const two = fakeFetch([Response.json(ok)]);
  await pushBundle({ cloud, bundle: bundle(), fetch: two.f, sleep: noSleep });
  expect(new Headers(two.calls[0].init.headers).has('x-fg-machine')).toBe(false);
});

test('pushBundle refuses plain http except to this machine, before anything is sent', async () => {
  const { f, calls } = fakeFetch([]);
  await expect(pushBundle({ cloud: { ...cloud, url: 'http://cloud.example.com' }, bundle: bundle(), fetch: f, sleep: noSleep })).rejects.toThrow(/https/);
  await expect(pushBundle({ cloud: { ...cloud, url: 'https://me:pw@cloud.example.com' }, bundle: bundle(), fetch: f, sleep: noSleep })).rejects.toThrow(/user name or password/);
  expect(calls).toHaveLength(0);
  await pushBundle({ cloud: { ...cloud, url: 'http://localhost:8788' }, bundle: bundle(), fetch: f, sleep: noSleep });
  expect(calls[0].url).toBe('http://localhost:8788/api/v1/sync');
});

test('429, 5xx and network errors are retried with growing waits; Retry-After is honoured', async () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const { f, calls } = fakeFetch([
    new Response('busy', { status: 503 }),
    new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    new TypeError('fetch failed'),
    Response.json(ok),
  ]);
  expect(await pushBundle({ cloud, bundle: bundle(), fetch: f, sleep, baseDelayMs: 1000 })).toEqual(ok);
  expect(calls).toHaveLength(4);
  expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 7000, 4000]);
});

test('retries stop after the last attempt and the error says what happened', async () => {
  const { f, calls } = fakeFetch([500, 502, 503, 504].map((s) => new Response('down', { status: s })));
  const err = await pushBundle({ cloud, bundle: bundle(), fetch: f, sleep: noSleep, attempts: 4 }).catch((e) => e);
  expect(err).toBeInstanceOf(CloudSyncError);
  expect(err.status).toBe(504);
  expect(err.message).toMatch(/504/);
  expect(calls).toHaveLength(4);
});

test.each([
  [401, /refused the token/],
  [403, /sync scope/],
  [413, /too large/],
  [422, /lessons\.0\.title: too long/],
  [400, /400/],
])('%i is not retried and is explained', async (status, re) => {
  const { f, calls } = fakeFetch([Response.json({ error: 'lessons.0.title: too long' }, { status })]);
  const err = await pushBundle({ cloud, bundle: bundle(), fetch: f, sleep: noSleep }).catch((e) => e);
  expect(err).toBeInstanceOf(CloudSyncError);
  expect(err.status).toBe(status);
  expect(err.message).toMatch(re);
  expect(calls).toHaveLength(1);
});

test('errors never carry the token, even when the server echoes it', async () => {
  const { f } = fakeFetch([Response.json({ error: `bad token ${TOKEN}` }, { status: 422 })]);
  const err = await pushBundle({ cloud, bundle: bundle(), fetch: f, sleep: noSleep }).catch((e) => e);
  expect(String(err.message)).not.toContain('A'.repeat(43));
  const net = fakeFetch([new TypeError(`connect failed for ${TOKEN}`), new TypeError('x'), new TypeError('x'), new TypeError('x')]);
  const err2 = await pushBundle({ cloud, bundle: bundle(), fetch: net.f, sleep: noSleep }).catch((e) => e);
  expect(String(err2.message)).not.toContain('A'.repeat(43));
});

function activityLog() {
  const rows: ActivityInput[] = [];
  return { rows, record: vi.fn(async (a: ActivityInput) => { rows.push(a); }) };
}

test('a sync sends each project in scope and records one Activity entry: counts, project keys, cloud host, never the token', async () => {
  const activity = activityLog();
  const { f, calls } = fakeFetch([Response.json(ok), Response.json({ ...ok, projects: [{ ...ok.projects[0], localKey: 'api' }] })]);
  const r = await runCloudSync({
    cloud, portability: store({ shop: bundle('shop'), api: bundle('api') }), activity, projects: async () => ['shop', 'api', 'empty'],
    trigger: 'manual', fetch: f, sleep: noSleep,
  });
  expect(calls).toHaveLength(2);
  expect(r.ok).toBe(true);
  expect(r.host).toBe('cloud.example.com');
  expect(r.sent).toEqual({ projects: 2, lessons: 2, misses: 2, facts: 2, docs: 2, codeFiles: 2 });
  expect(r.projects.map((p) => [p.key, p.status])).toEqual([['shop', 'sent'], ['api', 'sent'], ['empty', 'empty']]);
  expect(activity.rows).toHaveLength(1);
  const a = activity.rows[0];
  expect(a.kind).toBe('cloud_synced');
  expect(a.actor).toBe('you');
  expect(a.projectKey).toBeNull();
  expect(a.subject).toMatch(/cloud\.example\.com/);
  expect(a.subject).toMatch(/2 projects/);
  expect(a.why).toMatch(/Sync now/);
  expect(a.details).toMatchObject({ host: 'cloud.example.com', ok: true, projects: ['shop', 'api'], sent: r.sent });
  expect(JSON.stringify(a)).not.toContain('A'.repeat(43));
});

test('401 stops the whole run; a 413 on one project does not stop the next; the failure is recorded', async () => {
  const activity = activityLog();
  const big = fakeFetch([new Response('', { status: 413 }), Response.json(ok)]);
  const r = await runCloudSync({ cloud, portability: store({ big: bundle('big', { codeFiles: [] }), shop: bundle('shop') }), activity, projects: async () => ['big', 'shop'], trigger: 'schedule', fetch: big.f, sleep: noSleep });
  expect(r.ok).toBe(false);
  expect(r.projects.map((p) => p.status)).toEqual(['failed', 'sent']);
  expect(r.error).toMatch(/big.*too large/);
  expect(activity.rows[0].subject).toMatch(/1 of 2 projects failed|failed/);
  expect(activity.rows[0].actor).toBe('sync schedule');

  const denied = fakeFetch([new Response('', { status: 401 })]);
  const r2 = await runCloudSync({ cloud, portability: store({ a: bundle('a'), b: bundle('b') }), activity, projects: async () => ['a', 'b'], trigger: 'schedule', fetch: denied.f, sleep: noSleep });
  expect(denied.calls).toHaveLength(1);
  expect(r2.projects.map((p) => p.status)).toEqual(['failed', 'not sent']);
  expect(r2.error).toMatch(/refused the token/);
  // The run stopped: the schedule backs off as a whole only for this.
  expect(r2.stopped).toBe(true);
  expect(r.stopped).toBe(false);
});

const codeFile = (i: number, score: number) => ({ projectKey: 'shop', path: `src/f${String(i).padStart(4, '0')}.ts`, lang: 'ts', loc: 100, isTest: false, churn: 1, misses: 0, dependents: 1, score });

test('a project too large for the cloud (413) goes again with its code map cut to the hottest files that fit, and says so', async () => {
  const activity = activityLog();
  const codeFiles = Array.from({ length: 400 }, (_, i) => codeFile(i, i % 7 === 0 ? 50 + i : i / 100));
  const full = bundle('shop', { codeFiles });
  const fullBytes = Buffer.byteLength(JSON.stringify(await syncBundle(store({ shop: full }), 'shop')));
  const limit = Math.floor(fullBytes / 2);
  // The cloud says it keeps a cut code map (features: codeFilesPartial); only then is the code map cut.
  const tooBig = Response.json({ error: `bundle larger than ${limit} bytes; sync one project at a time`, features: ['codeFilesPartial'] }, { status: 413 });
  const { f, calls } = fakeFetch([tooBig, Response.json(ok)]);
  const memory = new Map();
  const r = await runCloudSync({ cloud, portability: store({ shop: full }), activity, projects: async () => ['shop'], trigger: 'schedule', fetch: f, sleep: noSleep, memory });
  expect(calls).toHaveLength(2);
  const second = sentBody(calls[1]);
  expect(Buffer.byteLength(calls[1].init.body as string)).toBeLessThanOrEqual(limit);
  // Everything else whole; the code map cut to the highest scores, still in path order.
  expect(second.facts).toEqual(sentBody(calls[0]).facts);
  expect(second.codeFiles!.length).toBeGreaterThan(0);
  expect(second.codeFiles!.length).toBeLessThan(400);
  const kept = new Set(second.codeFiles!.map((c) => c.path));
  const lowestKept = Math.min(...second.codeFiles!.map((c) => c.score));
  expect(codeFiles.filter((c) => !kept.has(c.path)).every((c) => c.score <= lowestKept)).toBe(true);
  expect(second.codeFiles!.map((c) => c.path)).toEqual([...kept].sort());
  // Still complete for everything else; its code map says it is partial, so the cloud keeps the files it left out.
  expect(second).toMatchObject({ complete: true, codeFilesPartial: true });
  expect(sentBody(calls[0])).not.toHaveProperty('codeFilesPartial');
  expect(r.ok).toBe(true);
  expect(r.projects[0]).toMatchObject({ key: 'shop', status: 'sent', trimmed: { codeFiles: { sent: second.codeFiles!.length, of: 400 } } });
  expect(activity.rows[0].subject).toMatch(/code map cut to \d+ of 400 files/);
  // The full bundle is what is remembered: unchanged next time, so it is not cut and resent every run.
  const again = fakeFetch([]);
  expect((await runCloudSync({ cloud, portability: store({ shop: full }), projects: async () => ['shop'], trigger: 'schedule', fetch: again.f, sleep: noSleep, memory })).projects[0].status).toBe('unchanged');
  expect(again.calls).toHaveLength(0);
});

test('a 413 that the code map cannot explain says what to do: raise SYNC_MAX_BYTES or leave the project out', async () => {
  const tooBig = () => Response.json({ error: 'bundle larger than 1000 bytes; sync one project at a time', features: ['codeFilesPartial'] }, { status: 413 });
  // No code map to cut: one request, and the advice fits a bundle that is already one project.
  const plain = fakeFetch([tooBig()]);
  const r = await runCloudSync({ cloud, portability: store({ shop: bundle('shop', { codeFiles: [] }) }), projects: async () => ['shop'], trigger: 'schedule', fetch: plain.f, sleep: noSleep });
  expect(plain.calls).toHaveLength(1);
  expect(r.projects[0].status).toBe('failed');
  expect(r.error).toMatch(/shop.*too large for the cloud \(413\).*SYNC_MAX_BYTES.*1000 bytes.*EXCLUDE_PROJECTS/);
  expect(r.error).not.toMatch(/sync fewer projects|one project at a time/);
  // With a code map that is not enough: it goes once more without any, and then fails with the same advice.
  const both = fakeFetch([tooBig(), tooBig(), tooBig(), tooBig()]);
  const r2 = await runCloudSync({ cloud, portability: store({ shop: bundle('shop') }), projects: async () => ['shop'], trigger: 'schedule', fetch: both.f, sleep: noSleep });
  expect(sentBody(both.calls.at(-1)!).codeFiles).toEqual([]);
  expect(both.calls.length).toBeLessThanOrEqual(4);
  expect(r2.error).toMatch(/even without its code map.*SYNC_MAX_BYTES/);
});

test('a cloud that does not say it keeps a cut code map is never sent one: the project fails with what to do', async () => {
  // An older cloud drops the codeFilesPartial key, takes the cut bundle as complete and withdraws the files left out
  // of the team code map. Without `features: ['codeFilesPartial']` in its 413 the code map is not cut at all.
  const codeFiles = Array.from({ length: 50 }, (_, i) => codeFile(i, i));
  for (const answer of [
    () => Response.json({ error: 'bundle larger than 1000 bytes; raise SYNC_MAX_BYTES on the cloud' }, { status: 413 }),
    () => Response.json({ error: 'bundle larger than 1000 bytes', features: ['somethingElse'] }, { status: 413 }),
    () => new Response('<html>413 Request Entity Too Large</html>', { status: 413 }),
  ]) {
    const memory = new Map();
    const { f, calls } = fakeFetch([answer(), Response.json(ok)]);
    const r = await runCloudSync({ cloud, portability: store({ shop: bundle('shop', { codeFiles }) }), projects: async () => ['shop'], trigger: 'schedule', fetch: f, sleep: noSleep, memory });
    expect(calls).toHaveLength(1);
    expect(sentBody(calls[0]).codeFiles).toHaveLength(50);
    expect(r.projects[0]).toMatchObject({ key: 'shop', status: 'failed' });
    expect(r.projects[0]).not.toHaveProperty('trimmed');
    expect(r.error).toMatch(/shop.*too large for the cloud \(413\)/);
    expect(r.error).toMatch(/does not say it keeps a cut code map.*not cut.*SYNC_MAX_BYTES.*update the cloud.*EXCLUDE_PROJECTS/);
    // Nothing was accepted, so nothing is remembered: the next run tries the whole bundle again.
    expect(memory.size).toBe(0);
  }
});

test('a project the schedule is backing off from waits: it is not exported or sent, and the run is not a failure', async () => {
  const s = store({ big: bundle('big'), shop: bundle('shop') });
  const { f, calls } = fakeFetch([]);
  const r = await runCloudSync({
    cloud, portability: s, projects: async () => ['big', 'shop'], trigger: 'schedule', fetch: f, sleep: noSleep,
    waiting: (key) => (key === 'big' ? '2026-10-25T14:00:00.000Z' : null),
  });
  expect(calls).toHaveLength(1);
  expect(r.ok).toBe(true);
  expect(r.projects).toEqual([{ key: 'big', status: 'waiting', counts: null, until: '2026-10-25T14:00:00.000Z' }, expect.objectContaining({ key: 'shop', status: 'sent' })]);
  expect(s.exportData.mock.calls.map((c) => c[0]?.projectKey)).toEqual(['shop']);
});

test('a sync skips a project whose bundle has not changed since it was last sent; Sync now resends only when forced', async () => {
  const activity = activityLog();
  const memory = new Map();
  const s = store({ shop: bundle('shop') });
  const first = fakeFetch([]);
  await runCloudSync({ cloud, portability: s, activity, projects: async () => ['shop'], trigger: 'schedule', fetch: first.f, sleep: noSleep, memory });
  expect(first.calls).toHaveLength(1);
  const again = fakeFetch([]);
  const r = await runCloudSync({ cloud, portability: s, activity, projects: async () => ['shop'], trigger: 'schedule', fetch: again.f, sleep: noSleep, memory });
  expect(again.calls).toHaveLength(0);
  expect(r.projects[0].status).toBe('unchanged');
  // Nothing went anywhere on the schedule, so nothing is logged.
  expect(activity.rows).toHaveLength(1);
  // Sync now diffs the same way, and says so: someone asked, so the answer is recorded.
  const manual = fakeFetch([]);
  const m = await runCloudSync({ cloud, portability: s, activity, projects: async () => ['shop'], trigger: 'manual', fetch: manual.f, sleep: noSleep, memory });
  expect(manual.calls).toHaveLength(0);
  expect(m.projects[0].status).toBe('unchanged');
  expect(activity.rows).toHaveLength(2);
  expect(activity.rows[1].subject).toBe('nothing to send to cloud.example.com: 1 project unchanged since the last sync');
  // --force resends everything.
  const forced = fakeFetch([]);
  await runCloudSync({ cloud, portability: s, activity, projects: async () => ['shop'], trigger: 'manual', force: true, fetch: forced.f, sleep: noSleep, memory });
  expect(forced.calls).toHaveLength(1);
});

test('a sync reports its progress, one project at a time', async () => {
  const seen: unknown[] = [];
  await runCloudSync({
    cloud, portability: store({ shop: bundle('shop'), blog: bundle('blog') }), projects: async () => ['shop', 'blog'], trigger: 'manual',
    fetch: fakeFetch([]).f, sleep: noSleep, onProgress: (p) => { seen.push(p); },
  });
  expect(seen).toEqual([
    { done: 0, total: 2, current: 'shop' },
    { done: 1, total: 2, current: 'blog' },
    { done: 2, total: 2, current: null },
  ]);
});

test('the preview counts what a sync would send, per project, without sending', async () => {
  const p = await previewCloudSync(store({ shop: bundle('shop') }), ['shop', 'empty']);
  expect(p.total).toEqual({ projects: 1, lessons: 1, misses: 1, facts: 1, docs: 1, codeFiles: 1 });
  expect(p.projects).toEqual([{ key: 'shop', counts: { projects: 1, lessons: 1, misses: 1, facts: 1, docs: 1, codeFiles: 1 } }, { key: 'empty', counts: null, reason: expect.stringContaining('No shareable knowledge') }]);
  expect(bundleCounts(bundle())).toEqual({ projects: 1, lessons: 2, misses: 1, facts: 1, docs: 1, codeFiles: 1 });
});

test('the preview exports a few projects at a time, not one after another, and keeps their order', async () => {
  let running = 0;
  let most = 0;
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const slow = {
    exportData: async (o?: { projectKey?: string }) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return bundle(o?.projectKey ?? '');
    },
  };
  const p = await previewCloudSync(slow, keys);
  expect(p.projects.map((x) => x.key)).toEqual(keys);
  expect(p.total.projects).toBe(6);
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThanOrEqual(PREVIEW_CONCURRENCY);
});

test('after failures the next scheduled sync waits longer, up to a day', () => {
  expect(nextSyncDelayMs(60, 0)).toBe(3_600_000);
  expect(nextSyncDelayMs(60, 1)).toBe(7_200_000);
  expect(nextSyncDelayMs(60, 3)).toBe(28_800_000);
  expect(nextSyncDelayMs(60, 30)).toBe(86_400_000);
  expect(nextSyncDelayMs(5, 2)).toBe(1_200_000);
});

test('the projects synced: the selected ones, narrowed by SYNC_PROJECTS when set; never an excluded one', () => {
  expect(syncProjects({ configured: [], selected: ['a', 'b'], excluded: [] })).toEqual(['a', 'b']);
  expect(syncProjects({ configured: ['b', 'secret'], selected: ['a', 'b', 'secret'], excluded: ['secret'] })).toEqual(['b']);
  expect(syncProjects({ configured: ['c'], selected: ['a'], excluded: [] })).toEqual([]);
  expect(syncProjects({ configured: [], selected: ['a', 'secret'], excluded: ['secret'] })).toEqual(['a']);
});

const sentBody = (c: Call) => JSON.parse(c.init.body as string) as ExportBundle & { complete?: boolean; withdrawn?: { kind: string; id: string; projectKey?: string }[] };

test('the unchanged skip does not depend on row order: the same rows in another order are the same bundle', async () => {
  const fact = (statement: string, kind: string) => ({ ...bundle().facts[0], statement, kind });
  const misses = [bundle().misses[0], { ...bundle().misses[0], id: 'miss:2' }];
  const items = [{ kind: 'file', ref: 'a.ts', excerpt: '', why: 'one' }, { kind: 'file', ref: 'a.ts', excerpt: '', why: 'two' }];
  const facts = [fact('same', 'convention'), fact('same', 'gotcha'), fact('other', 'api')];
  const docs = [bundle().docs[0], { ...bundle().docs[0], id: 'doc:shop:upload:b.md' }];
  const codeFiles = [bundle().codeFiles[0], { ...bundle().codeFiles[0], path: 'src/b.ts' }];
  const bundles = { shop: bundle('shop', { facts, misses: misses.map((m) => ({ ...m, contextItems: items })), docs, codeFiles }) };
  const memory = new Map();
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: fakeFetch([]).f, sleep: noSleep, memory });
  // A store without a snapshot (or ties with no tiebreak) hands back the same rows in another order.
  bundles.shop = bundle('shop', {
    facts: [...facts].reverse(), misses: [...misses].reverse().map((m) => ({ ...m, contextItems: [...items].reverse() })), docs: [...docs].reverse(), codeFiles: [...codeFiles].reverse(),
  });
  const again = fakeFetch([]);
  const r = await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: again.f, sleep: noSleep, memory });
  expect(again.calls).toHaveLength(0);
  expect(r.projects[0].status).toBe('unchanged');
  // A real change still goes.
  bundles.shop = bundle('shop', { facts: [fact('changed', 'api')], misses, docs, codeFiles });
  const changed = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: changed.f, sleep: noSleep, memory });
  expect(changed.calls).toHaveLength(1);
});

test('a lesson approved and then revoked locally is sent with its new status, so the team copy is demoted', async () => {
  const bundles = { shop: bundle('shop') };
  const memory = new Map();
  const first = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: first.f, sleep: noSleep, memory });
  expect(sentBody(first.calls[0]).lessons.find((l) => l.id === 'lesson:1')?.status).toBe('approved');
  bundles.shop = bundle('shop', { lessons: bundle('shop').lessons.map((l) => (l.id === 'lesson:1' ? { ...l, status: 'revoked' as const, checks: [{ name: 'source-pr-unmerged' as const, why: 'source PR closed without merge' }] } : l)) });
  const second = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: second.f, sleep: noSleep, memory });
  expect(second.calls).toHaveLength(1);
  const body = sentBody(second.calls[0]);
  expect(body.lessons.find((l) => l.id === 'lesson:1')?.status).toBe('revoked');
  expect(body.lessons.find((l) => l.id === 'lesson:1')?.checks).toMatchObject([{ name: 'source-pr-unmerged' }]);
  expect(body.complete).toBe(true);
});

test('what was sent before and is gone now is listed in withdrawn: lessons, misses, docs and fact files', async () => {
  const bundles = { shop: bundle('shop') };
  const memory = new Map();
  const first = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: first.f, sleep: noSleep, memory });
  expect(sentBody(first.calls[0]).withdrawn).toEqual([]);
  bundles.shop = bundle('shop', { lessons: bundle('shop').lessons.filter((l) => l.id !== 'lesson:1'), misses: [], docs: [], facts: [] });
  const second = fakeFetch([]);
  const r = await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: second.f, sleep: noSleep, memory });
  expect(sentBody(second.calls[0]).withdrawn).toEqual([
    { kind: 'lesson', id: 'lesson:1' },
    { kind: 'miss', id: 'miss:1' },
    { kind: 'doc', id: 'doc:shop:upload:a.md' },
    { kind: 'file', id: 'src/checkout.ts', projectKey: 'shop' },
  ]);
  expect(r.projects[0].withdrawn).toBe(4);
  // Withdrawn once is enough: the next sync does not list them again.
  const third = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', force: true, fetch: third.f, sleep: noSleep, memory });
  expect(sentBody(third.calls[0]).withdrawn).toEqual([]);
});

test('a failed send keeps what the cloud last had, so the withdrawals go with the next successful one', async () => {
  const bundles = { shop: bundle('shop') };
  const memory = new Map();
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: fakeFetch([]).f, sleep: noSleep, memory });
  bundles.shop = bundle('shop', { docs: [] });
  const failed = fakeFetch([new Response('', { status: 422 })]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: failed.f, sleep: noSleep, memory });
  const next = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: next.f, sleep: noSleep, memory });
  expect(sentBody(next.calls[0]).withdrawn).toEqual([{ kind: 'doc', id: 'doc:shop:upload:a.md' }]);
});

test('a project that was sent and now holds nothing goes as a complete, empty bundle under its remote: a tombstone', async () => {
  const bundles: Record<string, ExportBundle> = { shop: bundle('shop') };
  const memory = new Map();
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: fakeFetch([]).f, sleep: noSleep, memory });
  delete bundles.shop;
  const gone = fakeFetch([]);
  const r = await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: gone.f, sleep: noSleep, memory });
  expect(gone.calls).toHaveLength(1);
  const body = sentBody(gone.calls[0]);
  expect(body).toMatchObject({ projectKey: 'shop', complete: true, projects: [{ key: 'shop', remote: 'github.com/acme/shop' }], lessons: [], misses: [], facts: [], docs: [] });
  expect(body.withdrawn).toHaveLength(4);
  expect(r.projects[0]).toMatchObject({ key: 'shop', status: 'sent', withdrawn: 4 });
  // After that it is simply empty again.
  const after = fakeFetch([]);
  const r2 = await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: after.f, sleep: noSleep, memory });
  expect(after.calls).toHaveLength(0);
  expect(r2.projects[0].status).toBe('empty');
});

test('a 429 is retried only after the Retry-After the cloud asked for (seconds or a date); a longer wait fails the project', async () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const now = Date.parse('2026-10-23T10:00:00Z');
  vi.useFakeTimers({ now, toFake: ['Date'] });
  try {
    const dated = fakeFetch([new Response('', { status: 429, headers: { 'retry-after': new Date(now + 12_000).toUTCString() } }), Response.json(ok)]);
    await pushBundle({ cloud, bundle: bundle(), fetch: dated.f, sleep, baseDelayMs: 1000 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([12_000]);
  } finally {
    vi.useRealTimers();
  }
  const busy = fakeFetch([new Response('', { status: 429, headers: { 'retry-after': '300' } })]);
  const err = await pushBundle({ cloud, bundle: bundle(), fetch: busy.f, sleep: noSleep }).catch((e) => e);
  expect(busy.calls).toHaveLength(1);
  expect(err).toBeInstanceOf(CloudSyncError);
  expect(err.status).toBe(429);
  expect(err.message).toMatch(/another sync of this org is running.*300 s/);
});

/** A DocsStore's cursors, in memory: what storedSyncMemory keeps its record in. */
function cursors() {
  const m = new Map<string, string>();
  // Each call yields first, as a store round trip does, so two services' writes can interleave.
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    m,
    getCursor: async (k: string) => { await tick(); return m.get(k) ?? null; },
    setCursor: async (k: string, v: string) => { await tick(); m.set(k, v); },
    cursorsWithPrefix: async (p: string) => { await tick(); return [...m].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    deleteCursor: async (k: string) => { await tick(); m.delete(k); },
  };
}

test('what the cloud last accepted is kept in the store: a restarted process (or the other service) still withdraws what is gone', async () => {
  const docs = cursors();
  const bundles = { shop: bundle('shop') };
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: fakeFetch([]).f, sleep: noSleep, memory: storedSyncMemory(docs, cloud) });
  // One record per project, keyed without the token in it.
  expect([...docs.m.keys()].filter(key => key.startsWith(`${syncMemoryCursor(cloud)}/`))).toEqual([`${syncMemoryCursor(cloud)}/shop`]);
  expect([...docs.m.keys(), ...docs.m.values()].join(' ')).not.toContain(TOKEN);
  bundles.shop = bundle('shop', { docs: [] });
  // A new process: a fresh memory over the same store.
  const next = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: next.f, sleep: noSleep, memory: storedSyncMemory(docs, cloud) });
  expect(sentBody(next.calls[0]).withdrawn).toEqual([{ kind: 'doc', id: 'doc:shop:upload:a.md' }]);
});

test('the stored record belongs to one cloud org: another URL or token starts empty, so it is sent nothing it never had', async () => {
  const docs = cursors();
  const bundles = { shop: bundle('shop') };
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: fakeFetch([]).f, sleep: noSleep, memory: storedSyncMemory(docs, cloud) });
  const other = { ...cloud, token: `fgc_pat_fedcba9876543210_${'B'.repeat(43)}` };
  bundles.shop = bundle('shop', { lessons: [{ ...bundle('shop').lessons[0], status: 'rejected' }], docs: [] });
  const sent = fakeFetch([]);
  await runCloudSync({ cloud: other, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: sent.f, sleep: noSleep, memory: storedSyncMemory(docs, other) });
  const body = sentBody(sent.calls[0]);
  expect(body.withdrawn).toEqual([]);
  expect(body.lessons).toEqual([]); // the rejected lesson was never this org's, so its status stays home
});

test('each write changes only its own project, so two services syncing at once do not undo each other', async () => {
  const docs = cursors();
  const a = storedSyncMemory(docs, cloud);
  const b = storedSyncMemory(docs, cloud);
  const rec = (fingerprint: string) => ({ fingerprint, remote: null, lessons: [], misses: [], docs: [], files: [] });
  await a.set('one', rec('1'));
  await b.set('two', rec('2'));
  await a.delete('one');
  expect([...(await b.keys())]).toEqual(['two']);
  expect(await a.get('two')).toEqual(rec('2'));
  // A damaged record reads as none, never as an error that stops sync.
  docs.m.set(`${syncMemoryCursor(cloud)}/two`, 'not json');
  expect([...(await a.keys())]).toEqual([]);
  expect(await a.get('two')).toBeUndefined();
});

test('two services writing at once (Sync now and the schedule) never lose each other\'s record: each project is its own write', async () => {
  const docs = cursors();
  const api = storedSyncMemory(docs, cloud);
  const worker = storedSyncMemory(docs, cloud);
  const rec = (fingerprint: string) => ({ fingerprint, remote: null, lessons: [], misses: [], docs: [], files: [] });
  await Promise.all([api.set('one', rec('1')), worker.set('two', rec('2')), api.set('three', rec('3'))]);
  expect([...(await api.keys())].sort()).toEqual(['one', 'three', 'two']);
  await Promise.all([api.delete('one'), worker.set('four', rec('4'))]);
  expect([...(await worker.keys())].sort()).toEqual(['four', 'three', 'two']);
  expect(await worker.get('three')).toEqual(rec('3'));
});

test('a record kept the old way (one cursor for every project) is moved to one per project, and nothing in it is lost', async () => {
  const docs = cursors();
  const rec = (fingerprint: string) => ({ fingerprint, remote: null, lessons: ['lesson:1'], misses: [], docs: [], files: [] });
  docs.m.set(syncMemoryCursor(cloud), JSON.stringify({ shop: rec('s'), blog: rec('b') }));
  const memory = storedSyncMemory(docs, cloud);
  expect([...(await memory.keys())].sort()).toEqual(['blog', 'shop']);
  expect(await memory.get('shop')).toEqual(rec('s'));
  // The old record is gone once moved; a newer per-project record is never overwritten by it.
  expect(docs.m.has(syncMemoryCursor(cloud))).toBe(false);
  docs.m.set(syncMemoryCursor(cloud), JSON.stringify({ shop: rec('old') }));
  const next = storedSyncMemory(docs, cloud);
  expect(await next.get('shop')).toEqual(rec('s'));
});

test('a project synced before and no longer in the list gets one last, empty bundle that withdraws what was sent, then is forgotten', async () => {
  const docs = cursors();
  const memory = storedSyncMemory(docs, cloud);
  const bundles = { shop: bundle('shop'), blog: bundle('blog', { projects: [{ key: 'blog', remote: 'github.com/acme/blog' }] }) };
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop', 'blog'], trigger: 'schedule', fetch: fakeFetch([]).f, sleep: noSleep, memory });
  const activity: ActivityInput[] = [];
  // blog is unselected (or excluded, or left out of SYNC_PROJECTS); it still holds its data locally.
  const run = fakeFetch([]);
  const r = await runCloudSync({ cloud, portability: store(bundles), activity: { record: async (a) => { activity.push(a); } }, projects: async () => ['shop'], trigger: 'schedule', fetch: run.f, sleep: noSleep, memory });
  expect(run.calls).toHaveLength(1); // shop is unchanged; only blog's withdrawal goes
  const body = sentBody(run.calls[0]);
  expect(body).toMatchObject({ projectKey: 'blog', complete: true, projects: [{ key: 'blog', remote: 'github.com/acme/blog' }], lessons: [], misses: [], facts: [], docs: [], codeFiles: [] });
  expect((body.withdrawn ?? []).map((w: { kind: string }) => w.kind).sort()).toEqual(['doc', 'file', 'lesson', 'miss']);
  for (const never of ['Run the checkout tests', TRANSCRIPT, SOURCE, 'Architecture']) expect(JSON.stringify(body)).not.toContain(never);
  expect(r.projects.map((p) => [p.key, p.status])).toEqual([['shop', 'unchanged'], ['blog', 'withdrawn']]);
  expect(r.ok).toBe(true);
  expect(activity).toHaveLength(1);
  expect(activity[0].subject).toContain('took blog back out');
  expect(activity[0].details).toMatchObject({ withdrawnProjects: ['blog'] });
  expect([...(await memory.keys())]).toEqual(['shop']);
  // Once only.
  const again = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule', fetch: again.f, sleep: noSleep, memory });
  expect(again.calls).toHaveLength(0);
});

test('a withdrawal that fails is kept and tried again on the next sync', async () => {
  const memory = new Map();
  const bundles = { shop: bundle('shop') };
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: fakeFetch([]).f, sleep: noSleep, memory });
  const failed = await runCloudSync({ cloud, portability: store(bundles), projects: async () => [], trigger: 'manual', fetch: fakeFetch([new Response('', { status: 422 })]).f, sleep: noSleep, memory });
  expect(failed.ok).toBe(false);
  expect(failed.projects[0]).toMatchObject({ key: 'shop', status: 'failed', error: expect.stringContaining('withdrawing it') });
  expect([...memory.keys()]).toEqual(['shop']);
  const retry = fakeFetch([]);
  const r = await runCloudSync({ cloud, portability: store(bundles), projects: async () => [], trigger: 'manual', fetch: retry.f, sleep: noSleep, memory });
  expect(r.projects[0]).toMatchObject({ key: 'shop', status: 'withdrawn' });
  expect([...memory.keys()]).toEqual([]);
});

test('no-miss approved lessons never sync and a previously shared copy is withdrawn without revoking local approval', async () => {
  const data = bundle();
  const bundles = { shop: data };
  const memory = new Map();
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: fakeFetch([]).f, sleep: noSleep, memory });
  data.lessons[0].checks = [{ name: 'no-miss', why: 'false claim; approval requires review' }];
  const fresh = await syncBundle(store(bundles), 'shop', undefined, { suggestions: true });
  expect(fresh?.lessons.map((l) => l.id)).not.toContain('lesson:1');
  const second = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: second.f, sleep: noSleep, memory });
  expect(sentBody(second.calls[0]).withdrawn).toContainEqual({ kind: 'lesson', id: 'lesson:1' });
  expect(sentBody(second.calls[0]).lessons.map((l) => l.id)).not.toContain('lesson:1');
  expect(data.lessons[0].status).toBe('approved');
});

test('cloud allowlist still omits review details of safe lessons', async () => {
  const data = bundle();
  data.lessons[0].checks = [{ name: 'needs-path', why: 'local review note' }];
  const result = await syncBundle(store({ shop: data }), 'shop');
  expect(result?.lessons[0].id).toBe('lesson:1');
  expect(result?.lessons[0]).not.toHaveProperty('checks');
});


test('a cloud policy change resends unchanged projects without force', async () => {
  const memory = new Map();
  const { f, calls } = fakeFetch([]);
  let revision = 'a'.repeat(64);
  const fetcher: typeof fetch = async (url, init) => String(url).endsWith('/sync-policy') ? Response.json({ revision }) : f(url, init);
  const deps = { cloud, portability: store({ shop: bundle() }), projects: async () => ['shop'], trigger: 'schedule' as const, memory, fetch: fetcher, sleep: noSleep };
  await runCloudSync(deps);
  expect((await runCloudSync(deps)).projects[0].status).toBe('unchanged');
  revision = 'b'.repeat(64);
  expect((await runCloudSync(deps)).projects[0].status).toBe('sent');
  expect(calls).toHaveLength(2);
});

test('local-only project data never exports even under forced manual cloud sync', async () => {
  const portability = store({ sandbox: bundle('sandbox') });
  const { f, calls } = fakeFetch([]);
  await runCloudSync({ cloud: { ...cloud, localOnlyProjects: ['sandbox'] }, portability, projects: async () => ['sandbox'], trigger: 'manual', force: true, fetch: f });
  expect(portability.exportData).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});


test('metadata-only and entirely unshared proposed content do not create cloud project rows', async () => {
  const empty = bundle('sandbox', { lessons: [], misses: [], facts: [], docs: [], codeFiles: [] });
  const proposed = { ...empty, lessons: [{ ...bundle('sandbox').lessons[1] }] };
  for (const exported of [empty, proposed]) {
    const { f, calls } = fakeFetch([]);
    const result = await runCloudSync({ cloud, portability: store({ sandbox: exported }), projects: async () => ['sandbox'], trigger: 'manual', force: true, fetch: f });
    expect(result.projects).toMatchObject([{ key: 'sandbox', status: 'empty' }]);
    expect(calls).toEqual([]);
  }
});

test('a genuine code-map-only export is sent and clearing it sends a single complete tombstone', async () => {
  const onlyMap = bundle('shop', { lessons: [], misses: [], facts: [], docs: [] });
  const bundles = { shop: onlyMap };
  const memory = new Map();
  const first = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: first.f, memory });
  expect(sentBody(first.calls[0]).codeFiles).toHaveLength(1);
  bundles.shop = { ...onlyMap, codeFiles: [] };
  const cleared = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: cleared.f, memory });
  expect(sentBody(cleared.calls[0])).toMatchObject({ complete: true, codeFiles: [], projects: [{ key: 'shop', remote: 'github.com/acme/shop' }] });
  expect(memory.has('shop')).toBe(false);
  const again = fakeFetch([]);
  await runCloudSync({ cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'manual', fetch: again.f, memory });
  expect(again.calls).toEqual([]);
});


test('a seed-created demo stays local after scans until explicit owner opt-in; ordinary maps stay shareable', async () => {
  const onlyMap = bundle('demo-shop', { lessons: [], misses: [], facts: [], docs: [], projects: [{ key: 'demo-shop', remote: 'github.com/acme/demo-shop', demoCreated: true }] });
  expect(await syncBundle(store({ 'demo-shop': onlyMap }), 'demo-shop')).toBeNull();
  const existingOrdinary = { ...onlyMap, projects: [{ key: 'demo-shop', remote: 'github.com/acme/demo-shop' }] };
  expect(await syncBundle(store({ 'demo-shop': existingOrdinary }), 'demo-shop')).toBeNull();
  expect(existingOrdinary.projects[0]).not.toHaveProperty('demoCreated');
  expect((await syncBundle(store({ 'demo-shop': existingOrdinary }), 'demo-shop', undefined, { shareDemoCreated: true }))?.codeFiles).toHaveLength(1);
  const bystander = { ...existingOrdinary, projectKey: 'real-shop', projects: [{ key: 'real-shop', remote: 'github.com/acme/demo-shop' }] };
  expect((await syncBundle(store({ 'real-shop': bystander }), 'real-shop'))?.codeFiles).toHaveLength(1);
  const withRealKnowledge = { ...onlyMap, facts: bundle('demo-shop').facts };
  expect(await syncBundle(store({ 'demo-shop': withRealKnowledge }), 'demo-shop')).toBeNull();
  expect((await syncBundle(store({ 'demo-shop': withRealKnowledge }), 'demo-shop', undefined, { shareDemoCreated: true }))?.facts).toHaveLength(1);
  const preview = await previewCloudSync(store({ 'demo-shop': withRealKnowledge }), ['demo-shop']);
  expect(preview.projects[0].reason).toContain('Reserved demo-shop fixture');
});


test('a revoked token reported by policy discovery cannot turn an unchanged sync into false success', async () => {
  const memory = new Map();
  const portability = store({ shop: bundle() });
  let revoked = false;
  const { f, calls } = fakeFetch([]);
  const fetcher: typeof fetch = async (url, init) => String(url).endsWith('/sync-policy')
    ? revoked ? new Response(null, { status: 401 }) : Response.json({ revision: 'a'.repeat(64) })
    : f(url, init);
  const deps = { cloud, memory, portability, fetch: fetcher, projects: async () => ['shop'], trigger: 'schedule' as const };
  expect((await runCloudSync(deps)).ok).toBe(true);
  portability.exportData.mockClear();
  revoked = true;
  const result = await runCloudSync(deps);
  expect(result).toMatchObject({ ok: false, stopped: true, error: expect.stringMatching(/refused the token/) });
  expect(portability.exportData).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
});


test('tool-version-only upgrades do not resend and proven 0.6.9 fingerprints migrate without uploading', async () => {
  const legacy = await syncBundle(store({ shop: bundle('shop', { toolVersion: '0.6.9' }) }), 'shop');
  const sorted = <T>(rows: T[]) => rows.map(r => [JSON.stringify(r), r] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, r]) => r);
  const hash = createHash('sha256').update(JSON.stringify({ ...legacy!, exportedAt: '', withdrawn: [],
    projects: sorted(legacy!.projects), lessons: sorted(legacy!.lessons), misses: sorted(legacy!.misses.map(m => ({ ...m, contextItems: sorted(m.contextItems) }))),
    facts: sorted(legacy!.facts), docs: sorted(legacy!.docs), codeFiles: sorted(legacy!.codeFiles ?? []),
  })).digest('hex');
  const memory = new Map([['shop', { fingerprint: hash, remote: 'github.com/acme/shop', lessons: ['lesson:1'], misses: ['miss:1'], docs: ['doc:shop:upload:a.md'], files: ['src/checkout.ts'] }]]);
  const bundles = { shop: bundle('shop', { toolVersion: '0.7.0' }) }, sent = fakeFetch([]);
  const deps = { cloud, portability: store(bundles), projects: async () => ['shop'], trigger: 'schedule' as const, fetch: sent.f, sleep: noSleep, memory };
  expect((await runCloudSync(deps)).projects[0].status).toBe('unchanged');
  expect(sent.calls).toHaveLength(0);
  expect(memory.get('shop')).toMatchObject({ fingerprintVersion: 2 });
  bundles.shop.toolVersion = '0.7.1';
  expect((await runCloudSync(deps)).projects[0].status).toBe('unchanged');
  bundles.shop.lessons[0].rule = 'a real content edit';
  expect((await runCloudSync(deps)).projects[0].status).toBe('sent');
  expect(sent.calls).toHaveLength(1);
});

test('sync history survives both services restarting, keeps newest completion and isolates cloud credentials', async () => {
  const docs = cursors(), memory = storedSyncMemory(docs, cloud);
  const sent = fakeFetch([Response.json({ ...ok, teamLessons: { adminApprovalRequired: true, approved: 0, suggested: 1, blocked: true, message: 'An admin must approve team lessons.' } })]);
  const manual = await runCloudSync({ cloud, portability: store({ shop: bundle() }), projects: async () => ['shop'], trigger: 'manual', fetch: sent.f, memory });
  const restarted = storedSyncMemory(docs, cloud);
  expect(await restarted.last?.('manual')).toEqual(manual);
  expect(manual.projects[0].teamLessons?.blocked).toBe(true);
  const newest = { ...manual, at: '2099-01-01T00:00:00.000Z', trigger: 'schedule' as const };
  await restarted.recordLast?.(newest);
  await memory.recordLast?.({ ...manual, at: '2000-01-01T00:00:00.000Z' });
  expect((await restarted.last?.())?.at).toBe(newest.at);
  expect((await restarted.last?.('manual'))?.at).toBe(manual.at);
  expect(await storedSyncMemory(docs, { ...cloud, token: 'different-credential' }).last?.()).toBeNull();
  expect([...(await memory.keys())]).toEqual(['shop']);
});


test('policy discovery explains admin approval even when an unchanged project needs no upload', async () => {
  const memory = new Map(), first = fakeFetch([]), portability = store({ shop: bundle() });
  await runCloudSync({ cloud, portability, projects: async () => ['shop'], trigger: 'manual', fetch: first.f, memory });
  const gate = { adminApprovalRequired: true, approved: 0, suggested: 81, blocked: true, message: 'An admin must approve team lessons.' };
  let posts = 0;
  const fetch = (async (url: string) => {
    if (url.endsWith('/sync-policy')) return Response.json({ teamLessons: gate });
    posts++; return Response.json(ok);
  }) as unknown as typeof globalThis.fetch;
  const next = await runCloudSync({ cloud, portability, projects: async () => ['shop'], trigger: 'schedule', fetch, memory });
  expect(posts).toBe(0);
  expect(next.projects[0]).toMatchObject({ status: 'unchanged', teamLessons: gate });
  expect(memory.get('shop')).toMatchObject({ teamLessons: gate });
});
