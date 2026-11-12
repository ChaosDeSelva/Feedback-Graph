import { act } from '@testing-library/react';

/**
 * Test-only: a fetch answer the test holds back. `answer()` is what the stubbed fetch returns: it waits until the test
 * calls `deliver()`, which lets it through and returns once the page has read it and rendered whatever it does with it.
 * So "a slow answer never replaces the newer one" is checked after the slow answer really arrived, however long a
 * loaded machine takes, instead of after a fixed sleep that it may not have outlasted.
 */
export function heldAnswer(body: unknown, init?: ResponseInit) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let readIt!: () => void;
  const read = new Promise<void>((resolve) => { readIt = resolve; });
  const answer = async () => {
    await gate;
    const res = Response.json(body, init);
    const json = res.json.bind(res);
    res.json = () => json().finally(readIt);
    return res;
  };
  const deliver = () => act(async () => {
    release();
    await read;
    // What the page does with the body runs on promise callbacks queued behind the read: one macrotask runs them all.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { answer, deliver };
}
