import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LoopState } from './api.ts';
import { LoopSettings } from './LoopSettings.tsx';
import { OwnerWrites, READ_ONLY_TITLE } from './ownerAccess.tsx';
import { loopState } from './testing/loop.ts';

vi.setConfig({ testTimeout: 30_000 });

let state: LoopState;
let puts: unknown[];
let fail: string | null;
beforeEach(() => {
  state = loopState();
  puts = [];
  fail = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (fail && init?.method === 'PUT') return Response.json({ error: fail }, { status: 400 });
    if (url === '/api/loop/settings') {
      const body = JSON.parse(init!.body as string);
      puts.push(body);
      state = {
        ...state, mode: body.mode ?? state.mode,
        types: state.types.map((t) => ({ ...t, ...(body.types?.[t.type] && { mode: body.types[t.type].mode ?? t.mode, tau: body.types[t.type].tau ?? t.tau }) })),
      };
      return Response.json(state);
    }
    if (url === '/api/loop/pause') { state = { ...state, paused: { at: '2026-11-10T10:00:00Z', by: 'you' }, effectiveMode: 'off', capped: 'paused' }; return Response.json(state); }
    return Response.json(state);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('sets the global mode and each type’s mode and bar, saved together; only what changed is sent', async () => {
  render(<LoopSettings />);
  const save = (await screen.findByRole('button', { name: 'Save loop settings' })) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('global mode'), { target: { value: 'propose' } });
  expect(screen.getByText('every decision waits for you')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('retire lesson mode'), { target: { value: 'observe' } });
  fireEvent.change(screen.getByLabelText('approve lesson mode'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('approve lesson bar'), { target: { value: '0.95' } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(puts).toEqual([{ mode: 'propose', types: { retire_lesson: { mode: 'observe' }, approve_lesson: { mode: null, tau: 0.95 } } }]));
  expect(await screen.findByText('Saved. The worker uses them from its next round.')).toBeTruthy();
  expect(save.disabled).toBe(true);
});

test('the bar can only be raised, and must be a number up to 1', async () => {
  render(<LoopSettings />);
  const bar = (await screen.findByLabelText('approve lesson bar')) as HTMLInputElement;
  expect(bar.value).toBe('0.92');
  fireEvent.change(bar, { target: { value: '0.8' } });
  expect(screen.getByText('at least 0.90: the bar can only be raised')).toBeTruthy();
  expect(bar.getAttribute('aria-invalid')).toBe('true');
  expect((screen.getByRole('button', { name: 'Save loop settings' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(bar, { target: { value: '1.2' } });
  expect(screen.getByText('a number up to 1')).toBeTruthy();
  fireEvent.change(bar, { target: { value: '' } });
  expect(screen.getByText('a number up to 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
  expect(bar.value).toBe('0.92');
  expect(bar.getAttribute('aria-invalid')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Undo changes' })).toBeNull();
});

test('a tripped breaker says how to turn the type back on; the budget and the kill switch are shown', async () => {
  state = loopState({ types: [...loopState().types, { ...loopState().types[0], type: 'narrow_scope', breaker: { tripped: true, at: null, reason: null } }] });
  render(<LoopSettings />);
  expect((await screen.findAllByText(/The breaker set it to propose; choose auto to turn it back on\./)).length).toBe(2);
  const rows = within(screen.getByRole('region', { name: 'decision types table' })).getAllByRole('row');
  const narrow = rows.find((r) => r.textContent?.startsWith('narrow scope'))!;
  expect(within(narrow).getByText('tripped').getAttribute('title')).toBeNull();
  expect(screen.getByText(/Model calls today:/).textContent).toBe('Model calls today: 7 of 40 (LOOP_LLM_CALLS_PER_DAY).');
  expect(screen.getByText(/applied on its own today/).textContent).toMatch(/1 of 5, at most 2 per project/);
  fireEvent.click(screen.getByRole('button', { name: 'Pause learning' }));
  expect(await screen.findByText(/Paused by you.*Running as off\./)).toBeTruthy();
});

test('a refused save keeps your changes and says why; a failed load says why', async () => {
  render(<LoopSettings />);
  fireEvent.change(await screen.findByLabelText('global mode'), { target: { value: 'off' } });
  fail = 'mode refused';
  fireEvent.click(screen.getByRole('button', { name: 'Save loop settings' }));
  expect(await screen.findByText('mode refused')).toBeTruthy();
  expect((screen.getByLabelText('global mode') as HTMLSelectElement).value).toBe('off');
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'loop store down' }, { status: 503 })));
  render(<LoopSettings />);
  expect(screen.getByRole('status', { name: 'loading' })).toBeTruthy();
  expect(await screen.findByText('loop store down')).toBeTruthy();
});

test('LOOP_DISABLED and read-only installs lock every control, with the reason on hover', async () => {
  state = loopState({ disabled: true, capped: 'disabled', effectiveMode: 'off' });
  render(<LoopSettings />);
  const mode = (await screen.findByLabelText('global mode')) as HTMLSelectElement;
  expect(mode.disabled).toBe(true);
  expect(mode.title).toBe('LOOP_DISABLED is set in .env');
  expect((screen.getByLabelText('retire lesson bar') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/LOOP_DISABLED is set in \.env: nothing runs/)).toBeTruthy();
  cleanup();
  state = loopState();
  render(<OwnerWrites.Provider value={false}><LoopSettings /></OwnerWrites.Provider>);
  for (const label of ['global mode', 'retire lesson mode', 'retire lesson bar']) {
    const el = (await screen.findByLabelText(label)) as HTMLInputElement;
    expect(el.disabled).toBe(true);
    expect(el.title).toBe(READ_ONLY_TITLE);
  }
  expect((screen.getByRole('button', { name: 'Pause learning' }) as HTMLButtonElement).title).toBe(READ_ONLY_TITLE);
  expect((screen.getByRole('button', { name: 'Save loop settings' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a type\'s "global" option says what following the global mode would run it as, not what it runs as now', async () => {
  state = loopState({ mode: 'propose', effectiveMode: 'propose' });
  state.types[0] = { ...state.types[0], mode: 'auto', effectiveMode: 'auto' };
  render(<LoopSettings />);
  const option = async (type: string) => within(await screen.findByLabelText(`${type} mode`)).getByRole('option', { name: /^global/ }).textContent;
  expect(await option('retire lesson')).toBe('global (propose)');
  // A tripped breaker holds it at propose whatever the global mode.
  fireEvent.change(screen.getByLabelText('global mode'), { target: { value: 'auto' } });
  expect(await option('retire lesson')).toBe('global (auto)');
  expect(await option('merge duplicates')).toBe('global (propose)');
  cleanup();
  // A tokenless install only observes.
  state = loopState({ capped: 'tokenless', effectiveMode: 'observe' });
  render(<LoopSettings />);
  expect(await option('retire lesson')).toBe('global (observe)');
});

test('a mode this build does not know (a newer server\'s) reads as unknown, never as the first option', async () => {
  state = loopState({ mode: 'shadow' as LoopState['mode'], effectiveMode: 'shadow' as LoopState['mode'] });
  state.types[0] = { ...state.types[0], mode: 'shadow' as LoopState['mode'] };
  render(<LoopSettings />);
  const global = (await screen.findByLabelText('global mode')) as HTMLSelectElement;
  expect(global.value).toBe('shadow');
  expect(global.selectedOptions[0].textContent).toBe('unknown (shadow)');
  expect(global.selectedOptions[0].disabled).toBe(true);
  const type = screen.getByLabelText('retire lesson mode') as HTMLSelectElement;
  expect(type.selectedOptions[0].textContent).toBe('unknown (shadow)');
  expect(within(screen.getByLabelText('approve lesson mode')).getByRole('option', { name: /^global/ }).textContent).toBe('global (unknown (shadow))');
  // Nothing changed: nothing to save.
  expect((screen.getByRole('button', { name: 'Save loop settings' }) as HTMLButtonElement).disabled).toBe(true);
});
