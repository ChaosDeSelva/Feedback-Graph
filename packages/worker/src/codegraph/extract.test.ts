import { expect, test } from 'vitest';
import { extract } from './extract.ts';

const sym = (r: Awaited<ReturnType<typeof extract>>, name: string) => r?.symbols.find((s) => s.name === name);
const names = (r: Awaited<ReturnType<typeof extract>>) => r!.symbols.map((s) => s.name).sort();

test('TypeScript: top-level and exported symbols with kinds, lines and export flags; no locals', async () => {
  const r = await extract('typescript', [
    "import a, { b as c, type D } from './x.js';", // 1
    'export function f(x: number) {', // 2
    '  const inner = 1;', // 3
    '  return inner;', // 4
    '}', // 5
    'export const k = () => 1, m = 2;', // 6
    'export class K {', // 7
    '  #hidden() {}', // 8
    '  private priv() {}', // 9
    '  constructor() {}', // 10
    '  run() {}', // 11
    '  handler = () => 1;', // 12
    '  static count = 1;', // 13
    '}', // 14
    'class Local { m() {} }', // 15
    'export interface I { x: number }', // 16
    'export type T = 1;', // 17
    'export enum E { A }', // 18
    'function helper() {}', // 19
    'export { helper as renamed };', // 20
    'let counter = 0;', // 21
    'export default function () {}', // 22
    'declare function dd(): void;', // 23
    'export abstract class A { abstract z(): void }', // 24
  ].join('\n'));
  expect(names(r)).toEqual(['A', 'A.z', 'E', 'I', 'K', 'K.handler', 'K.priv', 'K.run', 'Local', 'T', 'counter', 'dd', 'default', 'f', 'helper', 'k', 'm'].sort());
  expect(sym(r, 'f')).toEqual({ name: 'f', kind: 'function', exported: true, lines: '2-5' });
  expect(sym(r, 'k')).toMatchObject({ kind: 'function', exported: true, lines: '6-6' });
  expect(sym(r, 'm')).toMatchObject({ kind: 'const', exported: true });
  expect(sym(r, 'K')).toMatchObject({ kind: 'class', exported: true, lines: '7-14' });
  expect(sym(r, 'K.run')).toMatchObject({ kind: 'method', exported: true, lines: '11-11' });
  expect(sym(r, 'K.handler')).toMatchObject({ kind: 'method', exported: true });
  expect(sym(r, 'K.priv')).toMatchObject({ kind: 'method', exported: false });
  expect(sym(r, 'Local')).toMatchObject({ kind: 'class', exported: false });
  expect(sym(r, 'I')).toMatchObject({ kind: 'interface', exported: true });
  expect(sym(r, 'T')).toMatchObject({ kind: 'type', exported: true });
  expect(sym(r, 'E')).toMatchObject({ kind: 'type', exported: true });
  expect(sym(r, 'helper')).toMatchObject({ kind: 'function', exported: true, lines: '19-19' });
  expect(sym(r, 'counter')).toMatchObject({ kind: 'const', exported: false });
  expect(sym(r, 'default')).toMatchObject({ kind: 'function', exported: true });
  expect(sym(r, 'dd')).toMatchObject({ kind: 'function', exported: false });
  expect(sym(r, 'A.z')).toMatchObject({ kind: 'method', exported: true });
  expect(r!.imports).toEqual([{ spec: './x.js', names: ['default', 'b', 'D'] }]);
});

test('TypeScript: every import form, re-exports, require and dynamic import', async () => {
  const r = await extract('typescript', [
    "import * as ns from 'y';",
    "import 'side-effect';",
    "import e = require('z');",
    "export { f, g as h } from './w';",
    "export * from './v';",
    "export * as q from './u';",
    "const r = require('cjs');",
    "const { aa, bb: cc } = require('cjs2');",
    "async function lazy() { const { x } = await import('./dyn'); return import(`./tpl`); }",
    "require(name);",
  ].join('\n'));
  expect(r!.imports).toEqual([
    { spec: 'y', names: ['*'] },
    { spec: 'side-effect', names: [] },
    { spec: 'z', names: ['*'] },
    { spec: './w', names: ['f', 'g'] },
    { spec: './v', names: ['*'] },
    { spec: './u', names: ['*'] },
    { spec: 'cjs', names: ['*'] },
    { spec: 'cjs2', names: ['aa', 'bb'] },
    { spec: './dyn', names: ['x'] },
  ]);
});

test('named default exports keep their names', async () => {
  expect(names(await extract('typescript', 'export default function named() {}\n'))).toEqual(['named']);
  const r = await extract('typescript', 'export default class Svc { go() {} }\n');
  expect(names(r)).toEqual(['Svc', 'Svc.go']);
  expect(sym(r, 'Svc')?.exported).toBe(true);
});

test('TSX parses JSX', async () => {
  const r = await extract('tsx', "import { h } from 'preact';\nexport function App() { return <div className=\"x\">{h}</div>; }\n");
  expect(sym(r, 'App')).toMatchObject({ kind: 'function', exported: true });
  expect(r!.imports).toEqual([{ spec: 'preact', names: ['h'] }]);
});

