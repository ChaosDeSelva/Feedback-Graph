import { expect, test } from 'vitest';
import { capActivitySubject, MAX_ACTIVITY_SUBJECT, prepareActivity } from './activity.ts';

const entry = (subject: string, details?: Record<string, unknown>) => ({ kind: 'doc_added' as const, actor: 'agent', projectKey: 'demo', subject, why: 'w', ...(details && { details }) });

test('a subject over the cap is cut at write, and details say how long it was', () => {
  const long = `report: ${'x'.repeat(1024 * 1024)}`;
  const a = capActivitySubject(entry(long, { tool: 'report_feedback' }));
  expect(a.subject).toHaveLength(MAX_ACTIVITY_SUBJECT);
  expect(a.subject.endsWith('…')).toBe(true);
  expect(a.subject.startsWith('report: xxx')).toBe(true);
  expect(a.details).toEqual({ tool: 'report_feedback', subjectChars: long.length });
});

test('a subject within the cap is kept as it is', () => {
  const a = entry('uploaded "Spec" (3 chunks)');
  expect(capActivitySubject(a)).toBe(a);
  expect(capActivitySubject(entry('y'.repeat(MAX_ACTIVITY_SUBJECT))).subject).toHaveLength(MAX_ACTIVITY_SUBJECT);
});

test('a token that crosses the cap is redacted before the subject is cut: no part of it is stored', () => {
  const token = ['ghp', 'x'.repeat(36)].join('_'); // built, so no token-shaped literal sits in the source
  const a = prepareActivity(entry(`${'y'.repeat(470)} ${token} and more`));
  expect(a.subject).not.toContain('xxxxxxxx');
  expect(a.subject.startsWith(`${'y'.repeat(470)} [REDACTED]`)).toBe(true);
  expect(a.subject.length).toBeLessThanOrEqual(MAX_ACTIVITY_SUBJECT);
  expect(prepareActivity({ ...entry('ok'), why: `pushed with ${token}` }).why).toBe('pushed with [REDACTED]');
  // A subject cut first would have kept 24 of the token's characters.
  expect(capActivitySubject(entry(`${'y'.repeat(470)} ${token}`)).subject).toContain('xxxxxxxx');
});
