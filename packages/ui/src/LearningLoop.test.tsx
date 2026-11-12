import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Decision, LoopEvent, LoopEventPage, LoopState } from './api.ts';
import { LearningLoop, LoopCard } from './LearningLoop.tsx';
import { OwnerWrites, READ_ONLY_TITLE } from './ownerAccess.tsx';
import { decisions, event, loopState, track } from './testing/loop.ts';

vi.setConfig({ testTimeout: 30_000 });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let state: LoopState;
let recent: Decision[];
/** What each events poll answers, in turn; the last one repeats. A string throws (no answer) or a number is that status. */
let pages: (LoopEventPage | 'down' | number)[];
let routes: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls = [];
  state = loopState();
  recent = decisions;
  pages = [{ events: [event(1), event(2, { kind: 'decision_made', decisionId: null, subject: 'proposed approving a lesson' })], next: '2', gap: false }];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const path = url.split('?')[0];
    if (routes[`${method} ${path}`]) return routes[`${method} ${path}`](body);
    if (path === '/api/loop/events') {
      const p = pages.length > 1 ? pages.shift()! : pages[0];
      if (p === 'down') throw new TypeError('Failed to fetch');
      if (typeof p === 'number') return Response.json({ error: 'events refused' }, { status: p });
      return Response.json(p);
    }
    if (path === '/api/loop') return Response.json(state);
    if (path === '/api/loop/pause') { state = { ...state, paused: { at: '2026-11-10T10:00:00Z', by: 'you' }, effectiveMode: 'off', capped: 'paused' }; return Response.json(state); }
    if (path === '/api/loop/resume') { state = { ...state, paused: null, effectiveMode: 'auto', capped: null }; return Response.json(state); }
    if (path === '/api/loop/settings') { state = { ...state, ...(body as Partial<LoopState>) }; return Response.json(state); }
    if (path === '/api/decisions') return Response.json(recent);
    if (path.startsWith('/api/loop/lessons/')) return Response.json(track);
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const eventsCalls = () => calls.filter((c) => c.url.startsWith('/api/loop/events')).map((c) => c.url);
const log = () => screen.getByRole('log', { name: 'loop events' });

test('shows the mode, this round, every type with its bar and record, calibration, recent decisions and the holdout', async () => {
  render(<LearningLoop pollMs={60_000} />);
  expect(await screen.findByLabelText('Running as')).toBeTruthy();
  expect(screen.getByLabelText('Waiting for you').textContent).toMatch(/3proposals in Decisions/);
  expect(screen.getByLabelText('Applied this week').textContent).toMatch(/9.*5 proposed, 4 observed/);
  expect(screen.getByLabelText('Rolled back').textContent).toMatch(/8%.*1 of 12 \(8%\)/);
  expect(screen.getByLabelText('Model budget today').textContent).toMatch(/7\/40.*auto-applied 1\/5/);

  const round = screen.getByRole('region', { name: 'This round' });
  expect(within(round).getByText('scoring')).toBeTruthy();
  expect(within(round).getByRole('progressbar', { name: 'targets scored' }).getAttribute('aria-valuenow')).toBe('30');
  expect(within(round).getByText(/owner touched \(2\), suppressed \(1\)/)).toBeTruthy();

  const table = within(screen.getByRole('region', { name: 'decision types table' }));
  expect(table.getByText('agent-facing')).toBeTruthy();
  expect(table.getByText(/raised from 0\.90/)).toBeTruthy();
  expect(table.getAllByText('(global)').length).toBe(2);
  expect(table.getByText(/tripped/).getAttribute('title')).toBe('2 rollbacks in 7 days');
  expect(table.getByText('none yet')).toBeTruthy();

  expect(screen.getByRole('img', { name: /^retire lesson: p 0\.90 \(lower 0\.82\), earned from 40 of your reviews; bar τ 0\.85, not cleared$/ })).toBeTruthy();
  fireEvent.click(screen.getAllByText('By confidence band')[0]);
  expect(within(screen.getByRole('region', { name: 'retire lesson bands' })).getByText('5 of 5')).toBeTruthy();

  const recentCard = screen.getByRole('region', { name: 'Recent decisions' });
  expect(within(recentCard).getAllByRole('link').map((a) => a.getAttribute('href'))).toContain('#decisions/dec%3Aproposed');
  const holdout = within(screen.getByRole('region', { name: 'holdout comparison table' }));
  expect(holdout.getByText('may be changed by the loop')).toBeTruthy();
  expect(holdout.getByText('28%–53%')).toBeTruthy();
  expect(screen.getByText(/Policy v1\./)).toBeTruthy();
});

