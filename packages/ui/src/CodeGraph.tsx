import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { api, type CodeMapMeta, type MapCapped, type MapGraph } from './api.ts';
import { mapCapNote } from './CodeMap.tsx';
import { IncludeTests, ModulePanel } from './CodeMap.tsx';
import { inboxHref, lessonHref } from './links.ts';
import { Alert, CauseBadge, EmptyState, plural, SectionLabel, Skeleton } from './ui/display.tsx';
import { MAX_FIT_ZOOM, spreadForces, useSize } from './ui/graphCanvas.ts';
import { codeLinkLabel, codeNodeCaption, codeNodeLabel, keyFiles, placeCaptions, shortestSuffixes, type CaptionWish } from './ui/graphLabels.ts';
import { Input } from './ui/controls.tsx';
import { GraphIcon } from './ui/icons.tsx';
import { readToken, useTheme } from './ui/theme.ts';

type Kind = 'file' | 'test' | 'miss' | 'lesson';
/** short: the shortest path suffix no other file in the drawing shares; top: one of the top hotspots, not a neighbour. */
type CodeNode = { id: string; kind: Kind; label: string; path?: string; score: number; misses: number; short?: string; top?: boolean };
/** NEAR: not an edge of the code, a faint tie that keeps a file with no drawn neighbour beside the drawing. */
type CodeLink = { source: string; target: string; type: 'IMPORTS' | 'TESTS' | 'EDITED' | 'APPLIES_TO' | 'NEAR' };
/** How many key files (misses, then hotspot score, then edges: keyFiles) are named at every zoom, files with misses on top. */
const ALWAYS_LABELLED = 12;
/** Captions per square of CAPTION_CELL screen pixels: the dense centre of a big map shows a few names, not a pile. */
const CAPTION_CELL = 160;
const CAPTIONS_PER_CELL = 3;
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
const radius = (n: CodeNode) => Math.sqrt(val(n)) * 3;

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
  // Captions collected while nodes are drawn, placed after the frame (placeCaptions): key files first, so they win.
  const captions = useRef<CaptionWish[]>([]);
  // And every node's box, so no other caption covers a node.
  const nodeBoxes = useRef<[number, number, number, number][]>([]);
  // The legend, find box and notes float over the canvas's top: the fitted drawing goes below them.
  const overlay = useRef<HTMLDivElement>(null);

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
  // Spread the drawing out before it settles (d3's defaults pack a large map into one ball).
  useEffect(() => {
    const g = fg.current;
    if (!g || !data?.nodes.length) return;
    spreadForces(g, { nodes: data.nodes.length, radius });
    g.d3ReheatSimulation();
  }, [data]);
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
  // The key files, named at every zoom (every file with misses is too, beyond these).
  const alwaysLabelled = useMemo(() => {
    if (!data) return new Set<string>();
    const missed = data.nodes.filter((n) => n.path && n.kind === 'file' && n.misses > 0).length;
    return new Set(keyFiles(data.nodes, data.links, ALWAYS_LABELLED + missed));
  }, [data]);

  const fileButton = (p: string) => (
    <button type="button" onClick={() => setSelected({ kind: 'file', path: p })} className="text-left font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">{p}</button>
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(22rem,1fr)_auto] overflow-y-auto md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1 md:overflow-hidden">
      <div ref={box} className="relative min-h-0 overflow-hidden bg-surface">
        {error && <Alert className="absolute top-3 right-3 left-3 z-10">{error}</Alert>}
        <div ref={overlay} className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface/90 px-2.5 py-1.5 text-xs text-muted shadow-card backdrop-blur">
            <ul aria-label="legend" className="flex flex-wrap gap-x-3 gap-y-1">
              {LEGEND.map((l) => (
                <li key={l.kind} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block size-2.5 rounded-full" style={l.kind === 'hot' ? { background: palette.miss, boxShadow: `0 0 0 1.5px ${palette.surface}, 0 0 0 3px ${palette.miss}` } : { background: palette[l.kind] }} />
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
            cooldownTicks={300}
            onRenderFramePre={() => { captions.current = []; nodeBoxes.current = []; }}
            onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => {
              // Key files and files with misses are named wherever there is room around them (on a halo, over other
              // nodes if need be); the rest at most CAPTIONS_PER_CELL per CAPTION_CELL screen pixels, covering no node.
              const font = (bold: boolean) => `${bold ? '600 ' : ''}${11 / scale}px sans-serif`;
              ctx.font = font(true);
              const placed = placeCaptions(captions.current, {
                nodes: nodeBoxes.current, width: (t) => ctx.measureText(t).width, height: 13 / scale, gap: 2 / scale,
                cell: CAPTION_CELL / scale, perCell: CAPTIONS_PER_CELL,
              });
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.lineJoin = 'round';
              for (const c of placed) {
                ctx.font = font(c.key);
                if (c.key) {
                  ctx.lineWidth = 3 / scale;
                  ctx.strokeStyle = palette.surface;
                  ctx.strokeText(c.text, c.x, c.y + 1 / scale);
                }
                ctx.fillStyle = palette.text;
                ctx.fillText(c.text, c.x, c.y + 1 / scale);
              }
            }}
            onEngineStop={() => {
              if (fitted.current) return;
              fitted.current = true;
              const g = fg.current;
              if (!g) return;
              g.zoomToFit(400, 48);
              setTimeout(() => {
                if (g.zoom() > MAX_FIT_ZOOM) g.zoom(MAX_FIT_ZOOM, 250);
                // Shrink into the height left under the overlay and move the drawing down by half of it.
                const top = (overlay.current?.offsetHeight ?? 0) + 12;
                if (top >= area.height / 2) return;
                const z = Math.min(g.zoom(), MAX_FIT_ZOOM) * ((area.height - top) / area.height);
                const c = g.centerAt();
                g.zoom(z, 250);
                g.centerAt(c.x, c.y - top / 2 / z, 250);
              }, 420);
            }}
            width={area.width}
            height={area.height}
            backgroundColor={palette.surface}
            nodeId="id"
            nodeLabel={codeNodeLabel}
            nodeColor={fill}
            nodeVal={val}
            nodePointerAreaPaint={(n: CodeNode & { x?: number; y?: number }, color: string, ctx: CanvasRenderingContext2D, scale: number) => {
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, Math.max(radius(n), 5 / scale), 0, 2 * Math.PI);
              ctx.fill();
            }}
            nodeCanvasObject={(n: CodeNode & { x?: number; y?: number }, ctx: CanvasRenderingContext2D, scale: number) => {
              // Never smaller than a few screen pixels, so a big map zoomed out to fit stays readable and clickable.
              const r = Math.max(radius(n), (n.kind === 'file' || n.kind === 'test' ? 4.5 : 3.5) / scale);
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              ctx.beginPath();
              // Misses are diamonds and lessons squares, so a red file and a miss never look alike.
              if (n.kind === 'miss') { ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.3, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r * 1.3, y); ctx.closePath(); }
              else if (n.kind === 'lesson') ctx.rect(x - r, y - r, 2 * r, 2 * r);
              else ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fillStyle = fill(n);
              ctx.fill();
              nodeBoxes.current.push([x - r, y - r, 2 * r, 2 * r]);
              const on = isOn(n);
              ctx.lineWidth = (on ? 3 : 1.5) / scale;
              ctx.strokeStyle = on ? palette.text : palette.surface;
              ctx.stroke();
              // A file with misses wears a ring in the miss colour, so it reads apart from a big file at any zoom.
              const missed = n.path !== undefined && n.misses > 0;
              if (missed) {
                ctx.beginPath();
                ctx.arc(x, y, r + 3 / scale, 0, 2 * Math.PI);
                ctx.lineWidth = 2 / scale;
                ctx.strokeStyle = palette.miss;
                ctx.stroke();
              }
              // Canvas text is drawn, not parsed, so the path needs no escaping here (the hover label is HTML).
              const top = !!n.path && alwaysLabelled.has(n.path);
              const caption = codeNodeCaption(n, scale, { top, short: n.short });
              if (caption) {
                captions.current.push({
                  text: missed ? `${caption} (${plural(n.misses, 'miss', 'misses')})` : caption, x, y, r: r + (missed ? 3 / scale : 0),
                  rank: (missed ? 2e6 : 0) + (top ? 1e6 : 0) + n.misses * 1e3 + n.score, key: top || missed, must: missed,
                });
              }
            }}
            linkColor={() => palette.link}
            linkWidth={(l: CodeLink) => (l.type === 'NEAR' ? 0.3 : 0.6)}
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
            Click a file to open its module panel, or find one by path; hover one for its full path, or zoom in to see every file's name. Bigger files score higher as hotspots; red ones with a red ring had misses, and are always named with how many. The twelve key files (misses, then hotspot score, then most connections) are named at every zoom. Arrows are imports, dashed ones tests; diamonds are misses and squares the approved lessons on those files.
          </p>
        )}
      </aside>
    </div>
  );
}
