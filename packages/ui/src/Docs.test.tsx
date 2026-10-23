import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Docs } from './Docs.tsx';

afterEach(cleanup);

test('the Docs page explains the code map, its two agent tools and how hotspots are scored', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'The code map' }));
  expect(section.getByText('get_module_context')).toBeTruthy();
  expect(section.getByText('impact')).toBeTruthy();
  expect(section.getByText(/4 × misses \+ log2\(1 \+ churn\) \+ log2\(1 \+ dependents\)/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'The code map' })).toBeTruthy();
  expect(screen.getByText('files_changed')).toBeTruthy();
});

test('the Docs page explains cloud sync: off by default, what is sent and what never is', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'Share with a team' }));
  expect(section.getByText(/off by default/i)).toBeTruthy();
  expect(section.getByText('CLOUD_URL')).toBeTruthy();
  expect(section.getByText('CLOUD_TOKEN')).toBeTruthy();
  expect(section.getByText('SYNC_INTERVAL_MINUTES')).toBeTruthy();
  expect(section.getByText(/Never sent/)).toBeTruthy();
  expect(section.getByText('SYNC_SUGGESTIONS')).toBeTruthy();
  expect(section.getByText(/Only lessons you approved leave/)).toBeTruthy();
  expect(section.getByText(/a lesson you reject or move back to proposed, or anything you delete, is taken\s+back out of the team graph/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Share with a team' })).toBeTruthy();
});

test('the Docs page says what each CLI agent can read, and that codex-cli needs an explicit acknowledgement', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'Choosing models' }));
  expect(section.getByText(/only the project folder it is working on/)).toBeTruthy();
  expect(section.getByText('ALLOW_UNCONFINED_CODEX=1')).toBeTruthy();
  expect(section.getByText(/every transcript, every project folder with its \.env files/)).toBeTruthy();
});

test('the Docs page explains an unavailable-model badge and re-queueing given-up turns', () => {
  render(<Docs />);
  const section = within(screen.getByRole('region', { name: 'When something looks wrong' }));
  expect(section.getByText(/classifier unavailable/)).toBeTruthy();
  expect(section.getByText(/Re-queue/)).toBeTruthy();
});
