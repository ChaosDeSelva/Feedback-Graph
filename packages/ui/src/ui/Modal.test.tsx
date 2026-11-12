import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { Modal } from './Modal.tsx';

afterEach(cleanup);

function Page({ hideOpener = false, busy = false, onCancel = () => {} }: { hideOpener?: boolean; busy?: boolean; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  // Like a phone menu: the opener is hidden once used, and stays hidden after the dialog closes.
  const [used, setUsed] = useState(false);
  return (
    <main tabIndex={-1}>
      <div style={{ display: used && hideOpener ? 'none' : 'block' }}><button type="button" onClick={() => { setOpen(true); setUsed(true); }}>Open</button></div>
      {open && (
        <Modal labelledBy="t" busy={busy} onCancel={() => { onCancel(); setOpen(false); }}>
          <h2 id="t">Pick one</h2>
          <button type="button">first</button>
          <select aria-label="kind" data-autofocus><option>a</option></select>
          <div style={{ display: 'none' }}><button type="button">hidden</button></div>
          <button type="button" onClick={() => setOpen(false)}>last</button>
        </Modal>
      )}
    </main>
  );
}

test('focus moves in (to data-autofocus), Tab and Shift+Tab stay inside past hidden controls, Escape closes and returns focus', async () => {
  const user = userEvent.setup();
  render(<Page />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  expect(document.activeElement).toBe(screen.getByLabelText('kind'));
  await user.tab();
  expect(document.activeElement?.textContent).toBe('last');
  await user.tab();
  expect(document.activeElement?.textContent).toBe('first');
  await user.tab({ shift: true });
  expect(document.activeElement?.textContent).toBe('last');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
});

test('with no data-autofocus the first control takes focus; focus outside is pulled back in by Tab', () => {
  render(<><button type="button">outside</button><Modal labelledBy="t" onCancel={() => {}}><h2 id="t">T</h2><button type="button">only</button></Modal></>);
  expect(document.activeElement?.textContent).toBe('only');
  screen.getByRole('button', { name: 'outside' }).focus();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
  expect(document.activeElement?.textContent).toBe('only');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
  expect(document.activeElement?.textContent).toBe('only');
});

test('a dialog with nothing focusable ignores Tab', () => {
  render(<Modal labelledBy="t" onCancel={() => {}}><h2 id="t">T</h2></Modal>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('an opener hidden while the dialog was open (a closed phone menu) hands focus to <main> on close', async () => {
  const user = userEvent.setup();
  render(<Page hideOpener />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(screen.getByRole('main'));
});

test('a dialog closed by its own action whose focus moved on leaves it there', async () => {
  function Moves() {
    const [open, setOpen] = useState(true);
    return <>{open && <Modal labelledBy="t" onCancel={() => {}}><h2 id="t">T</h2><button type="button" onClick={() => { setOpen(false); screen.getByLabelText('after').focus(); }}>Done</button></Modal>}<input aria-label="after" /></>;
  }
  render(<Moves />);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(document.activeElement).toBe(screen.getByLabelText('after'));
});

test('busy: Escape and a backdrop click do not cancel; the page shortcuts never see a key pressed inside', async () => {
  const onCancel = vi.fn();
  const pageKey = vi.fn();
  document.addEventListener('keydown', pageKey);
  render(<Modal labelledBy="t" busy onCancel={onCancel} backdropTestId="bd"><h2 id="t">T</h2><button type="button">x</button></Modal>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.mouseDown(screen.getByTestId('bd'));
  expect(onCancel).not.toHaveBeenCalled();
  expect(pageKey).not.toHaveBeenCalled();
  document.removeEventListener('keydown', pageKey);
  expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
});