test('JavaScript CommonJS: module.exports and exports.x mark or create exported symbols', async () => {
  const r = await extract('javascript', [
    "const path = require('path');",
    'function a() {}',
    'function b() {}',
    'function hidden() {}',
    'module.exports = { a, bee: b };',
    'exports.c = function () {};',
    'module.exports.d = 42;',
  ].join('\n'));
  expect(names(r)).toEqual(['a', 'b', 'c', 'd', 'hidden', 'path']);
  expect(sym(r, 'a')?.exported).toBe(true);
  expect(sym(r, 'b')?.exported).toBe(true);
  expect(sym(r, 'hidden')?.exported).toBe(false);
  expect(sym(r, 'c')).toMatchObject({ kind: 'function', exported: true, lines: '6-6' });
  expect(sym(r, 'd')).toMatchObject({ kind: 'const', exported: true });
  expect(r!.imports).toEqual([{ spec: 'path', names: ['*'] }]);
});

test('JavaScript ESM with JSX', async () => {
  const r = await extract('javascript', "import React from 'react';\nexport const C = () => <p/>;\nexport default C;\n");
  expect(sym(r, 'C')).toMatchObject({ kind: 'function', exported: true });
  expect(r!.imports).toEqual([{ spec: 'react', names: ['default'] }]);
});

test('Python: functions, classes and their methods, module constants; __all__ decides exports', async () => {
  const src = [
    'import os.path', // 1
    'import a.b as c', // 2
    'from . import x, y as z', // 3
    'from ..pkg.mod import *', // 4
    'from .m import (q, r)', // 5
    'X: int = 1', // 6
    '_private = 2', // 7
    'type T = int', // 8
    '@dec', // 9
    'def f(a):', // 10
    '    import inner', // 11
    '    v = 1', // 12
    'class C(Base):', // 13
    '    def m(self): pass', // 14
    '    @property', // 15
    '    def _p(self): pass', // 16
    '    def __init__(self): pass', // 17
    'class _Hidden:', // 18
    '    def m(self): pass', // 19
    'async def g(): pass', // 20
  ].join('\n');
  const r = await extract('python', src);
  expect(names(r)).toEqual(['C', 'C.__init__', 'C._p', 'C.m', 'T', 'X', '_Hidden', '_private', 'f', 'g']);
  expect(sym(r, 'f')).toEqual({ name: 'f', kind: 'function', exported: true, lines: '9-12' });
  expect(sym(r, 'C')).toMatchObject({ kind: 'class', exported: true, lines: '13-17' });
  expect(sym(r, 'C.m')).toMatchObject({ kind: 'method', exported: true });
  expect(sym(r, 'C._p')).toMatchObject({ kind: 'method', exported: false });
  expect(sym(r, 'C.__init__')).toMatchObject({ kind: 'method', exported: true });
  expect(sym(r, 'X')).toMatchObject({ kind: 'const', exported: true });
  expect(sym(r, '_private')).toMatchObject({ kind: 'const', exported: false });
  expect(sym(r, 'T')).toMatchObject({ kind: 'type', exported: true });
  expect(r!.imports).toEqual([
    { spec: 'os.path', names: ['*'] },
    { spec: 'a.b', names: ['*'] },
    { spec: '.', names: ['x', 'y'] },
    { spec: '..pkg.mod', names: ['*'] },
    { spec: '.m', names: ['q', 'r'] },
    { spec: 'inner', names: ['*'] },
  ]);

  const withAll = await extract('python', "__all__ = ['f']\ndef f(): pass\ndef g(): pass\n");
  expect(sym(withAll, 'f')?.exported).toBe(true);
  expect(sym(withAll, 'g')?.exported).toBe(false);
  expect(sym(withAll, '__all__')).toBeUndefined();
});

test('Go: types, funcs, methods of exported types, consts; imports', async () => {
  const r = await extract('go', [
    'package main',
    'import "fmt"',
    'import (',
    '  h "net/http"',
    '  "example.com/m/pkg/util"',
    ')',
    'type S struct{}',
    'type I interface{}',
    'type A = int',
    'type hidden struct{}',
    'func (s *S) Do() {}',
    'func (s S) undo() {}',
    'func (x hidden) Skip() {}',
    'func F() {}',
    'const C, d = 1, 2',
    'var V int',
  ].join('\n'));
  expect(names(r)).toEqual(['A', 'C', 'F', 'I', 'S', 'S.Do', 'S.undo', 'V', 'd', 'hidden']);
  expect(sym(r, 'S')).toMatchObject({ kind: 'class', exported: true });
  expect(sym(r, 'I')).toMatchObject({ kind: 'interface', exported: true });
  expect(sym(r, 'A')).toMatchObject({ kind: 'type', exported: true });
  expect(sym(r, 'hidden')).toMatchObject({ kind: 'class', exported: false });
  expect(sym(r, 'S.Do')).toMatchObject({ kind: 'method', exported: true });
  expect(sym(r, 'S.undo')).toMatchObject({ kind: 'method', exported: false });
  expect(sym(r, 'd')).toMatchObject({ kind: 'const', exported: false });
  expect(r!.imports).toEqual([
    { spec: 'fmt', names: ['*'] },
    { spec: 'net/http', names: ['*'] },
    { spec: 'example.com/m/pkg/util', names: ['*'] },
  ]);
});

