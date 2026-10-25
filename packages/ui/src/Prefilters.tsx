import { FEEDBACK_SKIP_RULES } from '@fb/core/feedback-rules';

/**
 * The rules that keep a GitHub or Linear comment from reaching the classifier, read-only. They come from the same list
 * the worker applies (core feedbackRules.ts); a skipped comment is labelled neutral with `skip:<name>` as its signal.
 */
export function Prefilters() {
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
        {FEEDBACK_SKIP_RULES.map((r) => (
          <li key={r.name} className="rounded-md border border-line px-3 py-2">
            <code className="text-xs font-medium">{r.name}</code>
            <p className="mt-0.5 text-sm text-muted">{r.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
