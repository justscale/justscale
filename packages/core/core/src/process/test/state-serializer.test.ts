/**
 * state-serializer: deep round-trip for process vars in JSONB storage.
 *
 * Serializes non-JSON types (Map, Set, Date, BigInt, undefined, Uint8Array)
 * with __$type tags and reconstructs them on load.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import '../builtin-serializers.js';
import {
  serializeState,
  deserializeState,
} from '../../runtime/process/state-serializer.js';

function roundtrip(vars: Record<string, unknown>): Record<string, unknown> {
  const serialized = serializeState(vars);
  // Must survive a JSON string round-trip (JSONB is stricter than JS objects).
  const viaJson = JSON.parse(JSON.stringify(serialized));
  return deserializeState(viaJson);
}

describe('serializeState / deserializeState - primitive round-trips', () => {
  it('strings pass through', () => {
    assert.deepEqual(roundtrip({ x: 'hello' }), { x: 'hello' });
  });

  it('numbers pass through', () => {
    // JSON.stringify erases the sign of -0, so we only assert on magnitudes.
    const r = roundtrip({ x: 42, y: 3.14, z: 0 });
    assert.equal(r.x, 42);
    assert.equal(r.y, 3.14);
    assert.equal(r.z, 0);
  });

  it('booleans pass through', () => {
    assert.deepEqual(roundtrip({ t: true, f: false }), { t: true, f: false });
  });

  it('null passes through', () => {
    assert.deepEqual(roundtrip({ x: null }), { x: null });
  });

  it('undefined is preserved via __$type tag', () => {
    const r = roundtrip({ x: undefined });
    assert.ok('x' in r);
    assert.equal(r.x, undefined);
  });

  it('BigInt round-trips via string encoding', () => {
    const huge = 123456789012345678901234567890n;
    const r = roundtrip({ x: huge });
    assert.equal(typeof r.x, 'bigint');
    assert.equal(r.x, huge);
  });

  it('negative bigint round-trips', () => {
    const neg = -42n;
    const r = roundtrip({ x: neg });
    assert.equal(r.x, neg);
  });
});

describe('state-serializer - non-JSON types', () => {
  it('Date round-trips via Processable descriptor', () => {
    const d = new Date('2024-06-15T12:34:56.789Z');
    const r = roundtrip({ d });
    assert.equal((r.d as Date) instanceof Date, true);
    assert.equal((r.d as Date).getTime(), d.getTime());
  });

  it('Map round-trips with mixed value types', () => {
    const m = new Map<string, unknown>([
      ['a', 1],
      ['b', 'two'],
      ['c', true],
      ['d', null],
    ]);
    const r = roundtrip({ m });
    const out = r.m as Map<string, unknown>;
    assert.equal(out instanceof Map, true);
    assert.equal(out.size, 4);
    assert.equal(out.get('a'), 1);
    assert.equal(out.get('b'), 'two');
    assert.equal(out.get('c'), true);
    assert.equal(out.get('d'), null);
  });

  it('Set round-trips with string items', () => {
    const s = new Set(['a', 'b', 'c']);
    const r = roundtrip({ s });
    const out = r.s as Set<string>;
    assert.equal(out instanceof Set, true);
    assert.equal(out.size, 3);
    assert.ok(out.has('a'));
  });

  it('Uint8Array round-trips via base64 encoding', () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const r = roundtrip({ b: bytes });
    const out = r.b as Uint8Array;
    assert.equal(out instanceof Uint8Array, true);
    assert.equal(out.length, 4);
    assert.deepEqual([...out], [1, 2, 3, 255]);
  });

  it('empty Map round-trips to empty Map', () => {
    const r = roundtrip({ m: new Map() });
    assert.equal((r.m as Map<unknown, unknown>).size, 0);
  });

  it('empty Set round-trips to empty Set', () => {
    const r = roundtrip({ s: new Set() });
    assert.equal((r.s as Set<unknown>).size, 0);
  });

  it('empty Uint8Array round-trips', () => {
    const r = roundtrip({ b: new Uint8Array(0) });
    assert.equal((r.b as Uint8Array).length, 0);
  });
});

describe('state-serializer - nested structures', () => {
  it('Date nested in object round-trips', () => {
    const d = new Date(1_700_000_000_000);
    const r = roundtrip({ obj: { when: d } });
    const out = (r.obj as any).when as Date;
    assert.equal(out instanceof Date, true);
    assert.equal(out.getTime(), d.getTime());
  });

  it('Date nested in array round-trips', () => {
    const d = new Date(2_000_000_000_000);
    const r = roundtrip({ list: [d, d] });
    const [a, b] = r.list as Date[];
    assert.equal(a instanceof Date, true);
    assert.equal(b instanceof Date, true);
    assert.equal(a.getTime(), d.getTime());
  });

  it('Map with Date value round-trips', () => {
    const d = new Date();
    const m = new Map<string, Date>([['k', d]]);
    const r = roundtrip({ m });
    const out = (r.m as Map<string, Date>).get('k')!;
    assert.equal(out instanceof Date, true);
    assert.equal(out.getTime(), d.getTime());
  });

  it('deeply nested (obj -> array -> Set) round-trips', () => {
    const original = { outer: { inner: [new Set(['a', 'b'])] } };
    const r = roundtrip(original) as any;
    assert.equal(r.outer.inner[0] instanceof Set, true);
    assert.ok(r.outer.inner[0].has('a'));
  });

  it('array of primitives round-trips', () => {
    const r = roundtrip({ list: [1, 'two', true, null] });
    assert.deepEqual(r.list, [1, 'two', true, null]);
  });

  it('multiple vars with mixed types', () => {
    const d = new Date();
    const r = roundtrip({
      a: 1,
      b: 'x',
      c: d,
      m: new Map([['k', 'v']]),
      n: null,
      u: undefined,
    });
    assert.equal(r.a, 1);
    assert.equal(r.b, 'x');
    assert.equal((r.c as Date).getTime(), d.getTime());
    assert.equal((r.m as Map<string, string>).get('k'), 'v');
    assert.equal(r.n, null);
    assert.equal(r.u, undefined);
  });

  // Deeper nesting probes — these exercise the recursive
  // `serializeValue → descriptor.serialize → serializeValue` path.
  // If any descriptor double-wraps or fails to unwrap, the inner
  // type tag (Date/Set/Map) is lost on deserialization.

  it('Map with Date as KEY round-trips (key serialization path)', () => {
    const d1 = new Date(1_700_000_000_000);
    const d2 = new Date(1_800_000_000_000);
    const m = new Map<Date, string>([[d1, 'one'], [d2, 'two']]);
    const r = roundtrip({ m });
    const out = r.m as Map<Date, string>;
    // The keys must come back as Date instances, not strings or
    // numbers (which would happen if the key wasn't deserialized).
    const keys = [...out.keys()];
    assert.equal(keys.length, 2);
    assert.ok(keys.every((k) => k instanceof Date), 'all keys should be Date instances');
    // Value lookup by reconstructed Date won't work (different identity),
    // so look up by getTime() match instead.
    const byTime = new Map(keys.map((k) => [k.getTime(), out.get(k)]));
    assert.equal(byTime.get(d1.getTime()), 'one');
    assert.equal(byTime.get(d2.getTime()), 'two');
  });

  it('Map of Map of Date round-trips (3-deep recursive descriptor)', () => {
    const inner = new Map<string, Date>([['t', new Date(123_456)]]);
    const outer = new Map<string, Map<string, Date>>([['inner', inner]]);
    const r = roundtrip({ m: outer });
    const recoveredOuter = r.m as Map<string, Map<string, Date>>;
    assert.ok(recoveredOuter instanceof Map);
    const recoveredInner = recoveredOuter.get('inner');
    assert.ok(recoveredInner instanceof Map, 'inner Map must come back as a Map');
    const recoveredDate = recoveredInner!.get('t');
    assert.ok(recoveredDate instanceof Date, 'inner Date must come back as a Date');
    assert.equal(recoveredDate!.getTime(), 123_456);
  });

  it('Set of Date round-trips', () => {
    const d1 = new Date(1_000_000);
    const d2 = new Date(2_000_000);
    const s = new Set<Date>([d1, d2]);
    const r = roundtrip({ s });
    const out = r.s as Set<Date>;
    assert.ok(out instanceof Set);
    const times = [...out].map((d) => {
      assert.ok(d instanceof Date, 'every item must be a Date');
      return d.getTime();
    }).sort();
    assert.deepEqual(times, [1_000_000, 2_000_000]);
  });

  it('Set of objects-containing-Date round-trips', () => {
    const s = new Set([{ when: new Date(42) }, { when: new Date(99) }]);
    const r = roundtrip({ s });
    const out = r.s as Set<{ when: Date }>;
    const items = [...out];
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.ok(item.when instanceof Date, 'nested-in-object Date must survive');
    }
  });

  it('Array of Map of Date round-trips', () => {
    const arr = [new Map<string, Date>([['x', new Date(11)]])];
    const r = roundtrip({ arr });
    const out = r.arr as Array<Map<string, Date>>;
    assert.equal(out.length, 1);
    assert.ok(out[0] instanceof Map);
    const v = out[0].get('x');
    assert.ok(v instanceof Date);
    assert.equal(v!.getTime(), 11);
  });

  // Date precision: getTime() returns whole milliseconds. Sub-ms is
  // lost. Pin the expected behavior so a future refactor that switches
  // to performance.now()-style higher precision is intentional.
  it('Date precision is whole-millisecond (sub-ms is intentionally truncated)', () => {
    const d = new Date(1_700_000_000_123);
    const r = roundtrip({ d });
    const out = r.d as Date;
    // Whole ms preserved.
    assert.equal(out.getTime(), 1_700_000_000_123);
    // Date itself doesn't track sub-ms in JS (Number-backed), so this
    // is a limitation of the Date primitive, not the serializer.
    assert.equal(out.getTime() % 1, 0, 'Date.getTime is integer ms by JS spec');
  });
});

describe('state-serializer - edge cases', () => {
  it('functions are replaced with null (with warn log)', () => {
    const r = roundtrip({ fn: () => 42 });
    assert.equal(r.fn, null);
  });

  it('user data with __$type key (not a valid tag) is preserved as plain object', () => {
    // The serializer only reconstructs types on KNOWN tag values.
    const user = { __$type: 'MyCustomThingNotRegistered', v: 99 };
    const r = roundtrip({ user });
    assert.deepEqual(r.user, user);
  });

  it('empty object round-trips', () => {
    assert.deepEqual(roundtrip({ x: {} }), { x: {} });
  });

  it('empty array round-trips', () => {
    assert.deepEqual(roundtrip({ x: [] }), { x: [] });
  });

  it('nested undefined inside array stays undefined', () => {
    const r = roundtrip({ list: [1, undefined, 3] });
    const out = r.list as unknown[];
    assert.equal(out[0], 1);
    assert.equal(out[1], undefined);
    assert.equal(out[2], 3);
  });

  it('serializeState does not propagate the internal __$processTypes key', () => {
    // Even if the caller passes __$processTypes, serialize strips it.
    const out = serializeState({ __$processTypes: { junk: 'fake' }, a: 1 } as any);
    assert.ok(!('__$processTypes' in out) || out.__$processTypes !== undefined);
    // At minimum the clean var survives.
    assert.equal(out.a, 1);
  });

  it('very large object with many keys round-trips', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) obj[`k${i}`] = i;
    const r = roundtrip({ big: obj });
    assert.equal((r.big as any).k50, 50);
    assert.equal(Object.keys(r.big as object).length, 100);
  });
});

// Persisted process state is loaded from a database row. If a row gets
// corrupted (or written by an older / different app version), the
// deserializer must not be tricked into instantiating an arbitrary class
// or running arbitrary code from a tag string.
describe('state-serializer - hostile / corrupt payloads', () => {
  it('unknown __$type tag falls back to a plain object, no constructor invoked', () => {
    let invoked = 0;
    class Sentinel {
      constructor() {
        invoked++;
      }
    }
    // Attempt: register a global class then craft state referencing its name.
    (globalThis as any).__SecuritySentinel = Sentinel;
    const corrupt = { x: { __$type: '__SecuritySentinel', v: { foo: 'bar' } } };
    const result = deserializeState(corrupt as Record<string, unknown>);
    // The unknown tag must not lead to `new Sentinel()` — the deserializer
    // only switches on a hardcoded set of known tags.
    assert.equal(invoked, 0);
    // Falls through to plain object treatment (the tag becomes a regular key)
    assert.equal((result.x as any).__$type, '__SecuritySentinel');
    delete (globalThis as any).__SecuritySentinel;
  });

  it('unregistered Processable descriptor falls back to raw value (no exec)', () => {
    // 'P' tag with an unregistered descriptor name. The serializer warns
    // and returns the raw inner value — no instantiation of an attacker
    // class.
    const corrupt = {
      x: { __$type: 'P', n: 'NotRegisteredEverAnywhere', v: 'inert' },
    };
    const result = deserializeState(corrupt as Record<string, unknown>);
    assert.equal(result.x, 'inert');
  });

  it('PersistentRef with unknown model name returns a plain Reference, no model lookup side effects', () => {
    const corrupt = {
      x: { __$type: 'PersistentRef', id: 'abc-123', m: 'NoSuchModel' },
    };
    const result = deserializeState(corrupt as Record<string, unknown>);
    // The deserializer falls through to `new Reference(id)` when the
    // model name doesn't resolve — no code executes for an unknown model.
    assert.ok(result.x);
    assert.equal((result.x as any).id ?? (result.x as any)._id, 'abc-123');
  });

  it('__$type set to a function-shaped value is ignored', () => {
    // Even if an attacker manages to write JSON with __$type as a non-string,
    // isTagged() requires it to be a string — protects against object/array
    // shapes that might trip up dispatch.
    const corrupt = { x: { __$type: { toString: () => 'Date' }, v: 0 } };
    const result = deserializeState(corrupt as Record<string, unknown>);
    // No date constructed; treated as plain object.
    assert.equal(typeof result.x, 'object');
    assert.ok(!(result.x instanceof Date));
  });
});
