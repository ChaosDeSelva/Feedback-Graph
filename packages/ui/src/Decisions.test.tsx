import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOOP_CHANGED_EVENT, type Decision, type DecisionDetail } from './api.ts';
import { Decisions, LessonDecisions } from './Decisions.tsx';
import { OwnerWrites, READ_ONLY_TITLE } from './ownerAccess.tsx';
import { decision, decisions, detail } from './testing/loop.ts';

// Many renders per test, on a machine that may be busy.
vi.setConfig({ testTimeout: 30_000 });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let list: Decision[];
let details: Record<string, DecisionDetail>;
/** Per-path overrides: a Response, or a function of the request. */
let routes: Record<string, (body: unknown, url: string) => Response | Promise<Response>>;

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url.startsWith(path));

beforeEach(() => {
  location.hash = '#decisions';
  calls = [];
  list = decisions.map((d) => ({ ...d }));
  details = Object.fromEntries(list.map((d) => [d.id, detail(d)]));
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const path = url.split('?')[0];
    const route = routes[`${method} ${path}`] ?? routes[path];
    if (route) return route(body, url);
    if (path === '/api/decisions') {
      const q = new URLSearchParams(url.split('?')[1]);
      const rows = list.filter((d) => (!q.get('status') || d.status === q.get('status')) && (!q.get('type') || d.type === q.get('type')));
      return Response.json(rows);
    }
    const m = path.match(/^\/api\/decisions\/([^/]+)(?:\/(\w+))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!m[2]) return details[id] ? Response.json(details[id]) : Response.json({ error: 'not found' }, { status: 404 });
      if (m[2] === 'notes') {
        const note = { id: `dnote:${calls.length}`, decisionId: id, ts: '2026-11-10T10:00:00Z', by: 'you', ...body };
        details[id] = { ...details[id], notes: [...details[id].notes, note] };
        return Response.json(note, { status: 201 });
      }
      if (m[2] === 'rollback' && body.cascade === 'preview') return Response.json({ cascade: details[id].dependents, blocked: [] });
      const status = { approve: 'applied', reject: 'rejected', keep: 'applied', rollback: 'rolled_back' }[m[2]] as Decision['status'];
      const d = { ...details[id].decision, status, ...(m[2] === 'keep' && { ratifiedAt: '2026-11-10T10:00:00Z', ratifiedBy: 'you' }) };
      details[id] = { ...details[id], decision: d };
      list = list.map((x) => (x.id === id ? d : x));
      return Response.json(d);
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', location.pathname); });

const pane = () => screen.getByRole('region', { name: 'item detail' });
const listBox = () => screen.getByRole('region', { name: 'decisions list' });
const read = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.readAsText(b); });
const key = async (k: string, o: KeyboardEventInit = {}) => { fireEvent.keyDown(window, { key: k, ...o }); };

test('opens on the proposals waiting for you, with the decision, its diff, evidence, rationale, links and notes', async () => {
  render(<Decisions />);
  expect(await within(pane()).findByRole('heading', { name: 'approve lesson · lesson:demo-shop:1' })).toBeTruthy();
  expect(calls[0].url).toBe('/api/decisions?status=proposed&limit=100');
  expect(within(screen.getByRole('list', { name: 'about this decision' })).getAllByRole('listitem').map((li) => li.textContent).slice(0, 2)).toEqual(['p 0.71 (lower 0.52), earned from 12 of your reviews', 'band 3 of 5']);
  const diff = within(pane()).getByRole('table');
  expect(within(diff).getByText('approved')).toBeTruthy();
  expect(within(diff).getByText('revoked')).toBeTruthy();
  expect(within(diff).queryByText('now')).toBeNull();
  // The target heads its fields once.
  expect(within(diff).getAllByRole('columnheader', { name: 'lesson:demo-shop:1' })).toHaveLength(1);
  expect(screen.getByText(/Model/).textContent).toMatch(/ollama:gemma4 · policy v1 · score 0\.91/);
  expect(screen.getByRole('link', { name: 'Validate cart totals on the server' }).getAttribute('href')).toBe('#lessons/lesson%3Ademo-shop%3A1');
  expect(screen.getByRole('link', { name: 'Refactor checkout' }).getAttribute('href')).toBe('#sessions/sess-1');
  expect(screen.getByRole('link', { name: 'missed the server check' }).getAttribute('href')).toBe('#inbox/fb%3A2');
  expect(screen.getByRole('link', { name: 'Totals live in cart.ts' }).getAttribute('href')).toBe('#projects/demo-shop/src%2Fcart.ts');
  expect(screen.getByText('judge said generic (no longer exists)')).toBeTruthy();
  expect(screen.getByText('checked 3 lessons')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'ranking weight · lesson:demo-shop:2' }).getAttribute('href')).toBe('#decisions/dec%3Alater');
  expect(screen.getByText('Nothing: it stands on its own.')).toBeTruthy();
  expect(screen.getByText('Right call for this one.')).toBeTruthy();
  fireEvent.click(screen.getByText('Features it scored'));
  expect(screen.getByText('notApplicableShare')).toBeTruthy();
});

test('approve sends the status it saw, the decision leaves the proposals, and the sidebar badge is told', async () => {
  const changed = vi.fn();
  window.addEventListener(LOOP_CHANGED_EVENT, changed);
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
  await waitFor(() => expect(posts('/api/decisions/dec%3Aproposed/approve')).toEqual([{ url: '/api/decisions/dec%3Aproposed/approve', method: 'POST', body: { expect: 'proposed' } }]));
  expect(await screen.findByText('Nothing waiting for you')).toBeTruthy();
  expect(changed).toHaveBeenCalled();
  await key('a'); // nothing left to approve
  expect(posts('/api/decisions')).toHaveLength(1);
  window.removeEventListener(LOOP_CHANGED_EVENT, changed);
});

