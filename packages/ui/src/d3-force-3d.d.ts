// d3-force-3d (force-graph's engine) ships no types; only what spreadForces uses.
declare module 'd3-force-3d' {
  type Collide = { radius(): (n: any) => number; radius(r: (n: any) => number): Collide; iterations(n: number): Collide };
  export function forceCollide(radius?: (n: any) => number): Collide;
  type Position = { strength(): (n: any) => number; strength(s: number): Position };
  export function forceX(x?: number): Position;
  export function forceY(y?: number): Position;
}
