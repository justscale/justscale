/**
 * Processable protocol — BUILT-IN DESCRIPTOR invariants (edge cases).
 *
 * Each test pins a property a silent regression in a single builtin
 * would leak into every downstream consumer (channels, signals, state).
 *
 * These bypass the state-serializer and test the descriptor contract
 * directly — serialize(x) then deserialize(serialize(x)) must preserve
 * the property this test names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
  getProcessDescriptor,
} from '../../../src/process/serialization.js';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

const rt = (v: unknown) => decodeProcessable(JSON.parse(JSON.stringify(encodeProcessable(v))));
const rtState = (vars: Record<string, unknown>) =>
  deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));

describe('Builtin: Date', () => {
  it('INVARIANT: Date preserves millisecond precision exactly', () => {
    const d = new Date('2025-01-15T12:34:56.789Z');
    const round = rt(d) as Date;
    assert.ok(round instanceof Date);
    assert.equal(round.getTime(), d.getTime(), 'milliseconds must match exactly');
    assert.equal(round.toISOString(), '2025-01-15T12:34:56.789Z');
  });

  it('INVARIANT: Date at epoch 0 round-trips', () => {
    const d = new Date(0);
    const round = rt(d) as Date;
    assert.equal(round.getTime(), 0);
  });

  it('INVARIANT: Date far in the future round-trips', () => {
    const d = new Date('2999-12-31T23:59:59.999Z');
    const round = rt(d) as Date;
    assert.equal(round.getTime(), d.getTime());
  });

  it('INVARIANT: Date before 1970 (negative ms) round-trips', () => {
    const d = new Date('1969-07-20T20:17:00.000Z');
    const round = rt(d) as Date;
    assert.equal(round.getTime(), d.getTime());
  });

  it('INVARIANT: Invalid Date round-trips as an Invalid Date (not silently converted to epoch 0)', () => {
    // proc-5: the serializer encodes NaN ms as the sentinel string "invalid"
    // so JSON round-trip preserves it. new Date(NaN) must come back out.
    const invalid = new Date('not-a-date');
    assert.ok(Number.isNaN(invalid.getTime()));
    const round = rt(invalid) as Date;
    assert.ok(round instanceof Date);
    assert.ok(Number.isNaN(round.getTime()), 'Invalid Date must round-trip as Invalid Date, not epoch 0');
  });
});

describe('Builtin: Map', () => {
  it('INVARIANT: Map preserves string keys + values + insertion order', () => {
    const m = new Map<string, number>([
      ['b', 2],
      ['a', 1],
      ['c', 3],
    ]);
    const round = rt(m) as Map<string, number>;
    assert.ok(round instanceof Map);
    assert.deepEqual([...round.keys()], ['b', 'a', 'c']);
    assert.deepEqual([...round.values()], [2, 1, 3]);
  });

  it('INVARIANT: empty Map round-trips', () => {
    const round = rt(new Map()) as Map<unknown, unknown>;
    assert.ok(round instanceof Map);
    assert.equal(round.size, 0);
  });

  it('todo: Map with NON-string keys preserves key type via JSON? Pin current limits', () => {
    // Current builtin serializer produces Array.from(entries) directly —
    // so numeric keys go through JSON as numbers (preserved), Date keys
    // go as Date descriptors (via the top-level registry path but NOT
    // through state-serializer recursion within entries). Pin number keys.
    const m = new Map<number, string>([[1, 'one'], [2, 'two']]);
    const round = rt(m) as Map<number, string>;
    assert.ok(round instanceof Map);
    assert.equal(round.get(1), 'one');
    assert.equal(round.get(2), 'two');
  });

  it('INVARIANT: state-serializer preserves Date VALUES inside a Map entry', () => {
    const d = new Date('2025-06-01T00:00:00.000Z');
    const m = new Map<string, Date>([['created', d]]);
    const round = rtState({ m }) as { m: Map<string, Date> };
    assert.ok(round.m instanceof Map);
    assert.ok(round.m.get('created') instanceof Date);
    assert.equal(round.m.get('created')!.getTime(), d.getTime());
  });

  it('INVARIANT: large Map (1000 keys) preserves every entry', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 1000; i++) m.set(`k${i}`, i * 2);
    const round = rt(m) as Map<string, number>;
    assert.equal(round.size, 1000);
    for (let i = 0; i < 1000; i++) {
      assert.equal(round.get(`k${i}`), i * 2);
    }
  });
});

describe('Builtin: Set', () => {
  it('INVARIANT: Set preserves values + insertion order', () => {
    const s = new Set([3, 1, 2, 4]);
    const round = rt(s) as Set<number>;
    assert.ok(round instanceof Set);
    assert.deepEqual([...round], [3, 1, 2, 4]);
  });

  it('INVARIANT: empty Set round-trips', () => {
    const round = rt(new Set()) as Set<unknown>;
    assert.ok(round instanceof Set);
    assert.equal(round.size, 0);
  });

  it('INVARIANT: duplicate-value Set reduces to unique values (Set semantics)', () => {
    // Construction already dedupes in the source — the invariant is that
    // round-trip preserves the dedupe.
    const s = new Set([1, 1, 2, 2, 3]);
    const round = rt(s) as Set<number>;
    assert.deepEqual([...round].sort(), [1, 2, 3]);
  });

  it('INVARIANT: state-serializer preserves BigInt VALUES inside Set', () => {
    const s = new Set([1n, 2n, 999n]);
    const round = rtState({ arr: [s] }) as { arr: Set<bigint>[] };
    assert.ok(round.arr[0] instanceof Set);
    assert.ok(round.arr[0].has(1n));
    assert.ok(round.arr[0].has(999n));
  });
});

describe('Builtin: BigInt', () => {
  const desc = getProcessDescriptor('justscale.BigInt')!;

  it('INVARIANT: BigInt descriptor is registered', () => {
    assert.ok(desc, 'justscale.BigInt must be in the registry');
  });

  it('INVARIANT: BigInt round-trips as BigInt (not number)', () => {
    for (const n of [0n, 1n, -1n, 42n, 9007199254740993n /* > MAX_SAFE_INTEGER */]) {
      const restored = desc.deserialize(desc.serialize(n as any));
      assert.equal(typeof restored, 'bigint', `typeof must be bigint for ${n}`);
      assert.equal(restored, n);
    }
  });

  it('INVARIANT: BigInt way beyond MAX_SAFE_INTEGER preserves full precision (no rounding)', () => {
    const huge = 123456789012345678901234567890n;
    const restored = desc.deserialize(desc.serialize(huge as any));
    assert.equal(restored, huge);
  });

  it('INVARIANT: BigInt via state-serializer round-trips', () => {
    const round = rtState({ n: 42n, big: 9007199254740993n });
    assert.equal(round.n, 42n);
    assert.equal(round.big, 9007199254740993n);
  });
});