test('Approve and Reject take a note, and Reject a reason, in the same step; both are cleared for the next decision', async () => {
  list = [...list, { ...list[0], id: 'dec:proposed2' }];
  details['dec:proposed2'] = detail({ ...list[0], id: 'dec:proposed2' });
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'the evidence holds' } });
  fireEvent.change(screen.getByLabelText('Reason to reject'), { target: { value: 'too_broad' } });
  fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
  await waitFor(() => expect(posts('/api/decisions/dec%3Aproposed/reject')[0]?.body).toEqual({ expect: 'proposed', note: 'the evidence holds', reason: 'too_broad' }));
  await waitFor(() => expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe(''));
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'right call' } });
  fireEvent.change(screen.getByLabelText('Reason to reject'), { target: { value: 'wording' } });
  fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
  // A reason goes with a reject only.
  await waitFor(() => expect(posts('/api/decisions/dec%3Aproposed2/approve')[0]?.body).toEqual({ expect: 'proposed', note: 'right call' }));
});

test('proposals your own changes expired lately are announced above the list, with a way to show them', async () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  routes['/api/activity'] = () => Response.json([
    { id: 'a1', ts: recent, kind: 'decision_made', actor: 'you', projectKey: 'demo', subject: 's', why: 'w', details: { action: 'expired_by_you', expired: 22 }, targets: [] },
    { id: 'a2', ts: '2020-01-01T00:00:00Z', kind: 'decision_made', actor: 'you', projectKey: 'demo', subject: 's', why: 'w', details: { action: 'expired_by_you', expired: 5 }, targets: [] },
  ]);
  render(<Decisions />);
  expect(await screen.findByText(/22 waiting proposals expired in the last 7 days: you decided their targets yourself/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show expired' }));
  await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/decisions?') && c.url.includes('status=expired'))).toBe(true));
});

test('every status is listed on request; an applied decision is kept or rolled back, an observed one approved or rejected', async () => {
  location.hash = '#decisions?status=all';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  expect(within(listBox()).getAllByRole('button').length).toBe(5);
  fireEvent.click(within(listBox()).getAllByRole('button')[1]);
  await within(pane()).findByRole('heading', { name: 'retire lesson · lesson:demo-shop:1' });
  expect(within(pane()).getByText('by loop')).toBeTruthy();
  expect(within(pane()).getByText('housekeeping')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  await waitFor(() => expect(posts('/api/decisions/dec%3Aapplied/keep')).toHaveLength(1));
  expect(await screen.findByText(/Kept by you/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
  // Still in the list: it shows every status.
  expect(within(listBox()).getAllByRole('button').length).toBe(5);
  fireEvent.click(within(listBox()).getByText(/Two misses/));
  await within(pane()).findByRole('heading', { name: 'link misses · miss:fb:2' });
  expect(screen.getByText(/records no snapshot/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
  await waitFor(() => expect(posts('/api/decisions/dec%3Aobserved/reject')).toHaveLength(1));
});

test('j and k move, a approves, x rejects and u opens the rollback; never from a field or with a modifier', async () => {
  location.hash = '#decisions?status=all';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  await key('a', { metaKey: true });
  await key('x', { repeat: true });
  expect(posts('/api/decisions')).toHaveLength(0);
  const search = screen.getByLabelText('search rationale and targets');
  fireEvent.keyDown(search, { key: 'j' });
  await key('k');
  await key('j');
  expect(await within(pane()).findByRole('heading', { name: /retire lesson/ })).toBeTruthy();
  await key('u');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('ranking weight · lesson:demo-shop:2');
  expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('Roll back retire lesson · lesson:demo-shop:1?');
  // Keys never act behind the dialog.
  fireEvent.keyDown(dialog, { key: 'j' });
  await key('j');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await key('j');
  await within(pane()).findByRole('heading', { name: /link misses/ });
  await key('x');
  await waitFor(() => expect(posts('/api/decisions/dec%3Aobserved/reject')).toHaveLength(1));
  await key('k');
  await key('k');
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  await key('u'); // not applied: nothing opens
  expect(screen.queryByRole('dialog')).toBeNull();
  // Twice before the answer: one decision.
  fireEvent.keyDown(window, { key: 'a' });
  fireEvent.keyDown(window, { key: 'a' });
  await waitFor(() => expect(posts('/api/decisions/dec%3Aproposed/approve')).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy());
  expect(posts('/api/decisions/dec%3Aproposed/approve')).toHaveLength(1);
});

test('a rollback previews the cascade, takes a reason and a note, and rolls everything back together', async () => {
  location.hash = '#decisions/dec%3Aapplied';
  render(<Decisions />);
  expect(await within(pane()).findByRole('heading', { name: /retire lesson/ })).toBeTruthy();
  expect((screen.getByLabelText('status') as HTMLSelectElement).value).toBe('applied');
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('ranking weight · lesson:demo-shop:2')).toBeTruthy();
  expect(document.activeElement?.textContent).toBe('Cancel');
  fireEvent.change(within(dialog).getByLabelText('rollback reason'), { target: { value: 'too_broad' } });
  fireEvent.change(within(dialog).getByLabelText('rollback note'), { target: { value: ' only for checkout ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back 2 decisions' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(posts('/api/decisions/dec%3Aapplied/rollback').map((c) => c.body)).toEqual([
    { expect: 'applied', cascade: 'preview' },
    { expect: 'applied', cascade: 'apply', reason: 'too_broad', note: 'only for checkout' },
  ]);
  // It left the "applied" list.
  expect(await screen.findByText('No decisions match')).toBeTruthy();
});

test('a blocked cascade cannot be confirmed; a target you changed since turns into a three-way diff with Restore anyway', async () => {
  location.hash = '#decisions?status=applied';
  routes['POST /api/decisions/dec%3Aapplied/rollback'] = (body) => {
    if ((body as { cascade: string }).cascade === 'preview') return Response.json({ cascade: details['dec:applied'].dependents, blocked: [{ id: 'dec:later', reason: 'you edited lesson:demo-shop:2' }, { id: 'dec:gone', reason: 'it is not applied' }] });
    return Response.json({ error: 'changed' }, { status: 409 });
  };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  const dialog = await screen.findByRole('dialog');
  // A decision the preview does not list reads as words, its id only on hover.
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('It cannot be rolled back: ranking weight · lesson:demo-shop:2: you edited lesson:demo-shop:2; a later decision: it is not applied'));
  expect(within(dialog).getByText('a later decision').title).toBe('dec:gone');
  expect((within(dialog).getByRole('button', { name: 'Roll back' }) as HTMLButtonElement).disabled).toBe(true);
  // Nothing to explain for a rollback that cannot happen.
  expect(within(dialog).queryByLabelText('rollback reason')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  // Not blocked, but the lesson changed under it: the API refuses and marks it overridden.
  routes['POST /api/decisions/dec%3Aapplied/rollback'] = (body) => {
    if ((body as { cascade: string }).cascade === 'preview') return Response.json({ cascade: [], blocked: [] });
    const d = { ...details['dec:applied'].decision, status: 'overridden' as const };
    details['dec:applied'] = detail(d);
    return Response.json({ error: 'You changed lesson:demo-shop:1 after this decision.' }, { status: 409 });
  };
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  const again = await screen.findByRole('dialog');
  fireEvent.click(await within(again).findByRole('button', { name: 'Roll back' }));
  expect(await within(again).findByText('You changed lesson:demo-shop:1 after this decision.')).toBeTruthy();
  list = list.map((x) => (x.id === 'dec:applied' ? details['dec:applied'].decision : x));
  fireEvent.click(within(again).getByRole('button', { name: 'Show what changed' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // Overridden is not "applied": the list follows it to its new status, and it stays open as it is now.
  await waitFor(() => expect((screen.getByLabelText('status') as HTMLSelectElement).value).toBe('overridden'));
  expect(await within(pane()).findByRole('button', { name: 'Restore anyway' })).toBeTruthy();
  expect(within(pane()).getByRole('heading', { name: /retire lesson/ })).toBeTruthy();
});

test('an overridden decision shows before, after and now, and Restore anyway writes before over your change', async () => {
  location.hash = '#decisions?status=overridden';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /reword lesson/ });
  expect(screen.getByRole('note').textContent).toMatch(/A target changed after the loop applied this/);
  const table = within(pane()).getByRole('table');
  expect(within(table).getByText('now')).toBeTruthy();
  expect(within(table).getByText('Validate totals server-side (edited by you)')).toBeTruthy();
  // The title changed only since: before and after are plain (nothing struck out or inserted), and now is marked.
  expect(within(table).getByText('changed since').previousElementSibling!.textContent).toBe('Validate totals server-side (edited by you)');
  expect(within(table).getAllByText('Validate cart totals on the server').map((e) => e.tagName)).toEqual(['TD', 'TD']);
  expect(within(table).getAllByText('changed since')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Restore anyway' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByText('Checking what else depends on it…')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restore anyway' }));
  await waitFor(() => expect(posts('/api/decisions/dec%3Aover/rollback').map((c) => c.body)).toEqual([{ expect: 'overridden', cascade: 'apply', restoreAnyway: true }]));
});

test('a rollback the API cannot preview says why and stays open', async () => {
  location.hash = '#decisions?status=applied';
  routes['POST /api/decisions/dec%3Aapplied/rollback'] = () => Response.json({ error: 'only applied decisions roll back' }, { status: 400 });
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('only applied decisions roll back')).toBeTruthy();
  fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('a target gone since reads as gone in the now column', async () => {
  location.hash = '#decisions?status=overridden';
  details['dec:over'] = { ...detail(list.find((d) => d.id === 'dec:over')!), current: [] };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /reword lesson/ });
  expect(within(within(pane()).getByRole('table')).getAllByText('gone').length).toBeGreaterThan(0);
});

test('a note says agree or disagree, with a reason for disagreeing, and shows in the thread', async () => {
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.click(screen.getByRole('button', { name: 'Write a note' }));
  expect(document.activeElement).toBe(screen.getByLabelText('note'));
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'Too broad: only checkout needs it' } });
  fireEvent.click(screen.getByLabelText('Disagree'));
  fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'too_broad' } });
  fireEvent.submit(screen.getByLabelText('note').closest('form')!);
  await waitFor(() => expect(posts('/api/decisions/dec%3Aproposed/notes').map((c) => c.body)).toEqual([{ text: 'Too broad: only checkout needs it', verdict: 'disagree', reason: 'too_broad' }]));
  expect(await screen.findByText('Too broad: only checkout needs it')).toBeTruthy();
  expect(screen.getByText('too broad', { ignore: 'option' })).toBeTruthy();
  expect((screen.getByLabelText('note') as HTMLTextAreaElement).value).toBe('');

  routes['POST /api/decisions/dec%3Aproposed/notes'] = () => Response.json({ error: 'note too long' }, { status: 400 });
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'again' } });
  fireEvent.click(screen.getByLabelText('Agree'));
  fireEvent.submit(screen.getByLabelText('note').closest('form')!);
  expect(await screen.findByText('note too long')).toBeTruthy();
});