test('a type whose earned lower bound clears its bar says so', async () => {
  state = loopState({ types: [{ ...loopState().types[0], calibration: { p: 0.97, lower: 0.9, n: 60 } }] });
  render(<LearningLoop pollMs={60_000} />);
  expect(await screen.findByRole('img', { name: /retire lesson: .* cleared$/ })).toBeTruthy();
});

test('events stream in, newest first; new ones reload the totals; an outage keeps the cursor and says so until it answers', async () => {
  pages = [
    { events: [event(1), event(2, { kind: 'decision_made', decisionId: null, subject: 'proposed approving a lesson' })], next: '2', gap: false },
    { events: [], next: '2', gap: false },
    'down',
    'down',
    { events: [event(3, { kind: 'loop_dreamed' as LoopEvent['kind'], subject: 'a kind this page does not know', decisionId: null })], next: '3', gap: false },
    { events: [], next: '3', gap: false },
  ];
  render(<LearningLoop pollMs={150} statePollMs={60_000} />);
  await within(log()).findByText('proposed approving a lesson');
  expect(within(log()).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    expect.stringMatching(/decision made.*proposed approving a lesson/), expect.stringMatching(/applied.*retired lesson 1/),
  ]);
  expect(within(log()).getByRole('link', { name: 'retired lesson 1' }).getAttribute('href')).toBe('#decisions/dec%3Aapplied');
  expect(await screen.findByText(/The API is not answering \(it may be restarting\); retrying\. Events since/)).toBeTruthy();
  expect(screen.getByText('reconnecting')).toBeTruthy();
  expect(await within(log()).findByText('a kind this page does not know')).toBeTruthy();
  expect(within(log()).getByText('loop dreamed')).toBeTruthy();
  expect(await screen.findByText('live')).toBeTruthy();
  expect(eventsCalls().slice(0, 5)).toEqual(['/api/loop/events', '/api/loop/events?after=2', '/api/loop/events?after=2', '/api/loop/events?after=2', '/api/loop/events?after=2']);
  await waitFor(() => expect(eventsCalls()).toContain('/api/loop/events?after=3'));
  // The state loaded once at first and again when the new event came.
  expect(calls.filter((c) => c.url === '/api/loop').length).toBe(2);
});

test('an answer that comes after leaving the page is dropped', async () => {
  let answer!: (r: Response) => void;
  let fail!: (e: Error) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => (url.startsWith('/api/loop/events') ? new Promise<Response>((res, rej) => { answer = res; fail = rej; }) : Promise.resolve(Response.json(state)))));
  const first = render(<LearningLoop pollMs={60_000} />);
  first.unmount();
  answer(Response.json(pages[0]));
  render(<LearningLoop pollMs={60_000} />).unmount();
  fail(new TypeError('Failed to fetch'));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).toBe('');
});

test('a refused events request shows the reason; a gap says events were missed and can be dismissed', async () => {
  pages = [{ events: [], next: '0', gap: false }, 400, { events: [], next: '9', gap: true }, { events: [], next: '9', gap: false }];
  render(<LearningLoop pollMs={30} statePollMs={60_000} />);
  expect(await screen.findByText('Nothing yet. Events appear here as the worker records them.')).toBeTruthy();
  expect(await screen.findByText(/events refused/)).toBeTruthy();
  expect(await screen.findByText(/Some events were missed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText(/Some events were missed/)).toBeNull();
});

test('before the API answers at all the stream says it is waiting', async () => {
  pages = ['down'];
  render(<LearningLoop pollMs={60_000} />);
  expect(screen.getByText('connecting…')).toBeTruthy();
  expect(await screen.findByText('Waiting for the API…')).toBeTruthy();
});

test('Pause and Resume take effect at once; the mode is saved as you pick it', async () => {
  render(<LearningLoop pollMs={60_000} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause learning' }));
  expect(await screen.findByText(/Paused by you .*: nothing is applied until you resume\./)).toBeTruthy();
  expect(screen.getByLabelText('Running as').textContent).toMatch(/^Running asoff/);
  fireEvent.click(screen.getByRole('button', { name: 'Resume learning' }));
  await waitFor(() => expect(screen.queryByText(/Paused by you/)).toBeNull());
  fireEvent.change(screen.getByLabelText('loop mode'), { target: { value: 'observe' } });
  await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ mode: 'observe' }));
  expect(((await screen.findByLabelText('loop mode')) as HTMLSelectElement).value).toBe('observe');

  routes['POST /api/loop/pause'] = () => Response.json({ error: 'the store is read-only' }, { status: 409 });
  routes['PUT /api/loop/settings'] = () => Response.json({ error: 'mode refused' }, { status: 400 });
  fireEvent.click(screen.getByRole('button', { name: 'Pause learning' }));
  expect(await screen.findByText('the store is read-only')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('loop mode'), { target: { value: 'off' } });
  expect(await screen.findByText('mode refused')).toBeTruthy();
});

