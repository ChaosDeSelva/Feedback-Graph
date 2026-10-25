import type { CandidateDetail as Detail, ExternalRef, FeedbackSource } from './api.ts';
import type { HumanTurn } from '@fb/core';
import { feedbackSkipRule, isSelfReview } from '@fb/core/feedback-rules';
import { Fragment, useState } from 'react';
import { sessionHref } from './links.ts';
import { Badge, Card, SectionLabel, StatusBadge, tableClass, tdClass, type Tone } from './ui/display.tsx';
import { Markdown } from './ui/Markdown.tsx';

const when = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const SOURCE_LABEL: Record<FeedbackSource, string> = { claude: 'Claude', codex: 'Codex', github: 'GitHub', linear: 'Linear' };
/** One tone per source, none shared, so a mixed list reads apart at a glance. */
export const SOURCE_TONE: Record<FeedbackSource, Tone> = { claude: 'accent', codex: 'neutral', github: 'info', linear: 'violet' };

/** Where an Inbox item came from: the agent whose session it was flagged in, or GitHub / Linear for a comment. */
export function SourceBadge({ source }: { source: FeedbackSource | undefined }) {
  const s = source ?? 'claude';
  return <Badge tone={SOURCE_TONE[s]} className="shrink-0">{SOURCE_LABEL[s] ?? s}</Badge>;
}

/** An AI agent reviewing its own pull request under the author's account (core isSelfReview): kept, but not a reviewer. */
export function SelfReviewBadge() {
  return <Badge tone="neutral" className="shrink-0" title="An AI agent reviewing its own pull request under the author's account: kept and classified, but not a reviewer's pushback">self-review</Badge>;
}

const AUTHOR_KIND_LABEL = { agent: 'AI agent', bot: 'bot' } as const;

/**
 * A pending comment a skip rule matches: synced before its author details were kept, it reached the Inbox although the
 * rules would keep it out today. Said, not acted on: the decision stays yours.
 */
function SkipRuleNote({ text, ext }: { text: string; ext: ExternalRef }) {
  const rule = feedbackSkipRule(text, ext);
  if (!rule) return null;
  return (
    <div role="note" className="rounded-md border border-line bg-sunken px-3.5 py-2.5 text-[13px] leading-relaxed">
      This comment matches the skip rule <code className="text-xs font-medium">{rule.name}</code>: {rule.description} It would not reach
      the Inbox if it came in today (it was synced before its author details were kept). Reject it if it is not feedback.
    </div>
  );
}

const KIND_LABEL: Record<ExternalRef['kind'], string> ={ review_comment: 'review comment', review: 'review', issue_comment: 'comment', linear_comment: 'comment' };

/** Who wrote a synced comment, from the stored fields (never from what the comment says): bot, agent, PR author or reviewer. */
export function authorRole(ext: ExternalRef): string | null {
  if (ext.authorKind === 'bot') return 'bot';
  if (ext.authorKind === 'agent') return 'agent';
  if (ext.source !== 'github') return null;
  if (ext.threadAuthor && ext.author.toLowerCase() === ext.threadAuthor.toLowerCase()) return 'PR author';
  return 'reviewer';
}

/**
 * Long links whose query is percent-encoded (deployment bots' "Visit Preview" links run to hundreds of characters)
 * shown as their host and `…`; the full link stays one click away on GitHub.
 */
export function shortenLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s)\]>"']+/g, (u) => {
    if (u.length <= 80 && !/(%[0-9A-Fa-f]{2}){3,}/.test(u)) return u;
    try {
      return `${new URL(u).host}/…`;
    } catch {
      return `${u.slice(0, 40)}…`;
    }
  });
}

