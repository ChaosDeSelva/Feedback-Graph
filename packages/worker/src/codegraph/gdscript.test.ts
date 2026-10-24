import { expect, test } from 'vitest';
import { extract } from './extract.ts';
import { extractGdscript } from './gdscript.ts';

const PLAYER = [
  '@tool',
  'class_name Player extends "res://actors/actor.gd"',
  '## A player.',
  'signal died(reason)',
  'signal _internal',
  '',
  'const Bullet = preload("res://weapons/bullet.gd")',
  'const MAX_SPEED := 300',
  '@export var speed: float = 10.0',
  '@onready var _sprite = $Sprite2D',
  'export(int) var legacy_hp = 3',
  'var health := 100:',
  '\tset(value):',
  '\t\thealth = clamp(value, 0, 100)',
  '',
  'enum State { IDLE, RUN }',
  '',
  'static func make() -> Player:',
  '\treturn Player.new()',
  '',
  'func _ready() -> void:',
  '\tvar w: Weapon = load("../weapons/weapon.gd").new()',
  '\t# Enemy in a comment is not a reference',
  '\tprint("Enemy in a string is not one either")',
  '\tvar text = """',
  'Boss inside a triple-quoted string',
  '"""',
  '',
  'remote func shoot():',
  '\tInventory.take(Bullet)',
  '',
  'class Hitbox:',
  '\tvar size = 1',
].join('\n');

const sym = (name: string) => extractGdscript(PLAYER).symbols.find((s) => s.name === name);

test('GDScript: top-level class_name, class, enum, func, signal, const and var; exported unless they start with _', async () => {
  const r = extractGdscript(PLAYER);
  expect(r.symbols.map((s) => s.name)).toEqual([
    'Player', 'died', '_internal', 'Bullet', 'MAX_SPEED', 'speed', '_sprite', 'legacy_hp', 'health', 'State', 'make', '_ready', 'shoot', 'Hitbox',
  ]);
  expect(sym('Player')).toEqual({ name: 'Player', kind: 'class', exported: true, lines: '2-2' });
  expect(sym('died')).toMatchObject({ kind: 'other', exported: true });
  expect(sym('_internal')).toMatchObject({ kind: 'other', exported: false });
  expect(sym('Bullet')).toMatchObject({ kind: 'const', exported: true, lines: '7-7' });
  expect(sym('speed')).toMatchObject({ kind: 'other', exported: true });
  expect(sym('_sprite')).toMatchObject({ exported: false });
  expect(sym('health')).toMatchObject({ lines: '12-14' }); // its setter belongs to it
  expect(sym('State')).toMatchObject({ kind: 'type' });
  expect(sym('make')).toMatchObject({ kind: 'function', exported: true, lines: '18-19' });
  expect(sym('_ready')).toMatchObject({ kind: 'function', exported: false, lines: '21-27' });
  expect(sym('shoot')).toMatchObject({ kind: 'function', lines: '29-30' });
  expect(sym('Hitbox')).toMatchObject({ kind: 'class', lines: '32-33' });
  // Nothing indented is top level.
  expect(sym('size')).toBeUndefined();
  expect(sym('w')).toBeUndefined();
});

test('GDScript: preload/load and extends paths, and capitalized names outside strings and comments, are its references', async () => {
  const specs = extractGdscript(PLAYER).imports.map((i) => i.spec);
  expect(specs).toEqual(expect.arrayContaining(['res://actors/actor.gd', 'res://weapons/bullet.gd', '../weapons/weapon.gd', 'Weapon', 'Inventory', 'Sprite2D']));
  expect(specs).not.toContain('Enemy');
  expect(specs).not.toContain('Boss');
  // Its own class_name, inner classes and enums are not references to another file.
  for (const own of ['Player', 'Hitbox', 'State']) expect(specs).not.toContain(own);
  expect(extractGdscript(PLAYER).imports.find((i) => i.spec === 'res://weapons/bullet.gd')!.names).toEqual(['*']);
  expect(extractGdscript('extends "res://base.gd"\n').imports).toEqual([{ spec: 'res://base.gd', names: ['*'] }]);
  expect(extractGdscript("extends 'base.gd'\n").imports).toEqual([{ spec: 'base.gd', names: ['*'] }]);
});

test('extract reads .gd files with the line reader (there is no tree-sitter grammar for them)', async () => {
  expect((await extract('gdscript', 'extends Node\nfunc go():\n\tpass\n'))!.symbols).toEqual([{ name: 'go', kind: 'function', exported: true, lines: '2-3' }]);
  expect(extractGdscript('')).toEqual({ symbols: [], imports: [] });
});
