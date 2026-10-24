import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { api, type MapGraph } from './api.ts';
import { IncludeTests, ModulePanel } from './CodeMap.tsx';
import { inboxHref, lessonHref } from './links.ts';
import { Alert, CauseBadge, EmptyState, plural, SectionLabel, Skeleton } from './ui/display.tsx';
import { MAX_FIT_ZOOM, useSize } from './ui/graphCanvas.ts';
import { codeLinkLabel, codeNodeLabel } from './ui/graphLabels.ts';
import { GraphIcon } from './ui/icons.tsx';
import { readToken, useTheme } from './ui/theme.ts';

type Kind = 'file' | 'test' | 'miss' | 'lesson';
type CodeNode = { id: string; kind: Kind; label: string; path?: string; score: number; misses: number };
type CodeLink = { source: string; target: string; type: 'IMPORTS' | 'TESTS' | 'EDITED' | 'APPLIES_TO' };
type Selected = { kind: 'file'; path: string } | { kind: 'miss'; id: string } | { kind: 'lesson'; id: string };

const LEGEND: { kind: Kind | 'hot'; label: string }[] = [
  { kind: 'file', label: 'file' }, { kind: 'test', label: 'test file' }, { kind: 'hot', label: 'file with misses' },
  { kind: 'miss', label: 'miss' }, { kind: 'lesson', label: 'lesson' },
];

function usePalette() {
  const theme = useTheme();
  return useMemo(() => ({
    file: readToken('node-file', 'gray'),
    test: readToken('node-test', 'silver'),
    miss: readToken('node-miss', 'red'),
    lesson: readToken('node-lesson', 'green'),
    link: readToken('graph-link', 'gray'),
    surface: readToken('surface', 'white'),
    text: readToken('text', 'black'),
  }), [theme]);
}

/** Files are sized by hotspot score; misses and lessons are small. */
const val = (n: CodeNode) => (n.kind === 'file' || n.kind === 'test' ? 1 + Math.min(n.score, 24) : 1.5);

export function toNodes(g: MapGraph): { nodes: CodeNode[]; links: CodeLink[] } {
  const nodes: CodeNode[] = g.files.map((f) => ({ id: `file:${f.path}`, kind: f.isTest ? 'test' : 'file', label: f.path, path: f.path, score: f.score, misses: f.misses }));
  const links: CodeLink[] = [
    ...g.imports.map((e): CodeLink => ({ source: `file:${e.from}`, target: `file:${e.to}`, type: 'IMPORTS' })),
    ...g.tests.map((e): CodeLink => ({ source: `file:${e.test}`, target: `file:${e.target}`, type: 'TESTS' })),
  ];
  for (const m of g.misses) {
    nodes.push({ id: `miss:${m.missId}`, kind: 'miss', label: m.missed, score: 0, misses: 0 });
    for (const p of m.paths) links.push({ source: `miss:${m.missId}`, target: `file:${p}`, type: 'EDITED' });
  }
  for (const l of g.lessons) {
    nodes.push({ id: `lesson:${l.id}`, kind: 'lesson', label: l.title, score: 0, misses: 0 });
    for (const p of l.paths) links.push({ source: `lesson:${l.id}`, target: `file:${p}`, type: 'APPLIES_TO' });
  }
  return { nodes, links };
}

