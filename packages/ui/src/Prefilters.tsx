import { useEffect, useState } from 'react';
import { FEEDBACK_SKIP_RULES } from '@fb/core/feedback-rules';
import { integrationsApi, type SkipRuleView } from './api.ts';

/**
 * The rules that keep a GitHub or Linear comment from reaching the classifier, read-only. They come from the same list
 * the worker applies (core feedbackRules.ts); a skipped comment is labelled neutral with `skip:<name>` as its signal.
 * Each rule shows how many comments it has kept out (the worker's comments_skipped entries, which carry samples).
 */
export function Prefilters() {
  const [counts, setCounts] = useState<{ rules: SkipRuleView[]; since: string | null } | null>(null);
  useEffect(() => {
    let stale = false;
    integrationsApi.get().then((v) => { if (!stale && v.rules) setCounts({ rules: v.rules, since: v.skippedSince ?? null }); }, () => {});
    return () => { stale = true; };
  }, []);
  const skipped = (name: string) => counts?.rules.find((r) => r.name === name)?.skipped ?? null;
  return (
    <section aria-labelledby="settings-prefilters" className="grid gap-2.5">
      <div>
        <h2 id="settings-prefilters" className="font-semibold">Comments skipped before the classifier</h2>
        <p className="mt-0.5 text-muted">
          GitHub and Linear comments that match one of these are labelled neutral without a model call, and the rule is
          recorded. Bots and AI agents are labelled; agent comments are kept and classified.
        </p>
      </div>
      <ul aria-label="comments skipped before the classifier" className="grid gap-1.5">
        {FEEDBACK_SKIP_RULES.map((r) => {
          const n = skipped(r.name);
          return (
            <li key={r.name} className="rounded-md border border-line px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <code className="text-xs font-medium">{r.name}</code>
                {n !== null && <span className="text-xs text-muted tabular-nums">{n} skipped</span>}
              </div>
              <p className="mt-0.5 text-sm text-muted">{r.description}</p>
            </li>
          );
        })}
      </ul>
      {counts && (
        <p className="text-xs text-muted">
          {counts.since ? `Counted since ${new Date(counts.since).toLocaleDateString()}. ` : 'Nothing skipped yet. '}
          Each worker cycle that skips comments leaves a "comments skipped" entry with a few of them;{' '}
          <a href="#activity" className="text-accent-text underline underline-offset-2">see them in Activity</a>.
        </p>
      )}
    </section>
  );
}
