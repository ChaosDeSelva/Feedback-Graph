import { expect, test } from 'vitest';
import { randomRun, redactSecrets } from './redact.ts';

/** mulberry32: a seeded generator, so the sample (and the test) is the same on every run. */
function generator(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const LOWER = 'abcdefghijklmnopqrstuvwxyz';

test('random letter keys of 16+ after a label are redacted in any case, all but well under 1 in 100', () => {
  const next = generator(76);
  for (const alphabet of [LOWER, LOWER.toUpperCase(), LOWER + LOWER.toUpperCase()]) {
    for (const length of [16, 20, 24, 40]) {
      let kept = 0;
      for (let i = 0; i < 1000; i++) {
        const v = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
        if (redactSecrets(`password: ${v}`).includes(v)) kept++;
      }
      expect(kept, `${alphabet.length === 52 ? 'mixed' : alphabet === LOWER ? 'lower' : 'upper'} case, ${length} letters`).toBeLessThan(10);
    }
  }
});

test('long identifiers, acronyms and dictionary words are not random runs', () => {
  for (const v of [
    'userPasswordResetToken', 'PersonalAccessTokenProvider', 'configurationManagerSecretName', 'MYAPPLICATIONSECRETNAME',
    'XMLHttpRequestEventTarget', 'HTMLTableSectionElement', 'getElementsByClassName', 'correcthorsebatterystaple',
    'internationalization', 'pseudotuberculosis', 'unexceptionability', 'MAXCONCURRENTREQUESTS', 'DefaultAzureCredential',
    'RTCDtlsTransport', 'SVGSVGElementEventMap',
  ]) expect(randomRun(v), v).toBe(false);
  for (const v of ['kQzRtLmWpXvBnHyGfDsAeU', 'qwhvmzkpdlrtxbnf', 'QWHVMZKPDLRTXBNF']) expect(randomRun(v), v).toBe(true);
});
