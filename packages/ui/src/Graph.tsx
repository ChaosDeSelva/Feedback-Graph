import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { api, type EvidenceGraph, type ProjectSummary } from './api.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { Select } from './ui/controls.tsx';
import { Alert, EmptyState, SectionLabel, Skeleton } from './ui/display.tsx';
import { GraphIcon } from './ui/icons.tsx';
import { readToken, useTheme } from './ui/theme.ts';

type Node = EvidenceGraph['nodes'][number];
type Kind = Node['kind'];

const KINDS: Kind[] = ['feedback', 'miss', 'cause', 'lesson', 'context', 'task', 'commit'];
/**
 * Canvas can't use CSS variables, so the current theme's token values (styles.css) are read once per theme.
 * Without the stylesheet (tests) they fall back to plain gray.
 */
function usePalette() {
  const theme = useTheme();
  return useMemo(() => ({
    node: Object.fromEntries(KINDS.map((k) => [k, readToken(`node-${k}`, 'gray')])) as Record<Kind, string>,
    link: readToken('graph-link', 'gray'),
    surface: readToken('surface', 'white'),
    text: readToken('text', 'black'),
  }), [theme]);
}

function useSize<T extends HTMLElement>() {
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
const MAX_FIT_ZOOM = 3;

const size = (n: Node) => (n.kind === 'cause' ? 6 : n.kind === 'miss' ? 4 : 2);

export function Graph() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [graph, setGraph] = useState<EvidenceGraph | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedProjects, setLoadedProjects] = useState(false);
  const [box, area] = useSize<HTMLDivElement>();
  const palette = usePalette();
  const fg = useRef<ForceGraphMethods<any, any>>(undefined);
  // Fit the drawing to the canvas once per graph, after the layout settles (not again after every drag).
  const fitted = useRef(false);

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      setProject(ps.find((p) => p.feedback > 0)?.key ?? ps[0]?.key ?? null);
      setLoadedProjects(true);
    }, (e) => { setError(String(e)); setLoadedProjects(true); });
  }, []);

  useEffect(() => {
    if (!project) return;
    setSelected(null);
    setGraph(null);
    fitted.current = false;
    // A slow graph for the project you left must not be drawn under the one you picked.
    let stale = false;
    api.graph(project).then((g) => { if (!stale) setGraph(g); }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [project]);

  // force-graph rewrites link endpoints into node objects, so it gets its own copy.
  const data = useMemo(() => graph && { nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) }, [graph]);
  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);
  const connections = selected && graph
    ? graph.links
        .filter((l) => l.source === selected.id || l.target === selected.id)
        .map((l) => ({ type: l.type, out: l.source === selected.id, other: byId.get(l.source === selected.id ? l.target : l.source)! }))
    : [];

  const counts = useMemo(() => {
    const c = new Map<Kind, number>();
    for (const n of graph?.nodes ?? []) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [graph]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Graph"
        description="How each piece of feedback links to its miss, cause, lesson and the context behind it."
        actions={
          <Select aria-label="project" value={project ?? ''} onChange={(e) => setProject(e.target.value)} className="w-56">
            {projects.map((p) => <option key={p.key} value={p.key}>{p.key} ({p.feedback} feedback)</option>)}
          </Select>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(22rem,1fr)_auto] overflow-y-auto md:grid-cols-[minmax(0,1fr)_20rem] md:grid-rows-1 md:overflow-hidden">
        <div ref={box} className="relative min-h-0 overflow-hidden bg-surface">
          {error && <Alert className="absolute top-3 right-3 left-3 z-10">{error}</Alert>}
          <ul aria-label="legend" className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-x-3 gap-y-1 rounded-md border border-line bg-surface/90 px-2.5 py-1.5 text-xs text-muted shadow-card backdrop-blur">
            {KINDS.map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block size-2.5 rounded-full" style={{ background: palette.node[k] }} />
                {k}
                {graph && <span className="text-muted tabular-nums">{counts.get(k) ?? 0}</span>}
              </li>
            ))}
          </ul>
          {data && data.nodes.length > 0 ? (
            <ForceGraph2D
              ref={fg}
              graphData={data}
              cooldownTicks={120}
              onEngineStop={() => {
                if (fitted.current) return;
                fitted.current = true;
                const g = fg.current;
                if (!g) return;
                g.zoomToFit(400, 48);
                // A handful of nodes would otherwise be blown up to fill the canvas.
                setTimeout(() => { if (g.zoom() > MAX_FIT_ZOOM) g.zoom(MAX_FIT_ZOOM, 250); }, 420);
              }}
              width={area.width}
              height={area.height}
              backgroundColor={palette.surface}
              nodeId="id"
              nodeLabel={(n: Node) => `${n.kind}: ${n.label}`}
              nodeColor={(n: Node) => palette.node[n.kind]}
              nodeVal={size}
              nodeCanvasObject={(n: Node & { x?: number; y?: number }, ctx: CanvasRenderingContext2D, scale: number) => {
                const r = Math.sqrt(size(n)) * 4;
                const on = selected?.id === n.id;
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
                ctx.fillStyle = palette.node[n.kind];
                ctx.fill();
                ctx.lineWidth = (on ? 3 : 1.5) / scale;
                ctx.strokeStyle = on ? palette.text : palette.surface;
                ctx.stroke();
              }}
              linkColor={() => palette.link}
              linkWidth={1}
              linkLabel={(l: { type: string }) => l.type}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(n: Node) => setSelected(byId.get(n.id) ?? null)}
            />
          ) : data || (loadedProjects && !project) ? (
            <EmptyState icon={<GraphIcon />} title="No evidence graph yet" className="pt-24">
              Confirm feedback in the Inbox. Once its post-mortem runs, the miss, its cause and the lesson appear here.
            </EmptyState>
          ) : (
            <div role="status" aria-label="loading" className="grid h-full place-items-center">
              <div className="grid justify-items-center gap-3">
                <Skeleton className="size-16 rounded-full" />
                <Skeleton className="h-2.5 w-28" />
              </div>
            </div>
          )}
        </div>

        <aside aria-label="node details" className="min-h-0 min-w-0 overflow-y-auto border-t border-line bg-canvas p-4 md:border-t-0 md:border-l">
          {selected ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: palette.node[selected.kind] }} />
                <SectionLabel as="div">{selected.kind}{selected.status ? ` · ${selected.status}` : ''}</SectionLabel>
              </div>
              <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{selected.label}</p>
              <SectionLabel>Connections</SectionLabel>
              <ul className="grid gap-1.5">
                {connections.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => setSelected(c.other)}
                      className="grid w-full gap-0.5 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-left text-xs shadow-card hover:border-line-strong"
                    >
                      <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
                        <span aria-hidden="true" className="size-2 rounded-full" style={{ background: palette.node[c.other.kind] }} />
                        {c.out ? `${c.type} →` : `← ${c.type}`} {c.other.kind}
                      </span>
                      <span className="line-clamp-3 [overflow-wrap:anywhere]">{c.other.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted">
              Click a node to see its evidence. Red misses link the feedback you gave to its cause, the lesson drawn from it, and the context that would have prevented it.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
