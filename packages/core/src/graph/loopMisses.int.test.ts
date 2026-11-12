import { beforeAll, expect, test } from 'vitest';
import { sessionFiles } from '../codegraph.ts';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Classification, ParsedSession, PostMortem, Project, ToolCall } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const demo: Project = { key: 'demo', name: 'demo', repoPath: '/projects/demo' };
const HOST = '/Users/me/Vibe/demo';
const edit = (path: string): ToolCall => ({ name: 'Edit', ts: '2026-10-01T10:01:00Z', filePath: `${HOST}/${path}` });
const read = (path: string): ToolCall => ({ name: 'Read', ts: '2026-10-01T10:01:00Z', filePath: `${HOST}/${path}` });

function session(id: string, calls: ToolCall[]): ParsedSession {
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i * 2}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: HOST, gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: calls };
}
const pm = (missed: string, subject?: 'process'): PostMortem => ({
  taskTitle: 't', missed, cause: 'verification_gap', causeExplanation: 'no test ran', outcome: 'addressed',
  lesson: { title: `lesson for ${missed}`, rule: 'r', appliesWhen: 'a', scope: 'project', paths: [] }, contextItems: [], ...(subject && { subject }),
});

describeStores('DecisionsStore.loopMisses', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  async function miss(id: string, calls: ToolCall[], axis: number, subject?: 'process') {
    const s = session(id, calls);
    await store.graph.upsertSession(demo, s, []);
    await store.codegraph.recordSessionFiles(id, sessionFiles(s, HOST));
    await store.graph.saveClassification(`${id}-t1`, pushback, true);
    await store.graph.decide(`${id}-t1`, 'confirmed', null);
    await store.knowledge.savePostmortem(`${id}-t1`, pm(`missed in ${id}`, subject), { miss: vec(axis), lesson: vec(axis) });
    return `miss:${id}-t1`;
  }

  test('reads each miss with its embedding, cause and the files its session edited; unknown ids are left out', async () => {
    const a = await miss('s-a', [edit('src/b.ts'), edit('src/a.ts'), read('src/c.ts')], 1);
    const p = await miss('s-p', [edit('src/a.ts')], 2, 'process');
    const got = await store.decisions.loopMisses([p, a, 'miss:none', a]);
    expect(got).toEqual([
      {
        id: a, projectKey: 'demo', cause: 'verification_gap', missed: 'missed in s-a', embedding: vec(1), createdAt: expect.any(String),
        subject: null, run: null, sandbox: false, sessionId: 's-a', editedFiles: ['src/a.ts', 'src/b.ts'],
      },
      expect.objectContaining({ id: p, subject: 'process', sessionId: 's-p', editedFiles: ['src/a.ts'], embedding: vec(2) }),
    ]);
    expect(Date.parse(got[0].createdAt)).not.toBeNaN();
    expect(await store.decisions.loopMisses([])).toEqual([]);
  });
});
