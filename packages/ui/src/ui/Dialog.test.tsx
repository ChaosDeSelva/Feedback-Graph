import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';

afterEach(cleanup);

function Page({ onCancel = () => {}, busy = false, auto = false }: { onCancel?: () => void; busy?: boolean; auto?: boolean }) {
  return (
    <>
      <button type="button">behind</button>
      <Dialog title="Roll back?" onCancel={onCancel} busy={busy} footer={<><button type="button">Cancel</button><button type="button" {...(auto && { 'data-autofocus': true })}>Go</button></>}>
        <input aria-label="why" />
      </Dialog>
    </>
  );
}

test('focus starts on the first control, or the one marked to take it, and Tab stays inside', () => {
  render(<Page />);
  const why = screen.getByLabelText('why');
  const go = screen.getByRole('button', { name: 'Go' });
  expect(document.activeElement).toBe(why);
  const dialog = screen.getByRole('dialog', { name: 'Roll back?' });
  go.focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(document.activeElement).toBe(why);
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(go);
  screen.getByRole('button', { name: 'Cancel' }).focus();
  fireEvent.keyDown(dialog, { key: 'Tab' }); // the browser moves it on
  expect(document.activeElement?.textContent).toBe('Cancel');
  screen.getByRole('button', { name: 'behind' }).focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(document.activeElement).toBe(why);
  fireEvent.keyDown(dialog, { key: 'a' });
  cleanup();
  render(<Page auto />);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go' }));
});

test('Escape and a click outside cancel, unless it is busy; focus goes back where it was', () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  const onCancel = vi.fn();
  const { rerender, unmount } = render(<Page onCancel={onCancel} busy />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
  expect(onCancel).not.toHaveBeenCalled();
  rerender(<Page onCancel={onCancel} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
  fireEvent.mouseDown(screen.getByLabelText('why'));
  expect(onCancel).toHaveBeenCalledTimes(2);
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
