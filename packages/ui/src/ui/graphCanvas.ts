import { forceCollide, forceX, forceY } from 'd3-force-3d';
import { useEffect, useRef, useState } from 'react';

/** The canvas follows its box: force-graph needs pixel sizes. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** How far fitting the graph to the canvas may zoom in. */
export const MAX_FIT_ZOOM = 3;

type Setter = (v: unknown) => Setter;
type ForceHost = { d3Force(name: string, force?: unknown): unknown };

/**
 * d3's defaults (charge -30, links 30 long, no collision) pack a code map of a hundred files into one ball. Repulsion
 * grows with the number of nodes, links get room by type (a faint NEAR tie long and weak, so files with no drawn
 * neighbour sit around the drawing, not on the hub), no node may overlap another or its caption's first line, and a
 * gentle pull toward the middle keeps a loosely tied node (a miss, a NEAR file) from drifting off the canvas.
 */
export function spreadForces(fg: ForceHost, o: { nodes: number; radius: (n: any) => number }): void {
  const charge = fg.d3Force('charge') as { strength: Setter; distanceMax: Setter } | undefined;
  charge?.strength(-(80 + Math.min(o.nodes, 400) * 1.2));
  charge?.distanceMax(900);
  const link = fg.d3Force('link') as { distance: Setter; strength: Setter } | undefined;
  link?.distance((l: { type?: string }) => (l.type === 'NEAR' ? 90 : l.type === 'TESTS' ? 50 : 75));
  link?.strength((l: { type?: string }) => (l.type === 'NEAR' ? 0.02 : 0.15));
  fg.d3Force('collide', forceCollide((n: unknown) => o.radius(n) + 12).iterations(2));
  fg.d3Force('x', forceX(0).strength(0.05));
  fg.d3Force('y', forceY(0).strength(0.05));
}
