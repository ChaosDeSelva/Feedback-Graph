import type { ReactNode } from 'react';

/**
 * Just enough markdown for an agent's reply: paragraphs, headings, bullet and numbered lists,
 * fenced code, inline code, bold and italics. Everything renders as React text, never as HTML,
 * so a transcript cannot inject markup. Anything else stays as written.
 */
export function Markdown({ text, className = '', cite }: {
  text: string;
  className?: string;
  /** Where a citation like [S1] links to; unset or null: it stays text. */
  cite?: (id: string) => string | null;
}) {
  return <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 [overflow-wrap:anywhere] ${className}`}>{blocks(text, cite)}</div>;
}

type Cite = ((id: string) => string | null) | undefined;

function blocks(text: string, cite?: Cite): ReactNode[] {
  const inline = (t: string) => inlineOf(t, cite);
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      out.push(
        <pre key={out.length} className="overflow-x-auto rounded-sm border border-line bg-surface px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre [overflow-wrap:normal]">
          {body.join('\n')}
        </pre>,
      );
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(<p key={out.length} className="font-semibold">{inline(heading[1])}</p>);
      i++;
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={out.length} className={`grid gap-0.5 pl-5 marker:text-muted ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => <li key={j}>{inline(it)}</li>)}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s)/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={out.length} className="whitespace-pre-wrap">{inline(para.join('\n'))}</p>);
  }
  return out;
}

/** `code`, **bold**, *italic* / _italic_, and [S1] citations when `cite` links them. Unmatched markers are left as they are. */
function inlineOf(text: string, cite?: Cite): ReactNode[] {
  const out: ReactNode[] = [];
  const inline = (t: string) => inlineOf(t, cite);
  const re = /\[(S\d+)\]|`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = out.length;
    const href = m[1] !== undefined ? cite?.(m[1]) : null;
    if (m[1] !== undefined) out.push(href ? <a key={k} href={href} className="font-mono text-[0.88em] text-accent-text hover:underline">{m[0]}</a> : m[0]);
    else if (m[2] !== undefined) out.push(<code key={k} className="rounded-[3px] bg-neutral-soft px-1 py-px font-mono text-[0.88em]">{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={k} className="font-semibold">{inline(m[3] ?? m[4])}</strong>);
    else out.push(<em key={k}>{inline(m[5] ?? m[6])}</em>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