test('filters go to the API and into the address; clearing them brings the list back', async () => {
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.change(screen.getByLabelText('status'), { target: { value: 'all' } });
  fireEvent.change(screen.getByLabelText('type'), { target: { value: 'retire_lesson' } });
  // The rarer filters are folded away until asked for.
  expect(screen.queryByLabelText('applied or proposed')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
  fireEvent.change(screen.getByLabelText('applied or proposed'), { target: { value: 'auto' } });
  fireEvent.change(screen.getByLabelText('confidence band'), { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'demo-shop ' } });
  fireEvent.change(screen.getByLabelText('from date'), { target: { value: '2026-11-01' } });
  fireEvent.change(screen.getByLabelText('to date'), { target: { value: '2026-11-09' } });
  const target = screen.getByLabelText('target id');
  fireEvent.change(target, { target: { value: ' lesson:demo-shop:1 ' } });
  fireEvent.keyDown(target, { key: 'Enter' });
  fireEvent.keyDown(target, { key: 'a' });
  const q = screen.getByLabelText('search rationale and targets');
  fireEvent.change(q, { target: { value: 'gap' } });
  fireEvent.blur(q);
  fireEvent.keyDown(q, { key: 'Enter' });
  await waitFor(() => {
    const last = new URLSearchParams(calls.filter((c) => c.url.startsWith('/api/decisions?')).at(-1)!.url.split('?')[1]);
    expect(Object.fromEntries(last)).toEqual({
      type: 'retire_lesson', project: 'demo-shop', mode: 'auto', band: '4', target: 'lesson:demo-shop:1', q: 'gap', limit: '100',
      since: new Date('2026-11-01T00:00:00').toISOString(), until: new Date('2026-11-10T00:00:00').toISOString(),
    });
  });
  expect(location.hash).toMatch(/^#decisions\?status=all&type=retire_lesson/);
  fireEvent.blur(target);
  fireEvent.click(screen.getByRole('button', { name: 'Fewer filters' }));
  expect(screen.queryByLabelText('target id')).toBeNull();
  expect(screen.getByRole('button', { name: 'More filters (6)' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'More filters (6)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(calls.at(-1)!.url).toBe('/api/decisions?limit=100'));
  expect((screen.getByLabelText('target id') as HTMLInputElement).value).toBe('');
});

test('filters from a link are read back, and values this build does not know are dropped', async () => {
  location.hash = '#decisions?status=sideways&type=dream_up&mode=auto&band=9&project=shop&q=x&target=t&since=2026-11-01&until=2026-11-02';
  render(<Decisions />);
  await waitFor(() => expect(calls[0].url).toMatch(/^\/api\/decisions\?status=proposed&project=shop&mode=auto&target=t&since=.*&until=.*&q=x&limit=100$/));
  // A link that sets a folded filter opens them, so none applies out of sight.
  expect((screen.getByLabelText('project') as HTMLInputElement).value).toBe('shop');
});

test('values this build does not know (a newer type or status) read as themselves', async () => {
  list = [decision('dec:new', { type: 'dream_up' as Decision['type'], status: 'pondering' as Decision['status'], tier: 'Z' as Decision['tier'], projectKey: null, targets: [], rollback: { at: '2026-11-10T08:00:00Z', by: 'you', reason: 'bored' as never, note: null, cascade: [] } })];
  const at = '2026-11-10T08:00:00Z';
  details = { 'dec:new': { ...detail(list[0]), notes: [{ id: 'n', decisionId: 'dec:new', ts: at, by: 'operator:bot', text: 'hm', reason: 'meh' as never }], evidence: [
    { kind: 'candidate', id: 'fb:7', role: 'confirmed by you', weight: 1, observedAt: at, label: 'the Inbox item' },
    { kind: 'miss', id: 'm-old', role: 'repeat of', weight: 1, observedAt: at, label: 'an old miss' },
    { kind: 'fact', id: 'f1', role: 'cited', weight: 1, observedAt: at, label: 'a project fact', projectKey: 'demo-shop' },
    { kind: 'fact', id: 'f2', role: 'cited', weight: 1, observedAt: at, label: 'a fact from nowhere' },
    { kind: 'hunch' as never, id: 'h', role: 'vibe', weight: 1, observedAt: at, label: 'a kind of evidence this build does not know' },
  ] } };
  location.hash = '#decisions?status=all';
  render(<Decisions />);
  expect(await within(pane()).findByRole('heading', { name: 'dream up' })).toBeTruthy();
  expect(within(pane()).getAllByText('pondering').length).toBeGreaterThan(0);
  expect(within(pane()).getByText('Z')).toBeTruthy();
  expect(screen.getByText(/Rolled back by/).textContent).toMatch(/: bored$/);
  expect(screen.getByText('meh')).toBeTruthy();
  expect(within(pane()).getAllByText('global').length).toBeGreaterThan(0);
  expect(within(listBox()).getByText(/^global · dream up/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'the Inbox item' }).getAttribute('href')).toBe('#inbox/fb%3A7');
  expect(screen.getByRole('link', { name: 'a project fact' }).getAttribute('href')).toBe('#projects/demo-shop');
  for (const t of ['an old miss', 'a fact from nowhere', 'a kind of evidence this build does not know']) expect(screen.queryByRole('link', { name: t })).toBeNull();
  expect(screen.getByText('hunch')).toBeTruthy();
  // Neither approve nor roll back: it is not a status those take.
  expect(screen.queryByRole('button', { name: /Approve|Roll back|Keep/ })).toBeNull();
});

test('a rolled-back decision says who, why and what went with it', async () => {
  location.hash = '#decisions?status=rolled_back';
  const d = list.find((x) => x.id === 'dec:rolled')!;
  details['dec:rolled'] = { ...detail({ ...d, after: d.before }), notes: [], evidence: [] };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  expect(screen.getByText(/Rolled back by/).textContent).toMatch(/you .*: too broad \(still useful in checkout\), with 1 dependent decision/);
  expect(screen.getByText(/changed nothing it records/)).toBeTruthy();
  expect(screen.getByText('No notes yet.')).toBeTruthy();
  expect(screen.getByText('No evidence recorded.')).toBeTruthy();
  // A disagreement need not give a reason.
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'no' } });
  fireEvent.click(screen.getByLabelText('Disagree'));
  fireEvent.click(screen.getByLabelText('No verdict'));
  fireEvent.click(screen.getByLabelText('Disagree'));
  fireEvent.submit(screen.getByLabelText('note').closest('form')!);
  await waitFor(() => expect(posts('/api/decisions/dec%3Arolled/notes').map((c) => c.body)).toEqual([{ text: 'no', verdict: 'disagree' }]));
  await waitFor(() => expect((screen.getByLabelText('note') as HTMLTextAreaElement).value).toBe(''));
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'just a remark' } });
  fireEvent.submit(screen.getByLabelText('note').closest('form')!);
  await waitFor(() => expect(posts('/api/decisions/dec%3Arolled/notes').at(-1)!.body).toEqual({ text: 'just a remark', verdict: null }));
});

