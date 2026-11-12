import type { ReactNode } from 'react';
import type { PipelineStatus, SystemStatus } from './api.ts';
import { CopyButton } from './ui/controls.tsx';
import { Card } from './ui/display.tsx';

/** The command that connects Claude Code and Codex (Docs ▸ Connect your agents). */
export const INSTALL_AGENT = './scripts/install-agent.sh';

const link = 'font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

type Step = { key: string; title: string; done: boolean; next: ReactNode };

/**
 * The steps from a fresh install to the first lesson your agent gets, each done by what the API reports. The demo
 * corpus (fg demo seed) and fg demo context are not the owner's progress: demo lessons do not count, and the agent step
 * waits for an agent's own MCP client (status.agent), which the CLI never is.
 */
export function gettingStartedSteps(status: SystemStatus, pipeline: PipelineStatus): Step[] {
  const lessons = pipeline.lessons;
  const own = lessons && { proposed: lessons.proposed - (lessons.demo?.proposed ?? 0), approved: lessons.approved - (lessons.demo?.approved ?? 0) };
  return [
    {
      key: 'projects',
      title: 'Choose the projects to learn from',
      done: (status.selection?.tracked ?? 0) > 0,
      next: <>Tick the project folders in <a href="#settings" className={link}>Settings</a> and save: the worker reads their agent sessions.</>,
    },
    {
      key: 'agent',
      title: 'Connect your agent',
      done: !!status.agent,
      next: (
        <>
          <span className="flex flex-wrap items-center gap-2">
            From the folder you cloned Feedback Graph into, run
            <code className="rounded-[3px] border border-line bg-sunken px-1 py-px font-mono text-[12px]">{INSTALL_AGENT}</code>
            <CopyButton text={INSTALL_AGENT} label="Copy command" />
          </span>
          <span className="mt-1 block">
            then restart Claude Code or Codex. This is done once your agent first asks for context.{' '}
            <a href="#docs/connect-your-agents" className={link}>What it sets up</a>
          </span>
        </>
      ),
    },
    {
      key: 'miss',
      title: 'Confirm a miss',
      done: (pipeline.inbox?.confirmed ?? 0) > 0 || (own ? own.proposed + own.approved > 0 : false),
      next: (
        <>
          Pushback you typed in a session is flagged in the <a href="#inbox" className={link}>Inbox</a> for you to confirm. No history yet? Tell your agent
          “record a miss: …” and it reports one there.
        </>
      ),
    },
    {
      key: 'lesson',
      title: 'Approve your first lesson',
      done: (own?.approved ?? 0) > 0,
      next: <>Each confirmed miss gets a post-mortem that proposes a lesson in <a href="#lessons" className={link}>Lessons</a>. Approve it, and your agent gets it with its next task.</>,
    },
  ];
}

/**
 * A fresh install's next step, on the Dashboard until every step is done: each step is one line, and only the next one
 * says how, so the list stays short on a phone. The Dashboard's status poll brings the agent's first call.
 */
export function GettingStarted({ status, pipeline }: { status: SystemStatus | null; pipeline: PipelineStatus | null }) {
  if (!status || !pipeline) return null;
  const steps = gettingStartedSteps(status, pipeline);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done)!;
  return (
    <Card level="h2" title="Getting started" actions={<span className="text-xs text-muted tabular-nums">{done} of {steps.length} done</span>}>
      <ol className="grid gap-1 p-3 text-[13px]">
        {steps.map((s, i) => (
          <li key={s.key} aria-current={s === next ? 'step' : undefined} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
            <span aria-hidden="true" className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${s.done ? 'bg-ok-soft text-ok-text' : s === next ? 'bg-accent text-accent-ink' : 'bg-sunken text-muted'}`}>
              {s.done ? '✓' : i + 1}
            </span>
            <span className={s.done ? 'text-muted line-through decoration-line-strong' : s === next ? 'font-semibold' : 'text-muted'}>
              {s.title}
              <span className="sr-only">{s.done ? ' (done)' : s === next ? ' (next)' : ''}</span>
            </span>
            {s === next && <div className="col-start-2 mt-0.5 mb-1 text-muted">{s.next}</div>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
