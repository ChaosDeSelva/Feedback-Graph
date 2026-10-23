import { expect, test } from 'vitest';
import { inlineAsset } from '../build/assets.ts';

// The API's Content-Security-Policy has no font-src, so default-src 'self' applies: a font inlined as a data: URL is
// refused by the browser (a console error, and the fallback font). Fonts are always emitted as files.
test('fonts are never inlined into the CSS; other small assets keep Vite\'s default', () => {
  for (const f of ['a.woff2', 'b.woff', 'c.ttf', 'd.otf', 'e.eot', 'assets/x.WOFF2']) expect(inlineAsset(f)).toBe(false);
  for (const f of ['logo.svg', 'icon.png']) expect(inlineAsset(f)).toBeUndefined();
});
