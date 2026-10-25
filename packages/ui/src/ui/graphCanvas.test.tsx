import { expect, test } from 'vitest';
import { spreadForces } from './graphCanvas.ts';

type Force = Record<string, unknown> & { _: Record<string, unknown> };
/** A stand-in for force-graph's d3 forces: records what each setter was given. */
function fakeGraph() {
  const forces = new Map<string, Force>();
  const force = (): Force => {
    const f = { _: {} } as Force;
    for (const k of ['strength', 'distance', 'distanceMax', 'radius', 'iterations']) f[k] = (v: unknown) => { f._[k] = v; return f; };
    return f;
  };
  forces.set('charge', force());
  forces.set('link', force());
  return {
    forces,
    d3Force(name: string, f?: Force | null) {
      if (f === undefined) return forces.get(name);
      if (f === null) forces.delete(name);
      else forces.set(name, f);
      return this;
    },
  };
}

test('spreadForces pushes nodes apart more as the drawing grows, and keeps every node clear of its neighbours', () => {
  const small = fakeGraph();
  spreadForces(small, { nodes: 10, radius: () => 4 });
  const big = fakeGraph();
  spreadForces(big, { nodes: 200, radius: () => 4 });
  const charge = (g: ReturnType<typeof fakeGraph>) => g.forces.get('charge')!._.strength as number;
  expect(charge(small)).toBeLessThan(-30); // stronger than d3's default
  expect(charge(big)).toBeLessThan(charge(small));

  const collide = big.forces.get('collide') as unknown as { radius(): (n: object) => number };
  expect(collide).toBeTruthy();
  expect(collide.radius()({})).toBeGreaterThan(4); // the node itself plus a gap
});

test('spreadForces gives links room by type: a faint NEAR tie is long and weak', () => {
  const g = fakeGraph();
  spreadForces(g, { nodes: 50, radius: () => 4 });
  const link = g.forces.get('link')!._;
  const distance = link.distance as (l: { type?: string }) => number;
  const strength = link.strength as (l: { type?: string }) => number;
  expect(distance({ type: 'IMPORTS' })).toBeGreaterThan(30);
  expect(distance({ type: 'NEAR' })).toBeGreaterThan(distance({ type: 'IMPORTS' }));
  expect(strength({ type: 'NEAR' })).toBeLessThan(strength({ type: 'IMPORTS' }));
});

test('spreadForces pulls every node gently toward the middle, so a loosely tied one cannot drift off the canvas', () => {
  const g = fakeGraph();
  spreadForces(g, { nodes: 8, radius: () => 4 });
  for (const axis of ['x', 'y']) {
    const f = g.forces.get(axis) as unknown as { strength(): (n: object) => number } | undefined;
    expect(f).toBeTruthy();
    const s = f!.strength()({});
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.2);
  }
});
