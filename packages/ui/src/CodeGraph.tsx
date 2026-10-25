import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { api, type CodeMapMeta, type MapCapped, type MapGraph } from './api.ts';
import { mapCapNote } from './CodeMap.tsx';
import { IncludeTests, ModulePanel } from './CodeMap.tsx';
import { inboxHref, lessonHref } from './links.ts';
import { Alert, CauseBadge, EmptyState, plural, SectionLabel, Skeleton } from './ui/display.tsx';
import { MAX_FIT_ZOOM, useSize } from './ui/graphCanvas.ts';
import { codeLinkLabel, codeNodeCaption, codeNodeLabel, LabelPlacer, shortestSuffixes } from './ui/graphLabels.ts';
import { Input } from './ui/controls.tsx';
import { GraphIcon } from './ui/icons.tsx';
import { readToken, useTheme } from './ui/theme.ts';

type Kind = 'file' | 'test' | 'miss' | 'lesson';
/** short: the shortest path suffix no other file in the drawing shares; top: one of the top hotspots, not a neighbour. */
type CodeNode = { id: string; kind: Kind; label: string; path?: string; score: number; misses: number; short?: string; top?: boolean };
/** NEAR: not an edge of the code, a faint tie that keeps a file with no drawn neighbour beside the drawing. */
type CodeLink = { source: string; target: string; type: 'IMPORTS' | 'TESTS' | 'EDITED' | 'APPLIES_TO' | 'NEAR' };
/** How many of the top hotspots are captioned at every zoom. */
const ALWAYS_LABELLED = 12;
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
  const short = shortestSuffixes(g.files.map((f) => f.path));
  const nodes: CodeNode[] = g.files.map((f) => ({ id: `file:${f.path}`, kind: f.isTest ? 'test' : 'file', label: f.path, path: f.path, score: f.score, misses: f.misses, short: short.get(f.path), top: f.top }));
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
  // A file whose neighbours are all past the cap would float off alone: tie it faintly to the best-scoring file that
  // has edges, so it sits beside the drawing (the tie is drawn faint and says why on hover).
  const linked = new Set(links.flatMap((l) => [l.source, l.target]));
  const files = nodes.filter((n) => n.path);
  const hub = files.filter((n) => linked.has(n.id)).sort((a, b) => b.score - a.score)[0];
  if (hub) for (const n of files) if (!linked.has(n.id)) links.push({ source: n.id, target: hub.id, type: 'NEAR' });
  return { nodes, links };
}

const linkLabel = (l: CodeLink) => (l.type === 'NEAR' ? 'no drawn neighbour: the files it imports or that import it are past the cap' : codeLinkLabel(l));

