import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { Button, FilterBar, useFocusHandoff, usePending } from './controls.tsx';

afterEach(cleanup);

function Removable({ named, keep }: { named: boolean; keep?: boolean }) {
  const [shown, setShown] = useState(true);
  const handoff = useFocusHandoff();
  const button = shown && <Button ref={handoff} onClick={() => setShown(false)}>Retry</Button>;
  const other = <button type="button" onClick={() => setShown(false)}>elsewhere</button>;
  return named
    ? <section aria-labelledby="h"><h2 id="h">Card</h2>{button}{keep && other}</section>
    : <main tabIndex={-1}><div>{button}</div>{keep && other}</main>;
}

test('a focused button that removes itself hands focus to the heading that names its card', async () => {
  render(<Removable named />);
  screen.getByRole('button', { name: 'Retry' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await Promise.resolve();
  const h = screen.getByRole('heading', { name: 'Card' });
  expect(document.activeElement).toBe(h);
  expect(h.tabIndex).toBe(-1);
});

test('outside a named card focus goes to <main>; an unfocused button that goes moves nothing', async () => {
  render(<Removable named={false} />);
  const retry = screen.getByRole('button', { name: 'Retry' });
  retry.focus();
  fireEvent.click(retry);
  await Promise.resolve();
  expect(document.activeElement).toBe(screen.getByRole('main'));
  cleanup();
  render(<Removable named keep />);
  const other = screen.getByRole('button', { name: 'elsewhere' });
  other.focus();
  fireEvent.click(other);
  await Promise.resolve();
  expect(document.activeElement).toBe(other);
});

test('focus already moved elsewhere by the action, or nowhere to go, is left alone', async () => {
  function Moves() {
    const [shown, setShown] = useState(true);
    const handoff = useFocusHandoff();
    return <section aria-labelledby="h2"><h2 id="h2">Card</h2><input aria-label="next" />{shown && <Button ref={handoff} onClick={() => { setShown(false); screen.getByLabelText('next').focus(); }}>Go</Button>}</section>;
  }
  render(<Moves />);
  screen.getByRole('button', { name: 'Go' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  await Promise.resolve();
  expect(document.activeElement).toBe(screen.getByLabelText('next'));
  cleanup();
  function Alone() {
    const [shown, setShown] = useState(true);
    const handoff = useFocusHandoff();
    return <div>{shown && <Button ref={handoff} onClick={() => setShown(false)}>Gone</Button>}</div>;
  }
  render(<Alone />);
  screen.getByRole('button', { name: 'Gone' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Gone' }));
  await Promise.resolve();
  expect(document.activeElement).toBe(document.body);
});

test('a busy button keeps focus, looks and reads disabled, and ignores presses (a submit too)', () => {
  const onClick = vi.fn();
  const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  render(<form onSubmit={onSubmit}><Button busy onClick={onClick}>Approving…</Button><Button busy type="submit">Sending…</Button></form>);
  const b = screen.getByRole('button', { name: 'Approving…' });
  b.focus();
  fireEvent.click(b);
  fireEvent.click(screen.getByRole('button', { name: 'Sending…' }));
  expect(onClick).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(b);
  expect(b.getAttribute('aria-disabled')).toBe('true');
  expect(b.getAttribute('aria-busy')).toBe('true');
  expect((b as HTMLButtonElement).disabled).toBe(false);
});

test('usePending runs one action at a time, names it while it runs, and clears it when it settles, even on failure', async () => {
  let release = () => {};
  const calls: string[] = [];
  function Actions() {
    const [pending, run] = usePending<'a' | 'b'>();
    return (
      <>
        <p>pending: {pending ?? 'idle'}</p>
        <button type="button" onClick={() => void run('a', () => { calls.push('a'); return new Promise<void>((r) => { release = r; }); })}>a</button>
        <button type="button" onClick={() => void run('b', async () => { calls.push('b'); throw new Error('no'); }).catch(() => calls.push('b failed'))}>b</button>
      </>
    );
  }
  render(<Actions />);
  fireEvent.click(screen.getByRole('button', { name: 'a' }));
  expect(screen.getByText('pending: a')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  fireEvent.click(screen.getByRole('button', { name: 'a' }));
  expect(calls).toEqual(['a']);
  release();
  expect(await screen.findByText('pending: idle')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  expect(await screen.findByText('pending: idle')).toBeTruthy();
  await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'b failed']));
});

test('FilterBar lays its controls in an even grid of columns at least min wide, each as wide as its column', () => {
  render(<FilterBar label="filters" min="10rem"><input aria-label="a" /><select aria-label="b" /><button type="button">c</button></FilterBar>);
  const bar = screen.getByRole('group', { name: 'filters' });
  expect(bar.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(min(100%, 10rem), 1fr))');
  expect(bar.className).toMatch(/\bgrid\b/);
  expect(bar.className).toMatch(/\[&>\*\]:w-full/);
  expect(bar.className).not.toMatch(/flex-wrap/);
});