test('Rust: items with pub visibility, impl methods, use trees and mod declarations', async () => {
  const r = await extract('rust', [
    'use crate::a::b::{c, d as e};',
    'use std::io;',
    'use super::x::*;',
    'mod foo;',
    'pub mod bar { pub fn z() {} }',
    'pub struct S;',
    'enum En {}',
    'pub trait Tr {}',
    'type Ty = u8;',
    'pub const K: u8 = 1;',
    'pub fn f() {}',
    'impl S { pub fn m(&self) {} fn n() {} }',
    'impl Tr for S { fn t(&self) {} }',
  ].join('\n'));
  expect(names(r)).toEqual(['En', 'K', 'S', 'S.m', 'S.n', 'S.t', 'Tr', 'Ty', 'bar', 'f', 'foo']);
  expect(sym(r, 'S')).toMatchObject({ kind: 'class', exported: true });
  expect(sym(r, 'En')).toMatchObject({ kind: 'type', exported: false });
  expect(sym(r, 'Tr')).toMatchObject({ kind: 'interface', exported: true });
  expect(sym(r, 'K')).toMatchObject({ kind: 'const', exported: true });
  expect(sym(r, 'S.m')).toMatchObject({ kind: 'method', exported: true });
  expect(sym(r, 'S.n')).toMatchObject({ kind: 'method', exported: false });
  expect(sym(r, 'S.t')).toMatchObject({ kind: 'method', exported: true });
  expect(r!.imports).toEqual([
    { spec: 'crate::a::b::c', names: ['c'] },
    { spec: 'crate::a::b::d', names: ['d'] },
    { spec: 'std::io', names: ['io'] },
    { spec: 'super::x', names: ['*'] },
    { spec: 'mod foo', names: [] },
  ]);
});

test('C#: types in namespaces, public methods of public types, usings', async () => {
  const r = await extract('csharp', [
    'using System;',
    'using Foo.Bar;',
    'namespace App.Core {',
    ' public class C { public void M() {} private void N() {} }',
    ' internal interface I {}',
    ' public record R(int X);',
    ' public enum E { A }',
    '}',
  ].join('\n'));
  expect(names(r)).toEqual(['C', 'C.M', 'C.N', 'E', 'I', 'R']);
  expect(sym(r, 'C')).toMatchObject({ kind: 'class', exported: true });
  expect(sym(r, 'C.M')).toMatchObject({ kind: 'method', exported: true });
  expect(sym(r, 'C.N')).toMatchObject({ kind: 'method', exported: false });
  expect(sym(r, 'I')).toMatchObject({ kind: 'interface', exported: false });
  expect(sym(r, 'E')).toMatchObject({ kind: 'type', exported: true });
  expect(r!.imports).toEqual([{ spec: 'System', names: ['*'] }, { spec: 'Foo.Bar', names: ['*'] }]);

  const fileScoped = await extract('csharp', 'namespace App;\npublic class D { public void Go() {} }\n');
  expect(names(fileScoped)).toEqual(['D', 'D.Go']);
});

test('Swift: types, protocols, functions, methods; imports', async () => {
  const r = await extract('swift', [
    'import Foundation',
    'public class C {',
    '  func m() {}',
    '  private func n() {}',
    '}',
    'struct S {}',
    'protocol P {}',
    'private func hidden() {}',
    'func f() {}',
    'let k = 1',
    'typealias T = Int',
    'enum En {}',
  ].join('\n'));
  expect(names(r)).toEqual(['C', 'C.m', 'C.n', 'En', 'P', 'S', 'T', 'f', 'hidden', 'k']);
  expect(sym(r, 'C')).toMatchObject({ kind: 'class', exported: true, lines: '2-5' });
  expect(sym(r, 'P')).toMatchObject({ kind: 'interface' });
  expect(sym(r, 'hidden')).toMatchObject({ kind: 'function', exported: false });
  expect(sym(r, 'C.n')).toMatchObject({ exported: false });
  expect(sym(r, 'k')).toMatchObject({ kind: 'const', exported: true });
  expect(r!.imports).toEqual([{ spec: 'Foundation', names: ['*'] }]);
});

test('a language without a grammar yields null; duplicate names (overloads) merge into one symbol', async () => {
  expect(await extract('gdscript', 'extends Node\n')).toBeNull();
  const r = await extract('typescript', 'export function o(a: string): void;\nexport function o(a: number): void;\nexport function o(a: any) {\n}\n');
  expect(r!.symbols).toEqual([{ name: 'o', kind: 'function', exported: true, lines: '1-4' }]);
});
