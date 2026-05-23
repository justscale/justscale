import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import {
  defineConfigPartial,
  isConfigPartial,
  CONFIG_PARTIAL,
} from '../index.js';

describe('defineConfigPartial', () => {
  it('returns an object branded as a ConfigPartial', () => {
    const p = defineConfigPartial('db', z.object({ host: z.string() }));
    assert.strictEqual((p as unknown as Record<symbol, unknown>)[CONFIG_PARTIAL], true);
    assert.strictEqual(isConfigPartial(p), true);
    assert.strictEqual(p.name, 'db');
  });

  it('stores the zod schema unchanged', () => {
    const schema = z.object({ port: z.number() });
    const p = defineConfigPartial('net', schema);
    assert.strictEqual(p.schema, schema);
  });

  it('same-name partials get distinct keys — no silent collision', () => {
    // Plain Symbol() (not Symbol.for) — two features that happen to pick
    // the same name each get their own container slot. The description
    // on the symbol matches for debuggability, but identity does not.
    const a = defineConfigPartial('collide-dup', z.object({ x: z.string() }));
    const b = defineConfigPartial('collide-dup', z.object({ y: z.number() }));
    assert.notStrictEqual(a.key, b.key);
    assert.strictEqual(a.key.description, 'config:collide-dup');
    assert.strictEqual(b.key.description, 'config:collide-dup');
    assert.notStrictEqual(a, b);
  });

  it('accepts an empty name (produces a symbol described "config:")', () => {
    const p = defineConfigPartial('', z.object({}));
    assert.strictEqual(p.name, '');
    assert.strictEqual(typeof p.key, 'symbol');
    assert.strictEqual(p.key.description, 'config:');
    // Not Symbol.for — a fresh call is not equal to the same string key
    // in the global registry.
    assert.notStrictEqual(p.key, Symbol.for('config:'));
  });

  it('accepts non-object schemas — zod validation runs on the raw value', () => {
    // The framework only prescribes object schemas for full partials, but
    // defineConfigPartial itself is generic over any ZodType.
    const p = defineConfigPartial('int-only', z.number().int());
    assert.strictEqual(p.schema.safeParse(3).success, true);
    assert.strictEqual(p.schema.safeParse(3.5).success, false);
  });

  it('isConfigPartial narrows on arbitrary values', () => {
    assert.strictEqual(isConfigPartial(null), false);
    assert.strictEqual(isConfigPartial(undefined), false);
    assert.strictEqual(isConfigPartial({}), false);
    assert.strictEqual(isConfigPartial('string'), false);
    assert.strictEqual(isConfigPartial(42), false);
    assert.strictEqual(
      isConfigPartial(defineConfigPartial('ok', z.object({}))),
      true,
    );
  });

  it('key description is "config:<name>"', () => {
    const p = defineConfigPartial('my.partial', z.object({}));
    assert.strictEqual(p.key.description, 'config:my.partial');
    // Distinct from a Symbol.for() lookup of the same string.
    assert.notStrictEqual(p.key, Symbol.for('config:my.partial'));
  });
});
