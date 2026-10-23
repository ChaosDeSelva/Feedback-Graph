import type { ReactNode } from 'react';

/** The slim bar at the top of every page: what this page is, one line on what it is for, and its controls. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5 md:min-h-14 md:px-5">
      <div className="min-w-0 flex-1 basis-60">
        <h1 className="text-[17px] leading-tight font-semibold tracking-[-0.01em] [font-stretch:88%]">{title}</h1>
        {description && <p className="text-xs text-muted md:truncate">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
