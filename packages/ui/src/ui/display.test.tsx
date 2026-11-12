import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SOURCE_TONE } from '../CandidateDetail.tsx';
import { ago, CAUSE_LABEL, causeLabel, causeTone, Kbd, StatTile, statusTone, TONE_FILL } from './display.tsx';

test('every cause has its own tone, so no two causes read as the same color', () => {
  const tones = Object.keys(CAUSE_LABEL).map(causeTone);
  expect(new Set(tones).size).toBe(tones.length);
  // Each one also has a solid fill for bars and dots (Patterns, the Lessons list).
  for (const t of tones) expect(TONE_FILL[t]).toBeTruthy();
});

test('a cause that is a word on Object.prototype reads as itself, in the neutral tone', () => {
  for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    expect(causeLabel(c)).toBe(c);
    expect(causeTone(c)).toBe('neutral');
  }
});

test('every feedback source has its own tone: Claude, Codex, GitHub and Linear never share a color', () => {
  const tones = Object.values(SOURCE_TONE);
  expect(new Set(tones).size).toBe(tones.length);
});

test('ago reads a past time in its largest whole unit, and a future time as just now', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const before = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  expect(ago(before(-30), now)).toBe('just now');
  expect(ago(before(59), now)).toBe('just now');
  expect(ago(before(5 * 60), now)).toBe('5m ago');
  expect(ago(before(3 * 3600), now)).toBe('3h ago');
  expect(ago(before(3 * 86_400), now)).toBe('3d ago');
  expect(ago(before(65 * 86_400), now)).toBe('2mo ago');
  expect(ago(before(800 * 86_400), now)).toBe('2y ago');
});

test('statuses share one color per meaning on every page', () => {
  expect(['pending', 'proposed', 'queued', 'running'].map(statusTone)).toEqual(['info', 'info', 'info', 'info']);
  expect(['confirmed', 'approved', 'done'].map(statusTone)).toEqual(['ok', 'ok', 'ok']);
  expect(['rejected', 'failed', 'revoked'].map(statusTone)).toEqual(['bad', 'bad', 'bad']);
  expect(statusTone('archived')).toBe('neutral');
});

test('a stat tile is a named group, so its label is allowed (aria-label on a plain div is not) and read with its value', () => {
  render(<StatTile label="repeat rate" value="29%" hint="2 were a miss seen before" />);
  expect(screen.getByRole('group', { name: 'repeat rate' }).textContent).toContain('29%');
});

test('a key cap is sized in em, so it scales with the text around it instead of a fixed 10px', () => {
  render(<p style={{ fontSize: 20 }}>press <Kbd>j</Kbd></p>);
  const k = screen.getByText('j');
  expect(k.tagName).toBe('KBD');
  expect(k.className).toMatch(/text-\[0\.8em\]/);
  expect(k.className).toMatch(/h-\[1\.9em\]/);
  expect(k.className).not.toMatch(/\d+px\]/);
});
