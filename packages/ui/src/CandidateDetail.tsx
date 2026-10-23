import type { CandidateDetail as Detail } from './api.ts';
import type { HumanTurn } from '@fb/core';
import { Badge, Card, SectionLabel, StatusBadge, tableClass, tdClass } from './ui/display.tsx';
import { Markdown } from './ui/Markdown.tsx';

const when = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Speaker({ who, meta, children }: { who: string; meta?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="font-semibold">{who}</span>
      {meta && <span className="text-muted tabular-nums">{meta}</span>}
      {children}
    </div>
  );
}

function TurnBlock({ turn, flagged }: { turn: HumanTurn; flagged?: boolean }) {
  return (
    <div className={`min-w-0 rounded-md border px-3.5 py-2.5 ${flagged ? 'border-accent bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]' : 'border-line bg-surface'}`}>
      <Speaker who="You" meta={`turn ${turn.index}, ${when(turn.ts)}`}>
        {flagged && <Badge tone="accent">flagged as pushback</Badge>}
      </Speaker>
      <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</p>
    </div>
  );
}

export function CandidateDetail({ detail }: { detail: Detail }) {
  const { turn, before, after, commits, candidate } = detail;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{candidate.projectKey}</Badge>
          <StatusBadge status={candidate.status} />
          <Badge tone="accent">{candidate.classification.label}</Badge>
          <span className="text-xs text-muted tabular-nums">{Math.round(candidate.classification.confidence * 100)}% confident</span>
        </div>
        <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{candidate.classification.summary || '(no summary)'}</h2>
      </header>

      <section className="grid gap-2">
        <SectionLabel>Conversation</SectionLabel>
        {before.map((t) => <TurnBlock key={t.uuid} turn={t} />)}

        <div className="min-w-0 rounded-md border border-line bg-sunken px-3.5 py-2.5">
          <Speaker who="Agent" meta="right before" />
          {turn.precedingAssistantText ? <Markdown text={turn.precedingAssistantText} className="text-[13.5px] leading-relaxed text-text/90" /> : <p className="text-muted">(no text)</p>}
          {turn.precedingToolCalls.length > 0 && (
            <ul className="mt-2 grid max-h-40 gap-0.5 overflow-auto border-t border-line pt-2 font-mono text-[11.5px] text-muted">
              {turn.precedingToolCalls.map((c, i) => (
                <li key={i} className="truncate">
                  <span className="font-semibold text-text">{c.name}</span> {c.filePath ?? c.command ?? ''}
                </li>
              ))}
            </ul>
          )}
        </div>

        <TurnBlock turn={turn} flagged />

        {after.map((t) => <TurnBlock key={t.uuid} turn={t} />)}
      </section>

      {commits.length > 0 && (
        <Card title="Commits during this session">
          <table className={tableClass}>
            <tbody>
              {commits.map((c) => (
                <tr key={c.sha} className="last:[&>td]:border-b-0">
                  <td className={`${tdClass} w-20 font-mono text-xs text-accent-text`}>{c.sha.slice(0, 7)}</td>
                  <td className={`${tdClass} [overflow-wrap:anywhere]`}>{c.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