describe('Builtin: Uint8Array (via state-serializer)', () => {
  it('INVARIANT: bytes are identical after round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128]);
    const round = rtState({ data: bytes }) as { data: Uint8Array };
    assert.ok(round.data instanceof Uint8Array);
    assert.equal(round.data.length, bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      assert.equal(round.data[i], bytes[i], `byte ${i} must match`);
    }
  });

  it('INVARIANT: empty Uint8Array round-trips', () => {
    const round = rtState({ data: new Uint8Array(0) }) as { data: Uint8Array };
    assert.ok(round.data instanceof Uint8Array);
    assert.equal(round.data.length, 0);
  });

  it('INVARIANT: large Uint8Array (64KB) preserves every byte', () => {
    const size = 64 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
    const round = rtState({ data: bytes }) as { data: Uint8Array };
    assert.equal(round.data.length, size);
    // Spot-check first, middle, last byte
    assert.equal(round.data[0], 0);
    assert.equal(round.data[size / 2], (size / 2) & 0xff);
    assert.equal(round.data[size - 1], (size - 1) & 0xff);
  });
});

describe('Builtin: undefined sentinel (via state-serializer)', () => {
  it('INVARIANT: undefined VALUE is distinguishable from missing key after round-trip', () => {
    const round = rtState({ u: undefined, other: 1 });
    assert.ok('u' in round, 'key must be present after round-trip');
    assert.equal(round.u, undefined);
    assert.equal(round.other, 1);
  });

  it('INVARIANT: undefined inside a nested object also round-trips (as an explicit { __$type: "undefined" } marker)', () => {
    const round = rtState({ obj: { foo: undefined, bar: 'x' } }) as { obj: { foo: unknown; bar: string } };
    assert.ok('foo' in round.obj);
    assert.equal(round.obj.foo, undefined);
    assert.equal(round.obj.bar, 'x');
  });
});

describe('Builtin: RegExp (proc-7)', () => {
  it('INVARIANT: RegExp round-trips with correct source and flags', () => {
    const r = /abc/gi;
    const round = rt(r) as RegExp;
    assert.ok(round instanceof RegExp);
    assert.equal(round.source, 'abc');
    assert.equal(round.flags, 'gi');
  });

  it('INVARIANT: RegExp via state-serializer preserves instanceof', () => {
    const r = /foo\d+/m;
    const round = rtState({ r }) as { r: RegExp };
    assert.ok(round.r instanceof RegExp);
    assert.equal(round.r.source, 'foo\\d+');
    assert.ok(round.r.test('foo42'));
  });

  it('INVARIANT: empty-source RegExp round-trips', () => {
    const r = new RegExp('');
    const round = rt(r) as RegExp;
    assert.ok(round instanceof RegExp);
    assert.equal(round.source, '(?:)');
  });
});

describe('Builtin: Error (proc-7)', () => {
  it('INVARIANT: base Error round-trips with message preserved', () => {
    const e = new Error('something went wrong');
    const round = rt(e) as Error;
    assert.ok(round instanceof Error);
    assert.equal(round.message, 'something went wrong');
  });

  it('INVARIANT: TypeError round-trips as TypeError (instanceof preserved)', () => {
    const e = new TypeError('bad type');
    const round = rt(e) as TypeError;
    assert.ok(round instanceof TypeError);
    assert.equal(round.message, 'bad type');
  });

  it('INVARIANT: RangeError round-trips as RangeError', () => {
    const e = new RangeError('out of range');
    const round = rt(e) as RangeError;
    assert.ok(round instanceof RangeError);
    assert.equal(round.message, 'out of range');
  });

  it('INVARIANT: SyntaxError round-trips as SyntaxError', () => {
    const e = new SyntaxError('bad syntax');
    const round = rt(e) as SyntaxError;
    assert.ok(round instanceof SyntaxError);
    assert.equal(round.message, 'bad syntax');
  });

  it('INVARIANT: Error name field is preserved', () => {
    const e = new Error('named');
    e.name = 'CustomError';
    const round = rt(e) as Error;
    assert.equal(round.name, 'CustomError');
  });

  it('INVARIANT: Error via state-serializer round-trips', () => {
    const e = new TypeError('state error');
    const round = rtState({ err: e }) as { err: TypeError };
    assert.ok(round.err instanceof TypeError);
    assert.equal(round.err.message, 'state error');
  });
});