/** A body a bot posts on every PR (deployment previews, coverage tables): collapsed, it rarely says anything to learn from. */
const BOT_BODY = /^\s*(\[?(preview deployment|deploy preview|vercel|netlify|codecov|coverage report)|<!--)/i;
const isBotBody = (turn: HumanTurn) => turn.external?.authorKind === 'bot' || BOT_BODY.test(turn.text);

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
  const ext = turn.external;
  const role = ext ? authorRole(ext) : null;
  const bot = !!ext && !flagged && isBotBody(turn);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`min-w-0 rounded-md border px-3.5 py-2.5 ${flagged ? 'border-accent bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]' : 'border-line bg-surface'}`}>
      <Speaker who={ext ? ext.author : 'You'} meta={ext ? `${KIND_LABEL[ext.kind]}, ${when(turn.ts)}` : `turn ${turn.index}, ${when(turn.ts)}`}>
        {ext?.authorKind && ext.authorKind !== 'human'
          ? <Badge title={ext.authorVerified ? 'by its login' : 'by a marker in the comment'}>{AUTHOR_KIND_LABEL[ext.authorKind]}</Badge>
          : role && <Badge tone="info">{role}</Badge>}
        {ext && isSelfReview(ext) ? <SelfReviewBadge /> : flagged && <Badge tone="accent">flagged as pushback</Badge>}
        {ext?.url && <a href={ext.url} target="_blank" rel="noreferrer noopener" className="text-accent-text underline underline-offset-2">open</a>}
      </Speaker>
      {ext?.path && <p className="mb-1 font-mono text-[11.5px] text-muted [overflow-wrap:anywhere]">{ext.path}{ext.line != null ? `:${ext.line}` : ''}</p>}
      <p className={`text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${bot && !expanded ? 'line-clamp-2 text-muted' : ''}`}>{ext ? shortenLinks(turn.text) : turn.text}</p>
      {bot && (
        <button type="button" aria-label={expanded ? 'collapse the bot comment' : 'show the bot comment'} onClick={() => setExpanded(!expanded)} className="mt-1 text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-text">
          {expanded ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  );
}

/**
 * The PR or issue a comment was on (for a Linear ticket its state, priority, labels and assignee), its description,
 * the code the comment was about, and the agent session that did the work.
 */
function ExternalContext({ ext }: { ext: ExternalRef }) {
  const where = ext.source === 'github' ? 'Pull request' : 'Linear issue';
  const t = ext.ticket;
  const facts: [string, string | null | undefined][] = t
    ? [['State', t.state], ['Priority', t.priority], ['Labels', t.labels?.length ? t.labels.join(', ') : null], ['Assignee', t.assignee]]
    : [];
  return (
    <Card title={`${where} ${ext.thread}`} actions={<a href={ext.threadUrl} target="_blank" rel="noreferrer noopener" className="text-xs font-medium text-accent-text underline underline-offset-2">Open on {ext.source === 'github' ? 'GitHub' : 'Linear'}</a>} bodyClass="grid gap-2 px-3 py-2.5">
      <p className="font-medium [overflow-wrap:anywhere]">{ext.title}</p>
      <dl className="grid gap-x-4 gap-y-0.5 text-[12.5px] sm:grid-cols-[auto_1fr]">
        {facts.filter(([, v]) => v).map(([k, v]) => (<Fragment key={k}><dt className="text-muted">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></Fragment>))}
        {ext.branch && (<><dt className="text-muted">Branch</dt><dd className="font-mono text-[12px] [overflow-wrap:anywhere]">{ext.branch}</dd></>)}
        <dt className="text-muted">Work session</dt>
        <dd>
          {ext.linkedSessionIds.length
            ? ext.linkedSessionIds.map((id, i) => <span key={id}>{i > 0 && ', '}<a href={sessionHref(id)} className="font-mono text-[12px] text-accent-text underline underline-offset-2">{id.slice(0, 8)}</a></span>)
            : <span className="text-muted">none found yet; the post-mortem looks again, and works from the comment alone if there is none</span>}
        </dd>
      </dl>
      {ext.description?.trim() && <Description text={ext.description} />}
      {ext.diffHunk &&<pre className="max-h-48 overflow-auto rounded-sm bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-snug whitespace-pre">{ext.diffHunk}</pre>}
    </Card>
  );
}

/** More than this many lines or characters is clipped to about six lines, with "show more". */
const LONG_LINES = 6;
const LONG_CHARS = 480;

/**
 * The PR or issue description, in the flow of the pane (no scroll box of its own, which would trap the wheel above the
 * comments): clipped to about six lines when long, with "show more"; long encoded links shortened.
 */
function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.trim().split('\n').filter((l) => l.trim()).length > LONG_LINES || text.length > LONG_CHARS;
  return (
    <div className="grid gap-1 border-t border-line pt-2">
      <SectionLabel>Description</SectionLabel>
      <div data-testid="description" className={long && !open ? 'max-h-[8.25rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}>
        <Markdown text={shortenLinks(text)} className="text-[13px] leading-relaxed" />
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="justify-self-start text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-text">
          {open ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  );
}

export function CandidateDetail({ detail }: { detail: Detail }) {
  const { turn, before, after, commits, candidate } = detail;
  const ext = turn.external ?? candidate.external ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={candidate.source} />
          <Badge>{candidate.projectKey}</Badge>
          <StatusBadge status={candidate.status} />
          <Badge tone="accent">{candidate.classification.label}</Badge>
          <span className="text-xs text-muted tabular-nums">{Math.round(candidate.classification.confidence * 100)}% confident</span>
        </div>
        <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{candidate.classification.summary || '(no summary)'}</h2>
      </header>

      {ext && candidate.status === 'pending' && <SkipRuleNote text={turn.text} ext={ext} />}

      {ext && <ExternalContext ext={ext} />}

      <section className="grid gap-2">
        <SectionLabel>{ext ? 'Comments' : 'Conversation'}</SectionLabel>
        {before.map((t) => <TurnBlock key={t.uuid} turn={t} />)}

        {!ext && (
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
        )}

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