test('exports the whole filtered list as JSON or CSV, page by page', async () => {
  const blobs: Blob[] = [];
  const names: string[] = [];
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => {} }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
  routes['/api/decisions'] = (_b, url) => {
    const q = new URLSearchParams(url.split('?')[1]);
    if (q.get('offset') === '1' || q.get('after') === 'k:1') return Response.json([list[1]]);
    return Response.json([list[0]], { headers: { 'x-next-offset': '1', 'x-next-after': 'k:1' } });
  };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  expect(screen.getByText('1 decision+')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  await waitFor(() => expect(blobs).toHaveLength(1));
  expect(JSON.parse(await read(blobs[0])).map((d: Decision) => d.id)).toEqual(['dec:proposed', 'dec:applied']);
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
  await waitFor(() => expect(blobs).toHaveLength(2));
  const csv = await read(blobs[1]);
  expect(csv.split('\r\n')).toHaveLength(3);
  expect(csv).toMatch(/^id,type,status,/);
  expect(names[0]).toMatch(/^decisions-\d{4}-\d\d-\d\d\.json$/);
  expect(names[1]).toMatch(/\.csv$/);
  expect(calls.filter((c) => c.url.includes('limit=500')).map((c) => c.url)).toEqual([
    // By keyset, not offset.
    '/api/decisions?status=proposed&limit=500', '/api/decisions?status=proposed&limit=500&after=k%3A1',
    '/api/decisions?status=proposed&limit=500', '/api/decisions?status=proposed&limit=500&after=k%3A1',
  ]);
  // Load more fetches the next page into the list.
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await within(listBox()).findByText(/^Served 22 times/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

  routes['/api/decisions'] = () => Response.json({ error: 'store down' }, { status: 503 });
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
  expect((await screen.findAllByText('Export failed: store down')).length).toBeGreaterThan(0);
  click.mockRestore();
});

test('a failed list, page or decision says so', async () => {
  routes['/api/decisions'] = () => Response.json({ error: 'decisions store unavailable' }, { status: 400 });
  render(<Decisions />);
  expect((await screen.findAllByText('decisions store unavailable')).length).toBeGreaterThan(0);
  // Not "nothing waiting", and no count: the list is unknown, not empty.
  expect(screen.getByText('Decisions could not be loaded')).toBeTruthy();
  expect(screen.queryByText('Nothing waiting for you')).toBeNull();
  expect(screen.queryByText('0 decisions')).toBeNull();
  cleanup();

  routes['/api/decisions'] = (_b, url) => (url.includes('offset=') ? Response.json({ error: 'page gone' }, { status: 400 }) : Response.json([list[0]], { headers: { 'x-next-offset': '1' } }));
  routes['/api/decisions/dec%3Aproposed'] = () => Response.json({ error: 'decision unreadable' }, { status: 400 });
  render(<Decisions />);
  expect((await screen.findAllByText('decision unreadable')).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect((await screen.findAllByText('page gone')).length).toBeGreaterThan(0);
});

test('a decision changed elsewhere refuses with 409 and the page shows its state now', async () => {
  routes['POST /api/decisions/dec%3Aproposed/approve'] = () => {
    details['dec:proposed'] = detail({ ...list[0], status: 'proposed', rationale: 'refreshed rationale' });
    return Response.json({ error: 'it is no longer proposed' }, { status: 409 });
  };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
  expect((await screen.findAllByText('approve lesson · lesson:demo-shop:1 was not approved: it is no longer proposed')).length).toBeGreaterThan(0);
  expect(await screen.findByText('refreshed rationale', { selector: 'p' })).toBeTruthy();

  routes['POST /api/decisions/dec%3Aproposed/reject'] = () => Response.json({ error: 'nope' }, { status: 400 });
  fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
  expect((await screen.findAllByText('nope')).length).toBeGreaterThan(0);
});

test('a link to a decision that does not exist says so', async () => {
  location.hash = '#decisions/dec%3Agone';
  render(<Decisions />);
  expect((await screen.findAllByText('Decision dec:gone could not be loaded.')).length).toBeGreaterThan(0);
});

test('on a phone the list and the decision take turns', async () => {
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.click(within(listBox()).getByRole('button'));
  fireEvent.click(screen.getByRole('button', { name: 'Back to decisions' }));
  expect(within(listBox()).getByRole('button')).toBeTruthy();
});

test('read-only installs see everything and can change nothing', async () => {
  location.hash = '#decisions?status=all';
  render(<OwnerWrites.Provider value={false}><Decisions /></OwnerWrites.Provider>);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  for (const name of [/Approve/, /Reject/, 'Add note', 'Write a note']) {
    const b = screen.getAllByRole('button', { name }).at(-1) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(READ_ONLY_TITLE);
  }
  expect((screen.getByLabelText('note') as HTMLTextAreaElement).disabled).toBe(true);
  await key('a');
  await key('x');
  await key('j');
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  await key('u');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(posts('/api/decisions')).toHaveLength(0);
  // Export is a read: it stays.
  expect((screen.getByRole('button', { name: 'JSON' }) as HTMLButtonElement).disabled).toBe(false);
});

test('the Lessons card lists the decisions on a lesson and rolls one back inline', async () => {
  const changed = vi.fn();
  routes['/api/decisions'] = (_b, url) => Response.json(url.includes('target=lesson%3Ademo-shop%3A1') ? list.filter((d) => d.targets.some((t) => t.id === 'lesson:demo-shop:1')).slice(0, 2) : []);
  render(<LessonDecisions lessonId="lesson:demo-shop:1" onChanged={changed} />);
  const card = await screen.findByRole('region', { name: 'Decisions' });
  expect(calls[0].url).toBe('/api/decisions?target=lesson%3Ademo-shop%3A1&limit=20');
  expect(within(card).getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe('#decisions?status=all&target=lesson%3Ademo-shop%3A1');
  expect(within(card).getByRole('link', { name: /The miss repeated/ }).getAttribute('href')).toBe('#decisions/dec%3Aproposed');
  fireEvent.click(within(card).getByRole('button', { name: 'Roll back' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(within(card).getByRole('button', { name: 'Roll back' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Roll back 2 decisions' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(calls.filter((c) => c.url.includes('target=')).length).toBe(2));

  routes['POST /api/decisions/dec%3Aapplied/rollback'] = (body) => ((body as { cascade: string }).cascade === 'preview' ? Response.json({ cascade: [], blocked: [] }) : Response.json({ error: 'changed' }, { status: 409 }));
  list = list.map((d) => (d.id === 'dec:applied' ? { ...d, status: 'applied' } : d));
  cleanup();
  render(<LessonDecisions lessonId="lesson:demo-shop:1" onChanged={changed} />);
  const card2 = await screen.findByRole('region', { name: 'Decisions' });
  fireEvent.click(within(card2).getByRole('button', { name: 'Roll back' }));
  fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Roll back' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Show what changed' }));
  expect(await within(screen.getByRole('region', { name: 'Decisions' })).findByText(/You changed this lesson after the loop did/)).toBeTruthy();
});

test('the Lessons card is absent when the loop never touched the lesson or the API has no loop', async () => {
  routes['/api/decisions'] = () => Response.json({ error: 'not found' }, { status: 404 });
  const { container } = render(<LessonDecisions lessonId="l9" onChanged={() => {}} />);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(container.innerHTML).toBe('');
});

test('the Lessons card lists the newest five and links the rest, as a floor when the API has more pages', async () => {
  const many = Array.from({ length: 7 }, (_, i) => decision(`dec:m${i}`, { rationale: `reason ${i}` }));
  let paged = false;
  routes['/api/decisions'] = () => new Response(JSON.stringify(many), { headers: { 'content-type': 'application/json', ...(paged && { 'x-next-offset': '20' }) } });
  render(<LessonDecisions lessonId="lesson:demo-shop:1" onChanged={() => {}} />);
  const card = await screen.findByRole('region', { name: 'Decisions' });
  expect(within(card).getAllByRole('link', { name: /^reason/ })).toHaveLength(5);
  expect(within(card).getByRole('link', { name: '2 more decisions in the audit log' }).getAttribute('href')).toBe('#decisions?status=all&target=lesson%3Ademo-shop%3A1');
  cleanup();
  paged = true;
  render(<LessonDecisions lessonId="lesson:demo-shop:1" onChanged={() => {}} />);
  expect(await screen.findByRole('link', { name: 'More decisions in the audit log' })).toBeTruthy();
});

test('a date in the address that is not a real day is dropped like any unknown filter, and the page still opens', async () => {
  // Year 0000 is a JavaScript date but not a date field's: the field would show blank while the filter applied.
  for (const bad of ['since=foo', 'until=2026-13-45', 'since=2026-02-31&until=20261101', 'since=0000-01-01']) {
    location.hash = `#decisions?status=all&${bad}`;
    calls = [];
    render(<Decisions />);
    expect(await within(pane()).findByRole('heading', { name: /approve lesson/ })).toBeTruthy();
    expect(calls[0].url).toBe('/api/decisions?limit=100');
    cleanup();
  }
});

test('an approval the API refuses because the decision moved on stays said after the next decision opens', async () => {
  list = [list[0], decision('dec:proposed2', { type: 'approve_lesson', status: 'proposed', mode: 'propose', appliedAt: undefined, rationale: 'Another proposal.' })];
  details = Object.fromEntries(list.map((d) => [d.id, detail(d)]));
  routes['POST /api/decisions/dec%3Aproposed/approve'] = () => {
    // Its lesson changed behind the page: the API marked it overridden, so it leaves the proposals.
    details['dec:proposed'] = detail({ ...list[0], status: 'overridden' });
    return Response.json({ error: 'lesson:demo-shop:1 changed since it was proposed, so nothing was applied; it is marked overridden: reload it' }, { status: 409 });
  };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
  await waitFor(() => expect(within(listBox()).getAllByRole('button')).toHaveLength(1));
  await waitFor(() => expect(screen.getByText('Another proposal.', { selector: 'p' })).toBeTruthy());
  expect(screen.getAllByText(/was not approved: lesson:demo-shop:1 changed since it was proposed/).length).toBeGreaterThan(0);
  // Picking a decision yourself clears it.
  fireEvent.click(within(listBox()).getByRole('button'));
  await waitFor(() => expect(screen.queryByText(/was not approved/)).toBeNull());
});

test('an overridden proposal (its target changed before it was applied) offers no Restore anyway and says nothing was changed', async () => {
  list = [decision('dec:ovp', { type: 'reword_lesson', status: 'overridden', appliedAt: undefined })];
  details = { 'dec:ovp': detail(list[0]) };
  location.hash = '#decisions?status=overridden';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /reword lesson/ });
  expect(screen.getByRole('note').textContent).toMatch(/Its target changed before it was applied, so nothing was changed/);
  expect(screen.queryByRole('button', { name: 'Restore anyway' })).toBeNull();
});

test('a rollback of a decision whose own target changed since turns into Restore anyway, in words, with long ids cut', async () => {
  const id = 'lesson:demo-shop:a-very-long-lesson-identifier-that-would-run-off-the-dialog';
  const d = decision('dec:93bd5a62aa0f4c55b1c1e9e0d2b7f3a1', { type: 'reword_lesson', status: 'applied', targets: [{ kind: 'lesson', id, role: 'primary' }],
    before: [{ kind: 'lesson', id, fields: { title: 'Old words', paths: ['src/routes/orders.ts'] }, fingerprint: 'b' }],
    after: [{ kind: 'lesson', id, fields: { title: 'New words', paths: ['src/routes/orders.ts'] }, fingerprint: 'a' }] });
  list = [d];
  details = { [d.id]: detail(d) };
  const path = `/api/decisions/${encodeURIComponent(d.id)}/rollback`;
  routes[`POST ${path}`] = (body) => {
    if ((body as { cascade: string }).cascade === 'preview') {
      // The API marks it overridden, as a plain rollback would.
      const over = { ...d, status: 'overridden' as const };
      details[d.id] = { ...detail(over), current: [{ kind: 'lesson', id, fields: { title: 'New words', paths: [] }, fingerprint: 'c' }] };
      return Response.json({ error: `its lesson ${id} changed since it was applied, so nothing was rolled back; it is marked overridden: reload it to compare, or restore anyway` }, { status: 409 });
    }
    return Response.json({ ...details[d.id].decision, status: 'rolled_back' });
  };
  location.hash = '#decisions?status=all';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /reword lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  const dialog = await screen.findByRole('dialog');
  const note = await within(dialog).findByRole('note');
  expect(note.textContent).toMatch(/^Since this decision was applied, the lesson "New words": paths changed\. So nothing was rolled back, and it is now marked overridden\./);
  expect(dialog.textContent).not.toMatch(/dec:/);
  expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('Restore what was there before this decision?');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restore anyway' }));
  await waitFor(() => expect(posts(path).map((c) => c.body)).toEqual([{ expect: 'applied', cascade: 'preview' }, { expect: 'overridden', cascade: 'apply', restoreAnyway: true }]));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // A blocked dependent's long target id is cut to a line, with the whole id on hover.
  cleanup();
  list = [decision('dec:applied')];
  details = { 'dec:applied': detail(list[0]) };
  routes['POST /api/decisions/dec%3Aapplied/rollback'] = () => Response.json({ cascade: details['dec:applied'].dependents, blocked: [{ id: 'dec:later', reason: `lesson ${id} changed since it was applied` }] });
  location.hash = '#decisions?status=applied';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  const blocked = await within(await screen.findByRole('dialog')).findByRole('alert');
  const cut = within(blocked).getByText(id);
  expect(cut.title).toBe(id);
  expect(cut.className).toMatch(/truncate/);
});

test('a cascaded rollback updates the dependents it took along in the list too', async () => {
  location.hash = '#decisions?status=all';
  list = [decision('dec:applied'), decision('dec:later', { type: 'rank_weight', dependsOn: ['dec:applied'], rationale: 'Ranked down.' })];
  details = Object.fromEntries(list.map((d) => [d.id, detail(d)]));
  routes['POST /api/decisions/dec%3Aapplied/rollback'] = (body) => {
    if ((body as { cascade: string }).cascade === 'preview') return Response.json({ cascade: details['dec:applied'].dependents, blocked: [] });
    for (const x of list) details[x.id] = detail({ ...x, status: 'rolled_back' });
    return Response.json({ ...details['dec:applied'].decision, rollback: { at: '2026-11-10T10:00:00Z', by: 'you', reason: null, note: null, cascade: ['dec:later'] } });
  };
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  expect(within(listBox()).getAllByText('applied')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /Roll back/ }));
  fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Roll back 2 decisions' }));
  await waitFor(() => expect(within(listBox()).getAllByText('rolled back')).toHaveLength(2));
  expect(within(listBox()).queryByText('applied')).toBeNull();
});

test('the note form\'s button and the bar\'s button that goes to it have different names', async () => {
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  expect(screen.getAllByRole('button', { name: 'Add note' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Write a note' })).toHaveLength(1);
});

test('cancelling a rollback whose preview marked the decision overridden keeps that decision open as it is now', async () => {
  const other = decision('dec:other', { type: 'rank_weight', targets: [{ kind: 'lesson', id: 'lesson:demo-shop:9', role: 'primary' }], rationale: 'Ranked down.', createdAt: '2026-11-10T12:00:00Z' });
  list = [other, decision('dec:applied')];
  details = Object.fromEntries(list.map((d) => [d.id, detail(d)]));
  routes['POST /api/decisions/dec%3Aapplied/rollback'] = () => {
    // The preview found the lesson changed since: the API marks the decision overridden, as a plain rollback would.
    const over = { ...details['dec:applied'].decision, status: 'overridden' as const };
    details['dec:applied'] = detail(over);
    list = list.map((x) => (x.id === over.id ? over : x));
    return Response.json({ error: 'its lesson lesson:demo-shop:1 changed since it was applied, so nothing was rolled back; it is marked overridden: reload it to compare, or restore anyway' }, { status: 409 });
  };
  location.hash = '#decisions/dec%3Aapplied';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  expect((screen.getByLabelText('status') as HTMLSelectElement).value).toBe('applied');
  await key('u');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('note');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // The same decision, now overridden, with Restore anyway: not the other applied one with live Keep and Roll back.
  await waitFor(() => expect((screen.getByLabelText('status') as HTMLSelectElement).value).toBe('overridden'));
  await waitFor(() => expect(within(listBox()).getAllByRole('button')).toHaveLength(1));
  expect(within(pane()).getByRole('heading', { name: /retire lesson/ })).toBeTruthy();
  expect(within(pane()).getByRole('button', { name: 'Restore anyway' })).toBeTruthy();
  expect(within(pane()).queryByRole('button', { name: /Roll back/ })).toBeNull();
  expect(within(pane()).queryByRole('button', { name: 'Keep' })).toBeNull();
  // The address names it, with the list it is in now.
  expect(location.hash).toBe('#decisions/dec%3Aapplied?status=overridden');
  await key('u');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a rollback another applied decision blocks names that decision by type and when it was applied, with a link to it', async () => {
  const lesson = 'demo:demo-shop:tenant-scoping';
  const rw = (id: string, appliedAt: string) => decision(id, { type: 'rank_weight', targets: [{ kind: 'lesson', id: lesson, role: 'primary' }], appliedAt, createdAt: appliedAt });
  const a = rw('dec:6a1f0c8e2b3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a', '2026-11-09T12:00:00Z');
  const b = rw('dec:c6876efd2b376f9a2813019032aa4b5c6d7e8f9a', '2026-11-10T15:30:00Z');
  list = [b, a];
  details = Object.fromEntries(list.map((d) => [d.id, detail(d)]));
  const path = `/api/decisions/${encodeURIComponent(a.id)}/rollback`;
  routes[`POST ${path}`] = () => Response.json({ error: `${lesson} was changed since by ${b.id}, still applied: roll that back first`, blocked: [{ id: b.id, reason: `${lesson} is as it left it` }] }, { status: 409 });
  location.hash = `#decisions/${encodeURIComponent(a.id)}`;
  render(<Decisions />);
  // A and B read the same in the list: A, the older, is the one the link opened.
  await waitFor(() => expect(within(listBox()).getAllByRole('button')[1]!.getAttribute('aria-current')).toBe('true'));
  await within(pane()).findByRole('heading', { name: /ranking weight/ });
  fireEvent.click(within(pane()).getByRole('button', { name: /Roll back/ }));
  const dialog = await screen.findByRole('dialog');
  const link = await within(dialog).findByRole('link', { name: `ranking weight · applied ${new Date(b.appliedAt!).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` });
  expect(link.getAttribute('href')).toBe(`#decisions/${encodeURIComponent(b.id)}`);
  expect(within(dialog).getByRole('alert').textContent).toMatch(/Roll that one back first \(its Roll back takes along any decisions built on it\), then this one\./);
  // No raw id, and no button that only reloads the same decision.
  expect(dialog.textContent).not.toMatch(/dec:/);
  expect(within(dialog).queryByRole('button', { name: 'Show what changed' })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: /^Roll back/ })).toBeNull();
  expect(within(dialog).getByRole('link', { name: 'Open the decision that blocks it' }).getAttribute('href')).toBe(`#decisions/${encodeURIComponent(b.id)}`);
  // Cancel leaves it as it was: still applied, still open.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(within(pane()).getByRole('button', { name: /Roll back/ })).toBeTruthy();
});

test('a cascade and a dependency name the type as the page does, not as the API words its id', async () => {
  location.hash = '#decisions/dec%3Aapplied';
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /retire lesson/ });
  expect(within(pane()).getByRole('link', { name: 'ranking weight · lesson:demo-shop:2' })).toBeTruthy();
  fireEvent.click(within(pane()).getByRole('button', { name: /Roll back/ }));
  const cascade = await within(await screen.findByRole('dialog')).findByRole('list', { name: 'also rolled back' });
  expect(cascade.textContent).toBe('ranking weight · lesson:demo-shop:2');
});

/** A proposed merge of two lessons, opened, with a never-merge store behind /api/distinct-pairs. */
const openMerge = async (pairs: { a: string; b: string }[] = [], o: { writes?: boolean } = {}) => {
  const merge = decision('dec:merge', {
    type: 'merge_duplicates', status: 'proposed', mode: 'propose', decidedBy: undefined, decidedAt: undefined, appliedAt: undefined,
    targets: [{ kind: 'lesson', id: 'lesson:demo-shop:3', role: 'keeper' }, { kind: 'lesson', id: 'lesson:demo-shop:1', role: 'merged' }],
  });
  list = [merge];
  details = { [merge.id]: detail(merge) };
  let stored = pairs.map((p) => ({ ...p, by: 'you', at: '2026-11-10T10:00:00Z', reason: 'you marked them as not the same', decisionId: null }));
  routes['GET /api/distinct-pairs'] = (_b, url) => {
    const ids = decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('ids') ?? '').split(',');
    return Response.json(stored.filter((p) => ids.includes(p.a) || ids.includes(p.b)));
  };
  routes['POST /api/distinct-pairs'] = (b) => {
    const { a, b: other, reason } = b as { a: string; b: string; reason: string };
    const [x, y] = a < other ? [a, other] : [other, a];
    stored = [...stored, { a: x, b: y, by: 'you', at: '2026-11-12T10:00:00Z', reason, decisionId: null }];
    return Response.json({ created: true, pairs: stored }, { status: 201 });
  };
  routes['DELETE /api/distinct-pairs'] = (b) => {
    const { a, b: other } = b as { a: string; b: string };
    stored = stored.filter((p) => !(p.a === a && p.b === other));
    return new Response(null, { status: 204 });
  };
  render(<OwnerWrites.Provider value={o.writes ?? true}><Decisions /></OwnerWrites.Provider>);
  return within(await screen.findByRole('region', { name: 'Never merge' }));
};

