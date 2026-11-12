import { expect, test } from 'vitest';
import { extract } from './extract.ts';

const brief = (r: Awaited<ReturnType<typeof extract>>) => r!.symbols.map((s) => `${s.name}:${s.kind}:${s.exported ? 'pub' : 'priv'}`);

test('TypeScript: a namespace is a symbol whether exported, declared or plain', async () => {
  const r = await extract('typescript', 'namespace Local {}\nexport namespace Shared {}\ndeclare namespace Ambient {}\n');
  expect(brief(r)).toEqual(['Local:other:priv', 'Shared:other:pub', 'Ambient:other:priv']);
});

test('JavaScript: CommonJS exports of every shape, and require bindings with defaults and patterns', async () => {
  const r = await extract('javascript', [
    'function foo() {}',
    'const Cls = class {};',
    'x = 1;',
    'foo.bar = 1;',
    'exports.foo = foo;',
    'exports.made = () => 1;',
    'module.exports = Cls;',
    'module.exports = function () {};',
    "const [first] = require('arr');",
    "const { b = 1, c: renamed, ...rest } = require('obj');",
    "const tagged = require`tpl`;",
  ].join('\n'));
  expect(brief(r)).toEqual(['foo:function:pub', 'Cls:class:pub', 'made:function:pub', 'default:function:pub', 'tagged:const:priv']);
  // A pattern that is not an object names nothing; a default value still names the binding.
  expect(r!.imports).toEqual([{ spec: 'arr', names: [] }, { spec: 'obj', names: ['b', 'c'] }]);
});

test('Python: __all__ that is not a literal list exports nothing by name, and an empty name in it matches none', async () => {
  const computed = await extract('python', '__all__ = make()\ndef pub(): pass\ndef _priv(): pass\n');
  expect(brief(computed)).toEqual(['pub:function:pub', '_priv:function:priv']);
  const empty = await extract('python', '__all__ = [""]\ndef pub(): pass\nprint(pub)\n');
  expect(brief(empty)).toEqual(['pub:function:priv']);
});

test('Python: class attributes are not methods', async () => {
  const r = await extract('python', 'class A:\n    size = 1\n    def run(self): pass\n');
  expect(brief(r)).toEqual(['A:class:pub', 'A.run:method:pub']);
});

test('Go: grouped types with a comment, aliases, and methods on generic receivers', async () => {
  const r = await extract('go', [
    'package p',
    'type (',
    '\t// A is a number',
    '\tA int',
    '\tB string',
    ')',
    'type C = int',
    'type Store[T any] struct{}',
    'func (s *Store[T]) Get() {}',
    'func (s Store[T]) Put() {}',
  ].join('\n'));
  expect(r!.symbols.map((s) => `${s.name}@${s.lines}`)).toEqual(['A@4-4', 'B@5-5', 'C@7-7', 'Store@8-8', 'Store.Get@9-9', 'Store.Put@10-10']);
});

test('Rust: use lists without a path, self and wildcards in a list, impls of scoped, borrowed and bodiless types', async () => {
  const r = await extract('rust', [
    'use ::{a, b};',
    'use foo::{self, Bar};',
    'use baz::{*};',
    'impl foo::Bar { pub fn x() {} }',
    'impl<T> Tr for &T { fn y() {} }',
    'impl Baz;',
    'pub struct Wrapper<T>(T);',
    'impl<T> Wrapper<T> { pub fn get() {} }',
  ].join('\n'));
  expect(r!.imports).toEqual([
    { spec: 'a', names: ['a'] }, { spec: 'b', names: ['b'] },
    { spec: 'foo', names: ['*'] }, { spec: 'foo::Bar', names: ['Bar'] },
    { spec: 'baz', names: ['*'] },
  ]);
  expect(brief(r)).toEqual(['Wrapper:class:pub', 'Bar.x:method:pub', 'Wrapper.get:method:pub']);
});

test('C#: a type whose name is missing (a half-typed declaration) is skipped; an internal one has no methods listed', async () => {
  const r = await extract('csharp', 'namespace App;\nclass { }\npublic class B { public void M() {} }\nclass Internal { public void Hidden() {} }\n');
  expect(brief(r)).toEqual(['B:class:pub', 'B.M:method:pub', 'Internal:class:priv']);
});

test('Swift: half-typed declarations, private types, tuple bindings and stray braces', async () => {
  const r = await extract('swift', [
    'struct {}',
    'protocol { }',
    'private class Hidden { func inner() {} }',
    'let (a, b) = (1, 2)',
    'func before() {}',
    '}',
    'func after() {}',
  ].join('\n'));
  expect(brief(r)).toEqual(['Hidden:class:priv', '(a, b):const:pub', 'before:function:pub', 'after:function:pub']);
});

test('TypeScript/JavaScript: comments inside export braces are skipped, so a barrel keeps its symbols and re-exports', async () => {
  const barrel = await extract('typescript', 'export function keep() {}\nexport {\n  users, // the users API\n  /* x */ orders,\n} from "./api";\n');
  expect(barrel!.imports).toEqual([{ spec: './api', names: ['users', 'orders'] }]);
  expect(brief(barrel)).toEqual(['keep:function:pub']);
  const local = await extract('javascript', 'const a = 1, b = 2;\nexport {\n  a, // first\n  b,\n};\n');
  expect(brief(local)).toEqual(['a:const:pub', 'b:const:pub']);
});

test('Rust: comments inside use lists are not imports', async () => {
  const r = await extract('rust', 'use crate::db::{\n    Pool, // the pool\n    /* conn */ Conn,\n    nested::{ /* c */ A },\n};\n');
  expect(r!.imports).toEqual([
    { spec: 'crate::db::Pool', names: ['Pool'] }, { spec: 'crate::db::Conn', names: ['Conn'] }, { spec: 'crate::db::nested::A', names: ['A'] },
  ]);
});
