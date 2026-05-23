/**
 * Processable serialization: registry, encode/decode, builtins.
 *
 * Covers:
 *  - registerProcessType idempotency and duplicate detection
 *  - encode/decode round-trip for Date, Map, Set, Reference, References
 *  - unknown-descriptor name on decode throws (proc-3 contract)
 *  - isProcessable / hasProcessDescriptor / findProcessDescriptor
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  registerProcessType,
  getProcessDescriptor,
  getProcessRegistry,
  isProcessable,
  hasProcessDescriptor,
  findProcessDescriptor,
  encodeProcessable,
  decodeProcessable,
  ensureRegistered,
} from '../serialization.js';
import '../builtin-serializers.js';
import { Reference, References } from '../../models/reference/reference.js';

describe('Processable registry', () => {
  it('registerProcessType stores descriptor by name', () => {
    const desc: ProcessDescriptor<string> = {
      name: 'test.String' + Math.random(),
      serialize: (v) => ({ v }),
      deserialize: (data: any) => data.v,
    };
    registerProcessType(desc);
    assert.equal(getProcessDescriptor(desc.name), desc);
  });

  it('registry is a ReadonlyMap exposed via getProcessRegistry', () => {
    const reg = getProcessRegistry();
    assert.equal(reg instanceof Map, true);
    // Builtins: Date, Map, Set, Reference, References, BigInt
    assert.ok(reg.has('justscale.Date'));
    assert.ok(reg.has('justscale.Map'));
    assert.ok(reg.has('justscale.Set'));
    assert.ok(reg.has('justscale.Reference'));
    assert.ok(reg.has('justscale.References'));
    assert.ok(reg.has('justscale.BigInt'));
  });

  it('re-registering the same descriptor is a no-op', () => {
    const desc: ProcessDescriptor<number> = {
      name: 'test.Dup.' + Math.random(),
      serialize: (v) => ({ v }),
      deserialize: (d: any) => d.v,
    };
    registerProcessType(desc);
    // Should not throw
    registerProcessType(desc);
    assert.equal(getProcessDescriptor(desc.name), desc);
  });

  it('registering different descriptor under same name throws', () => {
    const name = 'test.Conflict.' + Math.random();
    const a: ProcessDescriptor = {
      name,
      serialize: () => ({}),
      deserialize: () => null,
    };
    const b: ProcessDescriptor = {
      name,
      serialize: () => ({}),
      deserialize: () => null,
    };
    registerProcessType(a);
    assert.throws(() => registerProcessType(b), /Duplicate registration/);
  });

  it('ensureRegistered picks up descriptor from Symbol.process', () => {
    const name = 'test.Ensure.' + Math.random();
    class MyThing {
      static [Symbol.process]: ProcessDescriptor<MyThing> = {
        name,
        serialize: () => ({}),
        deserialize: () => new MyThing(),
      };
    }
    ensureRegistered(MyThing as unknown as Processable);
    assert.equal(getProcessDescriptor(name)?.name, name);
  });
});

describe('Processable detection', () => {
  it('isProcessable returns true for instance with Symbol.process', () => {
    const obj = {
      [Symbol.process]: {
        name: 'x',
        serialize: () => ({}),
        deserialize: () => ({}),
      },
    };
    assert.equal(isProcessable(obj), true);
  });

  it('isProcessable returns false for plain objects', () => {
    assert.equal(isProcessable({}), false);
    assert.equal(isProcessable({ foo: 1 }), false);
  });

  it('isProcessable returns false for null/undefined', () => {
    assert.equal(isProcessable(null), false);
    assert.equal(isProcessable(undefined), false);
  });

  it('hasProcessDescriptor detects Symbol.process on class constructor', () => {
    assert.equal(hasProcessDescriptor(Date), true);
    assert.equal(hasProcessDescriptor(Map), true);
    assert.equal(hasProcessDescriptor(Set), true);
  });

  it('findProcessDescriptor locates descriptor via instance constructor', () => {
    const now = new Date();
    const desc = findProcessDescriptor(now);
    assert.equal(desc?.name, 'justscale.Date');
  });

  it('findProcessDescriptor returns undefined for plain objects', () => {
    assert.equal(findProcessDescriptor({ foo: 1 }), undefined);
  });

  it('findProcessDescriptor returns undefined for null/primitives', () => {
    assert.equal(findProcessDescriptor(null), undefined);
    assert.equal(findProcessDescriptor(undefined), undefined);
    assert.equal(findProcessDescriptor(42), undefined);
    assert.equal(findProcessDescriptor('s'), undefined);
  });

  it('findProcessDescriptor ignores Array and Object constructors explicitly', () => {
    // Arrays and plain objects don't get descriptors even if someone tried
    // to attach them accidentally.
    assert.equal(findProcessDescriptor([]), undefined);
  });
});

describe('encodeProcessable / decodeProcessable - round trips', () => {
  it('Date round-trips to the same ms', () => {
    const d = new Date('2024-06-15T12:34:56.789Z');
    const encoded = encodeProcessable(d);
    const decoded = decodeProcessable(encoded) as Date;
    assert.equal(decoded instanceof Date, true);
    assert.equal(decoded.getTime(), d.getTime());
  });

  it('Map round-trips with string keys and mixed values', () => {
    const m = new Map<string, unknown>([
      ['a', 1],
      ['b', 'two'],
      ['c', true],
    ]);
    const encoded = encodeProcessable(m);
    const decoded = decodeProcessable(encoded) as Map<string, unknown>;
    assert.equal(decoded instanceof Map, true);
    assert.equal(decoded.get('a'), 1);
    assert.equal(decoded.get('b'), 'two');
    assert.equal(decoded.get('c'), true);
  });

  it('Set round-trips with string items', () => {
    const s = new Set(['x', 'y', 'z']);
    const encoded = encodeProcessable(s);
    const decoded = decodeProcessable(encoded) as Set<string>;
    assert.equal(decoded instanceof Set, true);
    assert.equal(decoded.size, 3);
    assert.ok(decoded.has('x'));
  });

  it('Reference round-trips with its identifier', () => {
    const ref = new Reference('user-42');
    const encoded = encodeProcessable(ref);
    const decoded = decodeProcessable(encoded) as Reference<unknown>;
    assert.equal(decoded instanceof Reference, true);
    assert.equal(decoded.identifier, 'user-42');
  });

  it('References round-trips the whole id list', () => {
    const refs = new References(['a', 'b', 'c']);
    const encoded = encodeProcessable(refs);
    const decoded = decodeProcessable(encoded) as References<unknown>;
    assert.equal(decoded instanceof References, true);
    assert.deepEqual([...decoded.identifiers], ['a', 'b', 'c']);
  });

  it('encodeProcessable returns plain values unchanged', () => {
    assert.equal(encodeProcessable('hello'), 'hello');
    assert.equal(encodeProcessable(42), 42);
    assert.equal(encodeProcessable(null), null);
    assert.equal(encodeProcessable(undefined), undefined);
    assert.equal(encodeProcessable(true), true);
  });

  it('decodeProcessable returns non-encoded values unchanged', () => {
    assert.equal(decodeProcessable('hi'), 'hi');
    assert.deepEqual(decodeProcessable({ a: 1 }), { a: 1 });
    assert.equal(decodeProcessable(null), null);
  });

  it('decodeProcessable throws on unknown descriptor name (proc-3)', () => {
    const encoded = { __$p: 'does.not.exist', d: { v: 1 } };
    assert.throws(
      () => decodeProcessable(encoded),
      /Unknown descriptor 'does\.not\.exist'/,
    );
  });

  it('encoded form has the __$p tag with descriptor name', () => {
    const d = new Date(1_700_000_000_000);
    const encoded = encodeProcessable(d) as any;
    assert.equal(encoded.__$p, 'justscale.Date');
    assert.deepEqual(encoded.d, { ms: 1_700_000_000_000 });
  });

  it('empty Map round-trips to empty Map', () => {
    const decoded = decodeProcessable(encodeProcessable(new Map())) as Map<unknown, unknown>;
    assert.equal(decoded.size, 0);
  });

  it('empty Set round-trips to empty Set', () => {
    const decoded = decodeProcessable(encodeProcessable(new Set())) as Set<unknown>;
    assert.equal(decoded.size, 0);
  });
});

describe('custom Processable type', () => {
  it('user-defined class can register and round-trip via Symbol.process', () => {
    const name = 'test.Money.' + Math.random();
    class Money {
      constructor(public amount: number, public currency: string) {}
      static [Symbol.process]: ProcessDescriptor<Money> = {
        name,
        serialize: (m) => ({ a: m.amount, c: m.currency }),
        deserialize: (data: any) => new Money(data.a, data.c),
      };
    }
    registerProcessType(Money[Symbol.process]);

    const value = new Money(100, 'EUR');
    const encoded = encodeProcessable(value);
    const decoded = decodeProcessable(encoded) as Money;
    assert.equal(decoded instanceof Money, true);
    assert.equal(decoded.amount, 100);
    assert.equal(decoded.currency, 'EUR');
  });
});