test('says why it runs below its mode: LOOP_DISABLED, or a tokenless install', async () => {
  state = loopState({ disabled: true, effectiveMode: 'off', capped: 'disabled' });
  render(<LearningLoop pollMs={60_000} />);
  expect(await screen.findByText(/LOOP_DISABLED is set in \.env: nothing runs/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Pause learning' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('loop mode') as HTMLSelectElement).disabled).toBe(true);
  cleanup();
  state = loopState({ effectiveMode: 'observe', capped: 'tokenless' });
  render(<LearningLoop pollMs={60_000} />);
  expect(await screen.findByText(/no owner token, so the loop only observes/)).toBeTruthy();
});

test('a failed state load says so, and a failed refresh keeps the last state', async () => {
  routes['GET /api/loop'] = () => Response.json({ error: 'loop store down' }, { status: 503 });
  render(<LearningLoop pollMs={60_000} statePollMs={30} />);
  expect(await screen.findByText("Could not load the loop's state: loop store down")).toBeTruthy();
  delete routes['GET /api/loop'];
  expect(await screen.findByLabelText('Running as')).toBeTruthy();
  routes['GET /api/loop'] = () => Response.json({ error: 'loop store down' }, { status: 503 });
  expect(await screen.findByText("Could not refresh the loop's state (showing the last one): loop store down")).toBeTruthy();
  expect(screen.getByLabelText('Running as')).toBeTruthy();
});

test('a lesson’s track record: served, judged, gap fixed, repeat, and the timeline behind them', async () => {
  render(<LearningLoop pollMs={60_000} />);
  expect(await screen.findByText('Pick a lesson from a recent decision, or type its id.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('region', { name: 'Recent decisions' })).getAllByRole('button', { name: 'Track record' })[0]);
  const steps = await screen.findByRole('list', { name: 'track record' });
  expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'served22in 9 sessions',
    'judged141 addressed, 0 gaps caught, 12 not applicable, 1 cannot tell',
    'gap fixed0a gap caught, then addressed in the same session',
    'repeat00 while served, 0 while not served',
  ]);
  expect(calls.at(-1)!.url).toBe('/api/loop/lessons/lesson%3Ademo-shop%3A1/track');
  expect(screen.getByRole('link', { name: 'Validate cart totals on the server' }).getAttribute('href')).toBe('#lessons/lesson%3Ademo-shop%3A1');
  expect(screen.getByRole('link', { name: 'decision' }).getAttribute('href')).toBe('#decisions/dec%3Aapplied');
  expect(screen.getByRole('link', { name: 'session' }).getAttribute('href')).toBe('#sessions/sess-1');
  expect(screen.getByText(/last served/)).toBeTruthy();

  routes['GET /api/loop/lessons/l-held/track'] = () => Response.json({ ...track, lessonId: 'l-held', projectKey: null, timeline: [], signals: { ...track.signals, holdout: true, lastServed: null } });
  fireEvent.change(screen.getByLabelText('lesson id'), { target: { value: ' l-held ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  expect(await screen.findByText('held out')).toBeTruthy();
  expect(screen.getByText('global')).toBeTruthy();
  expect(screen.queryByText(/last served/)).toBeNull();

  routes['GET /api/loop/lessons/nope/track'] = () => Response.json({ error: 'no such lesson' }, { status: 404 });
  fireEvent.change(screen.getByLabelText('lesson id'), { target: { value: 'nope' } });
  fireEvent.submit(screen.getByLabelText('lesson id').closest('form')!);
  expect(await screen.findByText('no such lesson')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('lesson id'), { target: { value: '  ' } });
  fireEvent.submit(screen.getByLabelText('lesson id').closest('form')!);
  expect(screen.getByText('no such lesson')).toBeTruthy();
});

test('before the first round, decision or holdout, each section says what it waits for', async () => {
  state = loopState({ round: null, holdout: null, types: [] });
  recent = [];
  render(<LearningLoop pollMs={60_000} />);
  expect(await screen.findByText('The worker has not run a round yet.')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Last round' })).toBeTruthy();
  expect(screen.getByText('No decisions yet')).toBeTruthy();
  expect(screen.getByText(/No comparison yet/)).toBeTruthy();
});

test('a finished or stopped round says how it ended', async () => {
  const base = loopState().round!;
  state = loopState({ round: { ...base, finishedAt: '2026-11-10T10:00:00Z', phase: 'aborted', error: 'store timed out', skipped: [] } });
  render(<LearningLoop pollMs={60_000} />);
  const round = await screen.findByRole('region', { name: 'Last round' });
  expect(within(round).getByText('aborted')).toBeTruthy();
  expect(within(round).getByText('The round stopped: store timed out')).toBeTruthy();
  expect(within(round).queryByRole('progressbar')).toBeNull();
  expect(within(round).getByText(/finished/)).toBeTruthy();
  cleanup();
  state = loopState({ round: { ...base, finishedAt: '2026-11-10T10:00:00Z', phase: 'done' } });
  render(<LearningLoop pollMs={60_000} />);
  expect(await within(await screen.findByRole('region', { name: 'Last round' })).findByText('done')).toBeTruthy();
  cleanup();
  state = loopState({ round: { ...base, targetsTotal: 0, targetsScored: 0 }, rollbackRate: { rolledBack: 0, of: 0 } });
  render(<LearningLoop pollMs={60_000} />);
  expect((await screen.findByRole('progressbar')).getAttribute('aria-valuemax')).toBe('0');
  expect(screen.getByLabelText('Rolled back').textContent).toMatch(/–none yet/);
  cleanup();
  state = loopState({ round: { ...base, targetsTotal: null } });
  render(<LearningLoop pollMs={60_000} />);
  await screen.findByRole('region', { name: 'This round' });
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('read-only installs watch, and cannot pause or change the mode', async () => {
  render(<OwnerWrites.Provider value={false}><LearningLoop pollMs={60_000} /></OwnerWrites.Provider>);
  const pause = (await screen.findByRole('button', { name: 'Pause learning' })) as HTMLButtonElement;
  expect(pause.disabled).toBe(true);
  expect(pause.title).toBe(READ_ONLY_TITLE);
  const mode = screen.getByLabelText('loop mode') as HTMLSelectElement;
  expect(mode.disabled).toBe(true);
  expect(mode.title).toBe(READ_ONLY_TITLE);
});

test('the Dashboard card: this week, the rollback rate, the budget and Pause', async () => {
  render(<LoopCard />);
  const card = await screen.findByRole('region', { name: 'Learning loop' });
  expect(await within(card).findByText(/9 applied, 5 proposed/)).toBeTruthy();
  expect(within(card).getByRole('link', { name: '3 waiting' }).getAttribute('href')).toBe('#decisions');
  expect(within(card).getByText(/model calls today 7 of 40/)).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: 'Pause learning' }));
  expect(await within(card).findByText(/\(set to auto\)/)).toBeTruthy();
  expect(within(card).getByText(/Paused by you/)).toBeTruthy();
});

test('the Dashboard card is absent on an API without the loop, and says so when the loop fails', async () => {
  routes['GET /api/loop'] = () => Response.json({ error: 'not found' }, { status: 404 });
  const { container } = render(<LoopCard />);
  await waitFor(() => expect(calls).toHaveLength(1));
  await waitFor(() => expect(container.innerHTML).toBe(''));
  cleanup();
  routes['GET /api/loop'] = () => Response.json({ error: 'loop store down' }, { status: 503 });
  render(<LoopCard />);
  expect(screen.getByRole('region', { name: 'Learning loop' })).toBeTruthy();
  expect(await screen.findByText('loop store down')).toBeTruthy();
});

test('a mode this build does not know (a newer server\'s) reads as unknown in the header select, never as "off"', async () => {
  state = loopState({ mode: 'shadow' as LoopState['mode'], effectiveMode: 'shadow' as LoopState['mode'] });
  render(<LearningLoop pollMs={60_000} />);
  const select = (await screen.findByLabelText('loop mode')) as HTMLSelectElement;
  expect(select.value).toBe('shadow');
  expect(select.selectedOptions[0].textContent).toBe('mode: unknown (shadow)');
});

test('a round streamed while running and again when done keeps one row per round in Live', async () => {
  const round = (seq: number, subject: string) => event(seq, { seq: `r:${seq}`, kind: 'loop_round', subject, decisionId: null, decisionType: null, status: null, projectKey: null });
  pages = [
    { events: [round(25, 'round done: 4 of 4 scored, 0 observed, 0 proposed, 1 applied, 0 skipped')], next: '25', gap: false },
    { events: [round(26, 'round scoring: 0 of 6 scored, 0 observed, 0 proposed, 0 applied, 0 skipped')], next: '26', gap: false },
    { events: [round(28, 'round done: 6 of 6 scored, 1 observed, 0 proposed, 0 applied, 2 skipped')], next: '28', gap: false },
    { events: [], next: '28', gap: false },
  ];
  render(<LearningLoop pollMs={30} statePollMs={60_000} />);
  await within(log()).findByText(/round done: 6 of 6/);
  expect(within(log()).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/round done: 6 of 6/), expect.stringMatching(/round done: 4 of 4/)]);
});
