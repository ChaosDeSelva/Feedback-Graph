import { expect, test } from 'vitest';
import { requeueGivenUpOnClassifierChange } from './requeueGivenUp.ts';

function fakes(givenUp: number) {
  const cursors = new Map<string, string>();
  const state = { givenUp, requeues: 0 };
  return {
    state,
    deps: (classifierId: string | undefined, version: string) => ({
      classifierId, version,
      queue: { requeueGivenUpTurns: async () => { state.requeues++; const n = state.givenUp; state.givenUp = 0; return n; } },
      cursors: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => { cursors.set(k, v); } },
    }),
  };
}

test('given-up turns are re-queued once per classifier and version, and again after either changes', async () => {
  const f = fakes(2);
  expect(await requeueGivenUpOnClassifierChange(f.deps('ollama:gemma4', '0.9.2'))).toBe(2);
  f.state.givenUp = 1;
  expect(await requeueGivenUpOnClassifierChange(f.deps('ollama:gemma4', '0.9.2'))).toBeNull();
  expect(f.state.givenUp).toBe(1);
  expect(await requeueGivenUpOnClassifierChange(f.deps('ollama:qwen3', '0.9.2'))).toBe(1);
  f.state.givenUp = 3;
  expect(await requeueGivenUpOnClassifierChange(f.deps('ollama:qwen3', '0.9.3'))).toBe(3);
  expect(await requeueGivenUpOnClassifierChange(f.deps(undefined, '0.9.4'))).toBeNull();
  expect(f.state.requeues).toBe(3);
});
