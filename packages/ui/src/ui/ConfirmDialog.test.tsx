import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { askConfirm, ConfirmDialog } from './ConfirmDialog.tsx';

afterEach(cleanup);

function open(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <ConfirmDialog
        open
        title="Remove this document?"
        confirmLabel="Remove document"
        items={['spec.md']}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...over}
      >
        Agents will no longer get excerpts from it.
      </ConfirmDialog>
    </div>,
  );
  return { onConfirm, onCancel, dialog: screen.getByRole('alertdialog', { name: 'Remove this document?' }) };
}

test('names exactly what will be removed, and Cancel has the focus', () => {
  const { dialog } = open();
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.textContent).toContain('Agents will no longer get excerpts from it.');
  expect(screen.getByRole('list', { name: 'will be removed' }).textContent).toBe('spec.md');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
});

test('the confirm button is the destructive one and confirms', () => {
  const { onConfirm, onCancel } = open();
  const confirm = screen.getByRole('button', { name: 'Remove document' });
  expect(confirm.className).toContain('bg-bad');
  fireEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});

test('Cancel, Escape and a click on the backdrop all cancel; a click inside does not', () => {
  const { onCancel, dialog } = open();
  fireEvent.click(dialog);
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.mouseDown(screen.getByTestId('confirm-backdrop'));
  expect(onCancel).toHaveBeenCalledTimes(3);
});

test('Tab stays inside the dialog', () => {
  open();
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  const confirm = screen.getByRole('button', { name: 'Remove document' });
  confirm.focus();
  fireEvent.keyDown(confirm, { key: 'Tab' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
});

test('with a phrase to type, confirm stays disabled until it matches', () => {
  const { onConfirm } = open({ typeToConfirm: 'shop' });
  const confirm = screen.getByRole('button', { name: 'Remove document' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('type shop to confirm'), { target: { value: 'sho' } });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('type shop to confirm'), { target: { value: 'shop' } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  // Cancel keeps the focus even with a field to type in.
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
});

test('while busy, neither button can be pressed twice and Escape does not close it', () => {
  const { onCancel, onConfirm, dialog } = open({ busy: true });
  expect((screen.getByRole('button', { name: /Remove document|Removing/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(onCancel).not.toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
});

test('nothing is rendered while closed', () => {
  render(<ConfirmDialog open={false} title="x" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('askConfirm resolves with the answer and closes the dialog', async () => {
  let answer: Promise<boolean>;
  act(() => { answer = askConfirm({ title: 'Leave without saving?', confirmLabel: 'Discard changes', message: 'Your edits are not saved.' }); });
  fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
  expect(await answer!).toBe(true);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  act(() => { answer = askConfirm({ title: 'Leave without saving?', confirmLabel: 'Discard changes' }); });
  fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
  expect(await answer!).toBe(false);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