/** The Graph page's Code mode: the code map of one project, drawn; a file opens its module panel. */
export function CodeGraph({ projectKey }: { projectKey: string }) {
  const [graph, setGraph] = useState<MapGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [box, area] = useSize<HTMLDivElement>();
  const palette = usePalette();
  const fg = useRef<ForceGraphMethods<any, any>>(undefined);
  const fitted = useRef(false);

  useEffect(() => {
    setGraph(null);
    setError(null);
    setSelected(null);
    fitted.current = false;
    let stale = false;
    api.codeGraph(projectKey, tests).then((g) => { if (!stale) setGraph(g); }, (e) => { if (!stale) setError(e instanceof Error ? e.message : String(e)); });
    return () => { stale = true; };
  }, [projectKey, tests]);

  // force-graph rewrites link endpoints into node objects, so it gets its own copy.
  const data = useMemo(() => graph && toNodes(graph), [graph]);
  const miss = selected?.kind === 'miss' ? graph?.misses.find((m) => m.missId === selected.id) : undefined;
  const lesson = selected?.kind === 'lesson' ? graph?.lessons.find((l) => l.id === selected.id) : undefined;
  const isOn = (n: CodeNode) =>
    selected?.kind === 'file' ? n.path === selected.path : selected ? n.id === `${selected.kind}:${selected.id}` : false;
  const fill = (n: CodeNode) => (n.kind === 'miss' || (n.kind !== 'lesson' && n.misses > 0) ? palette.miss : palette[n.kind]);

  const cap = graph?.cap;
  const tops = graph?.files.filter((f) => f.top).length ?? 0;
  const capped = cap && (cap.eligible > tops || cap.neighborsFound > cap.neighbors);

  const fileButton = (p: string) => (
    <button type="button" onClick={() => setSelected({ kind: 'file', path: p })} className="text-left font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">{p}</button>
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(22rem,1fr)_auto] overflow-y-auto md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1 md:overflow-hidden">
      <div ref={box} className="relative min-h-0 overflow-hidden bg-surface">
        {error && <Alert className="absolute top-3 right-3 left-3 z-10">{error}</Alert>}
        <div className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface/90 px-2.5 py-1.5 text-xs text-muted shadow-card backdrop-blur">
            <ul aria-label="legend" className="flex flex-wrap gap-x-3 gap-y-1">
              {LEGEND.map((l) => (
                <li key={l.kind} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block size-2.5 rounded-full" style={{ background: l.kind === 'hot' ? palette.miss : palette[l.kind] }} />
                  {l.label}
                </li>
              ))}
            </ul>
            <IncludeTests checked={tests} onChange={setTests} />
          </div>
          {capped && (
            <p role="note" className="rounded-md border border-line bg-surface/90 px-2.5 py-1 text-xs text-muted shadow-card backdrop-blur">
              Showing the top {tops} of {plural(cap.eligible, 'file')} by hotspot score
              {cap.neighborsFound > cap.neighbors ? ` and ${cap.neighbors} of their ${cap.neighborsFound} neighbours` : ' and their neighbours'}.
              The Projects page lists them all.
            </p>
          )}
        </div>
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
              setTimeout(() => { if (g.zoom() > MAX_FIT_ZOOM) g.zoom(MAX_FIT_ZOOM, 250); }, 420);
            }}
            width={area.width}
            height={area.height}
            backgroundColor={palette.surface}
            nodeId="id"
            nodeLabel={codeNodeLabel}
            nodeColor={fill}
            nodeVal={val}
            nodeCanvasObject={(n: CodeNode & { x?: number; y?: number }, ctx: CanvasRenderingContext2D, scale: number) => {
              const r = Math.sqrt(val(n)) * 3;
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              ctx.beginPath();
              // Misses are diamonds and lessons squares, so a red file and a miss never look alike.
              if (n.kind === 'miss') { ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.3, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r * 1.3, y); ctx.closePath(); }
              else if (n.kind === 'lesson') ctx.rect(x - r, y - r, 2 * r, 2 * r);
              else ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fillStyle = fill(n);
              ctx.fill();
              const on = isOn(n);
              ctx.lineWidth = (on ? 3 : 1.5) / scale;
              ctx.strokeStyle = on ? palette.text : palette.surface;
              ctx.stroke();
            }}
            linkColor={() => palette.link}
            linkWidth={1}
            linkLineDash={(l: CodeLink) => (l.type === 'TESTS' ? [3, 2] : l.type === 'EDITED' || l.type === 'APPLIES_TO' ? [1, 2] : null)}
            linkLabel={codeLinkLabel}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            onNodeClick={(n: CodeNode) => {
              if (n.path) setSelected({ kind: 'file', path: n.path });
              else setSelected({ kind: n.kind as 'miss' | 'lesson', id: n.id.slice(n.id.indexOf(':') + 1) });
            }}
          />
        ) : graph ? (
          <EmptyState icon={<GraphIcon />} title="No code map yet" className="pt-24">
            The worker maps each selected project's code (files, imports, tests and recent churn) within a few minutes, and again whenever the repo changes.
          </EmptyState>
        ) : !error && (
          <div role="status" aria-label="loading" className="grid h-full place-items-center">
            <div className="grid justify-items-center gap-3">
              <Skeleton className="size-16 rounded-full" />
              <Skeleton className="h-2.5 w-28" />
            </div>
          </div>
        )}
      </div>

      <aside aria-label="node details" className="min-h-0 min-w-0 overflow-y-auto border-t border-line bg-canvas p-4 md:border-t-0 md:border-l">
        {selected?.kind === 'file' ? (
          <ModulePanel narrow projectKey={projectKey} path={selected.path} onOpen={(p) => setSelected({ kind: 'file', path: p })} onClose={() => setSelected(null)} />
        ) : miss ? (
          <div className="grid gap-2.5">
            <SectionLabel as="div">miss</SectionLabel>
            <p className="text-[13.5px] leading-relaxed [overflow-wrap:anywhere]">{miss.missed}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <CauseBadge cause={miss.cause} />
              <span className="tabular-nums">{miss.ts.slice(0, 10)}</span>
              <a href={inboxHref(miss.feedbackId)} className="underline decoration-line-strong underline-offset-2 hover:text-text">your feedback</a>
              {miss.lessonId && <a href={lessonHref(miss.lessonId)} className="underline decoration-line-strong underline-offset-2 hover:text-text">its lesson</a>}
            </div>
            <SectionLabel>Files its session edited</SectionLabel>
            <ul className="grid gap-1">{miss.paths.map((p) => <li key={p}>{fileButton(p)}</li>)}</ul>
          </div>
        ) : lesson ? (
          <div className="grid gap-2.5">
            <SectionLabel as="div">approved lesson</SectionLabel>
            <a href={lessonHref(lesson.id)} className="font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{lesson.title}</a>
            <SectionLabel>Files it applies to</SectionLabel>
            <ul className="grid gap-1">{lesson.paths.map((p) => <li key={p}>{fileButton(p)}</li>)}</ul>
          </div>
        ) : (
          <p className="text-muted">
            Click a file to open its module panel. Bigger files score higher as hotspots; red ones had misses. Arrows are imports, dashed ones tests; diamonds are misses and squares the approved lessons on those files.
          </p>
        )}
      </aside>
    </div>
  );
}
