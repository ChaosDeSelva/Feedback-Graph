import { useId, type ReactNode } from 'react';

/** A white panel on the canvas. `title` gives it a small header row with optional actions on the right. */
export function Card({ title, actions, children, className = '', bodyClass = '', id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  // The title names the card, so assistive tech (and tests) can find it as a region.
  const titleId = useId();
  return (
    <section id={id} aria-labelledby={title ? titleId : undefined} className={`min-w-0 rounded-md border border-line bg-surface shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          {title && <SectionLabel id={titleId}>{title}</SectionLabel>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function SectionLabel({ children, as: As = 'h3', className = '', id }: { children: ReactNode; as?: 'h2' | 'h3' | 'div'; className?: string; id?: string }) {
  return <As id={id} className={`text-[11px] font-semibold tracking-[0.06em] text-muted uppercase ${className}`}>{children}</As>;
}

/** `violet` is a fifth hue for marks that need one more distinct color (a cause, a source); it never means a status. */
export type Tone = 'neutral' | 'info' | 'ok' | 'bad' | 'accent' | 'violet';
const TONES: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-muted',
  info: 'bg-info-soft text-info-text',
  ok: 'bg-ok-soft text-ok-text',
  bad: 'bg-bad-soft text-bad-text',
  accent: 'bg-accent-soft text-accent-text',
  violet: 'bg-violet-soft text-violet-text',
};
const DOTS: Record<Tone, string> = { neutral: 'bg-faint', info: 'bg-info', ok: 'bg-ok', bad: 'bg-bad', accent: 'bg-accent', violet: 'bg-violet' };

export function Badge({ tone = 'neutral', dot = false, children, className = '', title }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-5 max-w-full items-center gap-1 rounded-sm px-1.5 text-[11px] leading-none font-semibold whitespace-nowrap ${TONES[tone]} ${className}`}>
      {dot && <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOTS[tone]}`} />}
      {children}
    </span>
  );
}

/** One color per meaning across every page: waiting on you, done/kept, refused/failed, retired. */
export function statusTone(status: string): Tone {
  if (['pending', 'proposed', 'queued', 'running'].includes(status)) return 'info';
  if (['confirmed', 'approved', 'done'].includes(status)) return 'ok';
  if (['rejected', 'failed', 'revoked'].includes(status)) return 'bad';
  return 'neutral';
}

/** Solid fills for bars and swatches, one per tone (neutral is muted so it still reads as a mark). */
export const TONE_FILL: Record<Tone, string> = { neutral: 'bg-muted', info: 'bg-info', ok: 'bg-ok', bad: 'bg-bad', accent: 'bg-accent', violet: 'bg-violet' };

/** Why a miss happened. The same label and the same tone on every page that shows one, and no two causes share a tone. */
export const CAUSE_LABEL: Record<string, string> = {
  context_missing: 'context missing',
  context_available_ignored: 'context available, ignored',
  code_not_read: 'code not read',
  requirement_unstated: 'requirement unstated',
  verification_gap: 'verification gap',
  implementation_error: 'implementation error',
};
const CAUSE_TONE: Record<string, Tone> = {
  context_missing: 'info',
  context_available_ignored: 'bad',
  code_not_read: 'ok',
  requirement_unstated: 'neutral',
  verification_gap: 'accent',
  implementation_error: 'violet',
};
export const causeLabel = (cause: string) => (Object.hasOwn(CAUSE_LABEL, cause) ? CAUSE_LABEL[cause] : cause);
export const causeTone = (cause: string): Tone => (Object.hasOwn(CAUSE_TONE, cause) ? CAUSE_TONE[cause] : 'neutral');

export function CauseBadge({ cause }: { cause: string }) {
  return <Badge tone={causeTone(cause)} dot>{causeLabel(cause)}</Badge>;
}

/** "1 lesson", "3 lessons". */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** A row of headline numbers. The tiles share borders like one panel. */
export function StatGrid({ children, className = 'grid-cols-2 lg:grid-cols-4' }: { children: ReactNode; className?: string }) {
  return <section className={`grid gap-px overflow-hidden rounded-md border border-line bg-line shadow-card ${className}`}>{children}</section>;
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div aria-label={label} className="min-w-0 bg-surface px-4 py-3">
      <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{label}</div>
      <div className="mt-0.5 text-[28px] leading-tight font-semibold tracking-[-0.01em] tabular-nums [font-stretch:82%]">{value}</div>
      {hint && <div className="truncate text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function StatTileSkeleton() {
  return <div className="grid gap-2 bg-surface px-4 py-3"><Skeleton className="h-2.5 w-24" /><Skeleton className="h-7 w-14" /><Skeleton className="h-2.5 w-32" /></div>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)} dot>{status}</Badge>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-line-strong border-b-2 bg-surface px-1 font-mono text-[10px] leading-none font-medium text-muted">
      {children}
    </kbd>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton rounded-sm ${className}`} />;
}

/** Rows of placeholder text the shape of a list, while it loads. */
export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="loading" className="grid">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid gap-2 border-b border-line px-3 py-3">
          <Skeleton className="h-2.5 w-1/3" />
          <Skeleton className={`h-3 ${i % 2 ? 'w-4/5' : 'w-11/12'}`} />
        </div>
      ))}
    </div>
  );
}

/** The detail pane while it loads: a title bar and a few blocks. */
export function SkeletonDetail() {
  return (
    <div role="status" aria-label="loading" className="grid gap-4">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-16 w-2/3" />
    </div>
  );
}

/** `compact` fits a narrow list column: less padding, smaller type. */
export function EmptyState({ icon, title, children, action, className = '', compact = false }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'px-4 py-8 text-xs' : 'px-6 py-10'} ${className}`}>
      {icon && <div className={`grid place-items-center rounded-md border border-line bg-sunken text-muted ${compact ? 'mb-2 size-8' : 'mb-3 size-9'}`}>{icon}</div>}
      <p className="font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div role="alert" className={`rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-bad-text ${className}`}>{children}</div>;
}

export const tableClass = 'w-full border-separate border-spacing-0 text-left';
export const thClass = 'sticky top-0 z-[1] border-b border-line bg-sunken px-3 py-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase';
export const tdClass = 'border-b border-line px-3 py-2 align-top';

/** "just now", "5m ago", "3d ago". The exact time is in the cell's tooltip. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  if (s < 365 * 86_400) return `${Math.floor(s / (30 * 86_400))}mo ago`;
  return `${Math.floor(s / (365 * 86_400))}y ago`;
}

/** A time as people read it: "Oct 26, 08:34", in the viewer's locale and zone (never the ISO string). */
export const longTime = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** A relative time ("3h ago") with the exact one on hover, in words; never wraps. */
export function Time({ iso, className = '' }: { iso: string; className?: string }) {
  return <time dateTime={iso} title={longTime(iso)} className={`whitespace-nowrap tabular-nums ${className}`}>{ago(iso)}</time>;
}

/** A small muted tag for an id (an actor, a run): one line, cut with an ellipsis, the whole value on hover. */
export function Chip({ children, title, className = '' }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`inline-flex h-[18px] min-w-0 items-center rounded-sm border border-line bg-sunken px-1.5 font-mono text-[11px] leading-none text-muted ${className}`}>
      <span title={title} className="truncate">{children}</span>
    </span>
  );
}