/** The Graph page's Code mode: the code map of one project, drawn; a file opens its module panel. */
export function CodeGraph({ projectKey }: { projectKey: string }) {
  const [graph, setGraph] = useState<(MapGraph & { meta?: CodeMapMeta | null; capped?: MapCapped }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [box, area] = useSize<HTMLDivElement>();
  const palette = usePalette();
  const fg = useRef<ForceGraphMethods<any, any>>(undefined);
  const fitted = useRef(false);
  // Every mapped file the find box suggests (the top 500 by score, tests included); any other path can still be typed.
  const [known, setKnown] = useState<string[]>([]);
  const [find, setFind] = useState('');
  // Captions collected while nodes are drawn, placed after the frame: top hotspots first, so they win any overlap.
  const captions = useRef<{ text: string; x: number; y: number; rank: number }[]>([]);
  const placer = useRef(new LabelPlacer());

  useEffect(() => {
    setKnown([]);
    setFind('');
    let stale = false;
    api.codeMap(projectKey, 500, true).then((r) => { if (!stale) setKnown((r?.hotspots ?? []).map((h) => h.path).sort()); }, () => {});
    return () => { stale = true; };
  }, [projectKey]);

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
  const mapCapped = mapCapNote(graph?.meta, graph?.capped);
  // Before anything scores (no misses, churn or importers), the "hotspots" are just docs and config in path order.
  const noHotspots = !!graph && graph.files.length > 0 && graph.files.every((f) => f.score === 0);
  // The top hotspots by score, captioned at every zoom.
  const alwaysLabelled = useMemo(
    () => new Set([...(graph?.files ?? [])].filter((f) => f.top && f.score > 0).sort((a, b) => b.score - a.score).slice(0, ALWAYS_LABELLED).map((f) => f.path)),
    [graph],
  );

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
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const p = find.trim().replace(/^\.?\/+/, '');
              if (p) setSelected({ kind: 'file', path: p });
            }}
          >
            <Input aria-label="find file" size="sm" list="code-files" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a file by path…" className="w-64 bg-surface/90" />
            <datalist id="code-files">{known.map((p) => <option key={p} value={p} />)}</datalist>
          </form>
          {noHotspots && (
            <p role="note" className="rounded-md border border-line bg-surface/90 px-2.5 py-1 text-xs text-muted shadow-card backdrop-blur">
              No hotspots yet: no file has misses, recent commits or importers, so these are just the first files of the map. Find any file by path above.
            </p>
          )}
          {capped && (
            <p role="note" className="rounded-md border border-line bg-surface/90 px-2.5 py-1 text-xs text-muted shadow-card backdrop-blur">
              Showing the top {tops} of {plural(cap.eligible, 'file')} by hotspot score
              {cap.neighborsFound > cap.neighbors ? ` and ${cap.neighbors} of their ${cap.neighborsFound} neighbours` : ' and their neighbours'}.
              The Projects page lists them all.
            </p>
          )}
          {mapCapped && (
            <p role="note" className="rounded-md border border-line bg-surface/90 px-2.5 py-1 text-xs text-muted shadow-card backdrop-blur">
              The map {mapCapped.startsWith('capped') ? 'is' : 'holds'} {mapCapped}; files past the cap are not drawn. Raise SCAN_MAX_FILES to map more.
            </p>
          )}
        </div>
        {data && data.nodes.length > 0 ? (
          <ForceGraph2D
            ref={fg}
            graphData={data}
            cooldownTicks={120}
            onRenderFramePre={() => { captions.current = []; }}
            onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => {
              placer.current.reset();
              ctx.font = `${11 / scale}px sans-serif`;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillStyle = palette.text;
              const h = 13 / scale;
              for (const c of [...captions.current].sort((a, b) => b.rank - a.rank)) {
                const w = ctx.measureText(c.text).width;
                if (placer.current.place(c.x - w / 2, c.y, w, h)) ctx.fillText(c.text, c.x - w / 2, c.y);
              }
            }}
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
              // Canvas text is drawn, not parsed, so the path needs no escaping here (the hover label is HTML).
              const top = !!n.path && alwaysLabelled.has(n.path);
              const caption = codeNodeCaption(n, scale, { top, short: n.short });
              if (caption) captions.current.push({ text: caption, x, y: y + r + 2 / scale, rank: (top ? 1e6 : 0) + n.misses * 1e3 + n.score });
            }}
            linkColor={() => palette.link}
            linkWidth={(l: CodeLink) => (l.type === 'NEAR' ? 0.3 : 1)}
            linkLineDash={(l: CodeLink) => (l.type === 'TESTS' ? [3, 2] : l.type === 'EDITED' || l.type === 'APPLIES_TO' ? [1, 2] : l.type === 'NEAR' ? [1, 6] : null)}
            linkLabel={linkLabel}
            linkDirectionalArrowLength={(l: CodeLink) => (l.type === 'NEAR' ? 0 : 3)}
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
            Click a file to open its module panel, or find one by path; hover one for its full path, or zoom in to see every file's name. Bigger files score higher as hotspots; red ones had misses. Arrows are imports, dashed ones tests; diamonds are misses and squares the approved lessons on those files.
          </p>
        )}
      </aside>
    </div>
  );
}
