import { expect, test } from 'vitest';
import { extract } from './extract.ts';
import { extractGdscript } from './gdscript.ts';

test('CommonJS: an object exported with a computed value creates the exported symbol under its key', async () => {
  const r = await extract('javascript', ['function a() {}', 'module.exports = { a, version: 3, make: () => 1 };'].join('\n'));
  expect(r!.symbols.find((s) => s.name === 'version')).toMatchObject({ kind: 'const', exported: true });
  expect(r!.symbols.find((s) => s.name === 'make')).toMatchObject({ exported: true });
  expect(r!.symbols.find((s) => s.name === 'a')?.exported).toBe(true);
});

test('Rust: a top-level use list with no path imports each item by name', async () => {
  const r = await extract('rust', ['use {alpha::one, beta::two as three};'].join('\n'));
  expect(r!.imports).toEqual([{ spec: 'alpha::one', names: ['one'] }, { spec: 'beta::two', names: ['two'] }]);
});

test('GDScript: a triple-quoted string left open hides the code after it until it closes', () => {
  const r = extractGdscript([
    'func before():',
    '\tpass',
    'var doc = """starts here',
    'func not_a_function():',
    'ends here"""',
    'func after():',
    '\tpass',
  ].join('\n'));
  expect(r.symbols.map((s) => s.name).sort()).toEqual(['after', 'before', 'doc']);
});

test('GDScript: a name declared twice (a var and its setter) is one symbol spanning both', () => {
  const r = extractGdscript([
    'var health = 10',
    'func other():',
    '\tpass',
    'func health():',
    '\treturn 1',
  ].join('\n'));
  const health = r.symbols.filter((s) => s.name === 'health');
  expect(health).toHaveLength(1);
  expect(health[0].lines).toBe('1-5');
});