test('a merge decision: "Never merge these two" records the pair, and the record is listed', async () => {
  const card = await openMerge();
  fireEvent.click(await card.findByRole('button', { name: 'Never merge these two' }));
  await card.findByText(/You said these two are not the same/);
  const post = posts('/api/distinct-pairs')[0];
  expect(post.body).toMatchObject({ a: 'lesson:demo-shop:3', b: 'lesson:demo-shop:1' });
  expect(card.queryByRole('button', { name: 'Never merge these two' })).toBeNull();
  const records = within(card.getByRole('list', { name: 'never-merge records' }));
  expect(records.getByText('lesson:demo-shop:1 ≠ lesson:demo-shop:3')).toBeTruthy();
});

test('a merge decision lists never-merge records naming either record, and Lift removes one', async () => {
  const card = await openMerge([{ a: 'lesson:demo-shop:1', b: 'lesson:demo-shop:3' }, { a: 'lesson:demo-shop:3', b: 'lesson:demo-shop:9' }]);
  const records = within(await card.findByRole('list', { name: 'never-merge records' }));
  expect(records.getAllByRole('listitem')).toHaveLength(2);
  expect(card.getByText(/You said these two are not the same/)).toBeTruthy();
  fireEvent.click(records.getByRole('button', { name: 'lift never merge lesson:demo-shop:1 and lesson:demo-shop:3' }));
  await card.findByRole('button', { name: 'Never merge these two' });
  expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ a: 'lesson:demo-shop:1', b: 'lesson:demo-shop:3' });
  expect(within(card.getByRole('list', { name: 'never-merge records' })).getAllByRole('listitem')).toHaveLength(1);
});

