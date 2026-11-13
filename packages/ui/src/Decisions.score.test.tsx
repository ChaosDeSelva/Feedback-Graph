import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Decision } from './api.ts';
import { Decisions } from './Decisions.tsx';
import { decision, detail } from './testing/loop.ts';

vi.setConfig({ testTimeout: 30_000 });
const scored = (id: string, rationale: string, s: number) => decision(id, { status: 'proposed', rationale, approveScore: s, scoreWhy: `${s.toFixed(1)} · loop proposes approve_lesson` });
let list: Decision[];
let urls: string[];

beforeEach(() => {
  location.hash = '#decisions';
  urls = [];
  list = [scored('dec:a', 'clear approve', 9.1), scored('dec:b', 'near call', 5.2), scored('dec:c', 'clear reject', 1.4), scored('dec:d', 'leaning call', 6.4)];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    const path = url.split('?')[0];
    if (path === '/api/decisions') return Response.json(list);
    const m = path.match(/^\/api\/decisions\/([^/]+)$/);
    if (m) return Response.json(detail(list.find((d) => d.id === decodeURIComponent(m[1]))!));
    if (path === '/api/activity') return Response.json([]);
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rationales = () => within(screen.getByRole('region', { name: 'decisions list' })).getAllByText(/approve$|call$|reject$/).map((e) => e.textContent);

test('needs you lists the judgement calls first, nearest 5 first, and each row and the detail show the score', async () => {
  render(<Decisions />);
  await waitFor(() => expect(rationales()).toEqual(['near call', 'leaning call', 'clear approve', 'clear reject']));
  expect(within(screen.getByRole('region', { name: 'decisions list' })).getByRole('img', { name: /^Approve score 5\.2 of 10/ })).toBeTruthy();
  await waitFor(() => expect(screen.getAllByRole('img', { name: /^Approve score 5\.2 of 10/ })).toHaveLength(2));
});

test('ordering by approve score keeps the API order and asks for sort=score', async () => {
  render(<Decisions />);
  await waitFor(() => expect(rationales()).toHaveLength(4));
  fireEvent.change(screen.getByRole('combobox', { name: 'order' }), { target: { value: 'score' } });
  await waitFor(() => expect(urls.some((u) => u.startsWith('/api/decisions?') && u.includes('sort=score'))).toBe(true));
  await waitFor(() => expect(rationales()).toEqual(['clear approve', 'near call', 'clear reject', 'leaning call']));
});
