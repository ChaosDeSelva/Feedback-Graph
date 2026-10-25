import { useEffect, useState } from 'react';
import { api, type PatternReport, type ProjectHotspot, type ProjectSummary } from './api.ts';
import { IncludeTests } from './CodeMap.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { Select } from './ui/controls.tsx';
import { Alert, Card, causeLabel, causeTone, EmptyState, StatGrid, StatTile, StatTileSkeleton, tableClass, tdClass, thClass, TONE_FILL } from './ui/display.tsx';

export const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');

type Week = PatternReport['weekly'][number];
const DAY = 86_400_000;

/** Monday (UTC) of an ISO week label like "2026-W41", or null when the label is something else. */
function mondayOf(label: string): number | null {
  const m = label.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (Number(m[2]) - 1) * 7 * DAY;
}

function isoWeek(t: number): string {
  const thursday = t + (3 - ((new Date(t).getUTCDay() + 6) % 7)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The weeks to draw: every week from the first to the last (quiet weeks as zero), and at least `min`
 * of them, so one busy week reads as a spike against quiet ones instead of a lone bar.
 */
export function fillWeeks(weekly: Week[], min = 8): Week[] {
  const last = weekly.length ? mondayOf(weekly[weekly.length - 1].week) : null;
  const first = weekly.length ? mondayOf(weekly[0].week) : null;
  if (last === null || first === null) return weekly;
  const byWeek = new Map(weekly.map((w) => [w.week, w]));
  const start = Math.min(first, last - (min - 1) * 7 * DAY);
  const out: Week[] = [];
  for (let t = start; t <= last; t += 7 * DAY) {
    const week = isoWeek(t);
    out.push(byWeek.get(week) ?? { ...weekly[0], week, feedback: 0, repeats: 0 });
  }
  return out;
}

/** Feedback per ISO week as columns: first-time misses below, repeats stacked on top. */
export function WeeklyChart({ weekly: given }: { weekly: PatternReport['weekly'] }) {
  const weekly = fillWeeks(given);
  const max = Math.max(1, ...weekly.map((w) => w.feedback));
  const step = Math.max(1, Math.ceil(weekly.length / 8));
  return (
    <div className="grid gap-2 p-3">
      <div className="flex items-center gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-[2px] bg-muted" />first time</span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-[2px] bg-bad" />repeat of an earlier miss</span>
        <span className="ml-auto tabular-nums">max {max}</span>
      </div>
      <div className="relative h-40 border-b border-field">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-dashed border-line" />
        <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
        <ul className="relative flex h-full items-end justify-center gap-1.5">
          {weekly.map((w) => {
            const fresh = Math.max(w.feedback - w.repeats, 0);
            return (
              <li key={w.week} className="group relative flex h-full max-w-12 min-w-0 flex-1 flex-col justify-end" aria-label={`${w.week}: ${w.feedback} feedback, ${w.repeats} repeats`}>
                <div className="flex flex-col gap-[2px] rounded-t-[3px] group-hover:opacity-80" style={{ height: `${(w.feedback / max) * 100}%` }}>
                  {w.repeats > 0 && <span className="min-h-[2px] rounded-t-[3px] bg-bad" style={{ flex: w.repeats }} />}
                  {fresh > 0 && <span className={`min-h-[2px] bg-muted ${w.repeats ? '' : 'rounded-t-[3px]'}`} style={{ flex: fresh }} />}
                </div>
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-sm border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-pop group-hover:block">
                  <div className="font-semibold">{w.week}</div>
                  <div className="text-muted tabular-nums">{w.feedback} feedback, {w.repeats} repeats</div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div aria-hidden="true" className="flex justify-center gap-1.5 font-mono text-[10px] text-muted">
        {weekly.map((w, i) => (
          <span key={w.week} className={`max-w-12 min-w-0 flex-1 text-center ${i % step === 0 || i === weekly.length - 1 ? '' : 'invisible'}`}>{w.week.slice(5)}</span>
        ))}
      </div>
    </div>
  );
}

export function Patterns() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState('');
  const [report, setReport] = useState<PatternReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.projects().then(setProjects, (e) => setError(String(e))); }, []);
  useEffect(() => {
    // Clear the old report while the new one loads, and drop a slow answer for a filter you have left.
    setReport(null);
    let stale = false;
    api.patterns(project || undefined).then((r) => { if (!stale) setReport(r); }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [project]);
  const [hot, setHot] = useState<ProjectHotspot[] | null>(null);
  const [tests, setTests] = useState(false);
  useEffect(() => {
    let stale = false;
    api.topHotspots(project || undefined, 10, tests, true).then((h) => { if (!stale) setHot(h); }, () => { if (!stale) setHot([]); });
    return () => { stale = true; };
  }, [project, tests]);

  const feedback = report?.weekly.reduce((n, w) => n + w.feedback, 0) ?? 0;
  const repeats = report?.weekly.reduce((n, w) => n + w.repeats, 0) ?? 0;
  const maxCause = Math.max(1, ...(report?.causes.map((c) => c.count) ?? []));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Patterns"
        description="Whether the same kinds of miss keep coming back, and why misses happen."
        actions={
          <Select aria-label="project" value={project} onChange={(e) => setProject(e.target.value)} className="w-44">
            <option value="">all projects</option>
            {/* Every project, as on the other pages; one with no feedback says so below. */}
            {projects.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          </Select>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:p-5">
          {error && <Alert>{error}</Alert>}
          {projects.find((p) => p.key === project)?.feedback === 0 && (
            <Card>
              <EmptyState compact title={`No feedback in ${project} yet`}>
                Nothing from this project has been confirmed in the Inbox, so there are no misses to find patterns in. Where agents struggle in its code is still below.
              </EmptyState>
            </Card>
          )}

          <StatGrid>
            {report ? (
              <>
                <StatTile label="confirmed feedback" value={String(feedback)} hint="pushback you confirmed" />
                <StatTile label="repeat rate" value={pct(repeats, feedback)} hint={`${repeats} were a miss seen before`} />
                <StatTile label="pre-done checks" value={String(report.preDone.checks)} hint="agents checked their work" />
                <StatTile label="checks that caught a gap" value={pct(report.preDone.withGaps, report.preDone.checks)} hint={`${report.preDone.gapsFound} gaps flagged`} />
              </>
            ) : (
              Array.from({ length: 4 }, (_, i) => <StatTileSkeleton key={i} />)
            )}
          </StatGrid>

          {report && (
            <>
              <Card title="Why misses happen" bodyClass="p-3">
                <ul className="grid gap-2.5">
                  {report.causes.map((c) => (
                    <li key={c.cause} className="group grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_2.5rem] items-center gap-3" title={`${causeLabel(c.cause)}: ${c.count}`}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${TONE_FILL[causeTone(c.cause)]}`} />
                        <span className="truncate">{causeLabel(c.cause)}</span>
                      </span>
                      <span className="h-2 overflow-hidden rounded-full bg-sunken">
                        <span className={`block h-full rounded-full group-hover:opacity-80 ${TONE_FILL[causeTone(c.cause)]}`} style={{ width: `${(c.count / maxCause) * 100}%` }} />
                      </span>
                      <span className="text-right font-medium tabular-nums">{c.count}</span>
                    </li>
                  ))}
                  {report.causes.length === 0 && <li className="py-4 text-muted">No post-mortems yet. Confirm feedback in the Inbox and the causes show up here.</li>}
                </ul>
              </Card>

              <Card title="Feedback per week">
                {report.weekly.length > 0 ? <WeeklyChart weekly={report.weekly} /> : <p className="p-3 py-6 text-muted">No confirmed feedback yet. Confirm items in the Inbox to start the trend.</p>}
              </Card>

              <Struggle hot={hot} tests={tests} onTests={setTests} />

              <Card title="Repeated misses: the same kind of miss more than once">
                <ul>
                  {report.repeatGroups.map((g, i) => (
                    <li key={i} className="grid gap-1 border-b border-line px-3 py-2.5 last:border-b-0">
                      <div className="text-xs text-muted tabular-nums">{g.count}× · {g.projects.join(', ')} · {causeLabel(g.cause)} · last {g.lastSeen.slice(0, 10)}</div>
                      <ul className="list-disc pl-5 marker:text-faint">{g.examples.map((e, j) => <li key={j}>{e}</li>)}</ul>
                    </li>
                  ))}
                  {report.repeatGroups.length === 0 && <li className="px-3 py-4 text-muted">No repeats found. That is the goal.</li>}
                </ul>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The files agents keep getting wrong: the files a confirmed miss touched, by hotspot score, across the selected
 * projects. A busy file no miss touched is a hotspot, not a struggle: those are on the Projects page.
 */
function Struggle({ hot, tests, onTests }: { hot: ProjectHotspot[] | null; tests: boolean; onTests: (v: boolean) => void }) {
  return (
    <Card
      title="Where agents struggle"
      actions={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <IncludeTests checked={tests} onChange={onTests} />
          <span className="text-xs text-muted">score = 4 × misses + log2(1 + churn) + log2(1 + dependents)</span>
        </div>
      }
    >
      {hot && hot.length > 0 ? (
        <div className="overflow-x-auto">
          <table className={`${tableClass} text-[13px]`}>
            <thead>
              <tr>
                <th className={thClass}>project</th>
                <th className={thClass}>file</th>
                {['misses', 'churn', 'dependents', 'score'].map((h) => <th key={h} className={`${thClass} w-[6rem] text-right`}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {hot.map((h) => (
                <tr key={`${h.projectKey}:${h.path}`} className="last:[&>td]:border-b-0 hover:bg-sunken">
                  <td className={`${tdClass} whitespace-nowrap text-muted`}>{h.projectKey}</td>
                  <td className={`${tdClass} font-mono text-[12px] [overflow-wrap:anywhere]`}>{h.path}</td>
                  <td className={`${tdClass} text-right tabular-nums ${h.misses ? 'font-semibold' : 'text-muted'}`}>{h.misses}</td>
                  <td className={`${tdClass} text-right text-muted tabular-nums`}>{h.churn}</td>
                  <td className={`${tdClass} text-right text-muted tabular-nums`}>{h.dependents}</td>
                  <td className={`${tdClass} text-right font-semibold tabular-nums`}>{h.score.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line px-3 py-2 text-xs text-muted">Open a file on the Projects page to see its symbols, importers, tests, lessons and misses.</p>
        </div>
      ) : (
        <p className="p-3 py-6 text-muted">
          {hot ? (
            <>
              No files with misses yet: no confirmed miss has touched a mapped file. The busiest files are in each project's{' '}
              <a href="#projects" className="font-semibold underline underline-offset-2">hotspots</a>.
            </>
          ) : 'Loading…'}
        </p>
      )}
    </Card>
  );
}