test('a refused lift (the operator token) says why and keeps the record', async () => {
  const card = await openMerge([{ a: 'lesson:demo-shop:1', b: 'lesson:demo-shop:3' }]);
  routes['DELETE /api/distinct-pairs'] = () => Response.json({ error: 'only you lift a never-merge record (the browser or FG_OWNER_TOKEN), never the operator token' }, { status: 403 });
  fireEvent.click(await card.findByRole('button', { name: /lift never merge/ }));
  expect((await card.findByRole('alert')).textContent).toMatch(/only you lift a never-merge record/);
  expect(card.getAllByRole('listitem')).toHaveLength(1);
});

test('read-only installs see the never-merge records and can neither mark nor lift one', async () => {
  const card = await openMerge([{ a: 'lesson:demo-shop:3', b: 'lesson:demo-shop:9' }], { writes: false });
  for (const name of ['Never merge these two', /lift never merge/]) {
    const b = await card.findByRole('button', { name }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(READ_ONLY_TITLE);
  }
});

test('only merge decisions offer never merge', async () => {
  render(<Decisions />);
  await within(pane()).findByRole('heading', { name: /approve lesson/ });
  expect(screen.queryByRole('region', { name: 'Never merge' })).toBeNull();
  expect(calls.some((c) => c.url.startsWith('/api/distinct-pairs'))).toBe(false);
});
