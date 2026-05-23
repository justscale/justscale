/**
 * Processable protocol interaction with contract values.
 *
 * The Processable protocol (Symbol.process + ProcessDescriptor) is the
 * framework's unified serialisation mechanism. Every type that needs to
 * cross a durability boundary — channels, signals, cluster RPC — opts in
 * via `static [Symbol.process]`.
 *
 * For contracts, the protocol determines which values can cross the wire
 * without loss. These tests pin the protocol contract directly, separately
 * from the contract/proxy layer tests, so a change to the serializer
 * surfaces as a test failure at the right level.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
  isProcessable,
  hasProcessDescriptor,
  findProcessDescriptor,
  registerProcessType,
} from '../../../src/process/serialization.js';
import '../../../src/process/builtin-serializers.js';
import { Reference } from '../../../src/models/reference/reference.js';

describe('Processable protocol (contract serialisation substrate)', () => {
  // INVARIANT: plain JSON-shaped values are structurally preserved (not wrapped).
  // A contract handler returning `{ x: 1 }` must not accidentally become
  // `{ __$p: ..., d: ... }`. The recursive walk may produce a new object
  // reference, but the contents must be equal.
  test('plain object is returned unchanged by encodeProcessable', () => {
    const obj = { a: 1, b: 'two', c: null };
    const encoded = encodeProcessable(obj);
    assert.deepEqual(encoded, obj, 'structurally equal — no Processable wrapping applied');
  });

  // INVARIANT: a framework Processable (e.g., Date) IS wrapped. Callers can
  // then JSON.stringify safely.
  test('Processable value (Date) is tagged via encodeProcessable', () => {
    const d = new Date('2024-02-01T00:00:00Z');
    const encoded = encodeProcessable(d) as Record<string, unknown>;
    assert.notEqual(encoded, d);
    assert.ok('__$p' in encoded, 'tag key present');
    assert.equal(encoded['__$p'], 'justscale.Date');
  });

  // INVARIANT: decodeProcessable reverses encodeProcessable for registered
  // descriptors. If this round-trip is broken, EVERY contract call that
  // moves framework types is broken.
  test('round-trip: Date -> encoded -> JSON -> decoded is a Date', () => {
    const d = new Date('2024-02-01T12:34:56Z');
    const wire = JSON.parse(JSON.stringify(encodeProcessable(d)));
    const back = decodeProcessable(wire);
    assert.ok(back instanceof Date);
    assert.equal((back as Date).getTime(), d.getTime());
  });

  // INVARIANT: isProcessable is a STRICT instance-level check. It returns true
  // ONLY if the value itself has a valid descriptor — it does NOT walk the
  // constructor chain. findProcessDescriptor, by contrast, does.
  //
  // This matters because contract handlers return *instances* of framework
  // types (Date, Map, Reference) whose descriptor lives on the class. The
  // encode path must use findProcessDescriptor (class-aware), which it does.
  test('isProcessable is instance-level; findProcessDescriptor walks to constructor', () => {
    // Class-keyed descriptors don't count as instance-level — FALSE for Date/Map/Ref instances.
    assert.equal(isProcessable(new Date()), false,
      'Date instance has no OWN Symbol.process — descriptor is on the class');
    assert.equal(isProcessable(new Map()), false);
    assert.equal(isProcessable(new Reference('x')), false);
    // Plain / falsy values — FALSE.
    assert.equal(isProcessable({}), false);
    assert.equal(isProcessable(null), false);
    assert.equal(isProcessable('abc'), false);

    // findProcessDescriptor sees class-level descriptors — TRUE for those.
    assert.ok(findProcessDescriptor(new Date()), 'Date resolved via class');
    assert.ok(findProcessDescriptor(new Map()), 'Map resolved via class');
    assert.ok(findProcessDescriptor(new Reference('x')), 'Reference resolved via class');
    assert.equal(findProcessDescriptor({}), undefined);
    assert.equal(findProcessDescriptor(null), undefined);
  });

  // INVARIANT: user-defined Processable types can opt in via static [Symbol.process].
  // Pin the full opt-in shape so the contract doesn't silently drift.
  test('user class can opt in via static [Symbol.process] and round-trip', () => {
    class Money {
      constructor(public cents: number, public currency: string) {}
      static [Symbol.process] = {
        name: 'test.contract.Money',
        serialize: (v: Money) => ({ c: v.cents, cur: v.currency }),
        deserialize: (d: any) => new Money(d.c, d.cur),
      } as ProcessDescriptor<Money>;
    }
    registerProcessType(Money[Symbol.process]);

    const m = new Money(1234, 'EUR');
    const wire = JSON.parse(JSON.stringify(encodeProcessable(m)));
    const back = decodeProcessable(wire);
    assert.ok(back instanceof Money);
    assert.equal((back as Money).cents, 1234);
    assert.equal((back as Money).currency, 'EUR');
  });

  // INVARIANT: decoding a value that was NEVER encoded is structurally
  // preserved — the decoder doesn't accidentally match untagged plain objects
  // or wrap them. The recursive walk may produce a new object reference, but
  // the contents remain equal.
  test('decodeProcessable on an untagged plain object returns it unchanged', () => {
    const plain = { __$p: undefined, a: 1 };  // __$p is undefined, not a string — passes through
    assert.deepEqual(decodeProcessable(plain), plain);
    const noTag = { a: 1, b: 2 };
    assert.deepEqual(decodeProcessable(noTag), noTag);
  });

  // INVARIANT: decoding a tagged payload whose descriptor ISN'T registered
  // throws with a descriptive error. This is the loud-failure behaviour — a
  // missing registration is a programming error, not a graceful-degrade case.
  test('decodeProcessable with unknown tag name throws a descriptive error', () => {
    const input = { __$p: 'nonexistent.descriptor', d: { any: 'thing' } };
    assert.throws(
      () => decodeProcessable(input),
      /Unknown descriptor 'nonexistent\.descriptor'/,
    );
  });

  // INVARIANT: registering the SAME descriptor twice is idempotent.
  // Registering a DIFFERENT descriptor with the same name throws loudly.
  test('registerProcessType is idempotent for identity, loud on conflict', () => {
    const d1: ProcessDescriptor<{}> = {
      name: 'test.contract.DupName',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    // Same object — idempotent.
    registerProcessType(d1);
    registerProcessType(d1);  // must not throw

    const d2: ProcessDescriptor<{}> = {
      name: 'test.contract.DupName',  // same name, different object
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    assert.throws(
      () => registerProcessType(d2),
      /Duplicate registration/,
    );
  });

  // INVARIANT: `hasProcessDescriptor` matches a class (static descriptor),
  // which is needed for codegen / schema introspection.
  test('hasProcessDescriptor matches classes with static descriptor', () => {
    assert.equal(hasProcessDescriptor(Reference), true,
      'class itself has the descriptor');
    assert.equal(hasProcessDescriptor(Date), true);
    class NotProcessable { constructor(public x: number) {} }
    assert.equal(hasProcessDescriptor(NotProcessable), false);
  });

  // INVARIANT: Map and Set are processable at top level — pin the wire shape.
  test('Map and Set top-level encode produces the expected wire shape', () => {
    const m = new Map([['a', 1]]);
    const encMap = encodeProcessable(m) as any;
    assert.equal(encMap['__$p'], 'justscale.Map');

    const s = new Set(['x']);
    const encSet = encodeProcessable(s) as any;
    assert.equal(encSet['__$p'], 'justscale.Set');
  });
});
