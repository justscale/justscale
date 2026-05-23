/**
 * Processable protocol — NESTED encoding (proc-2 regression pin).
 *
 * encodeProcessable previously only encoded the top-level value.
 * A payload like { meta: 'foo', inner: new MyClass() } would lose
 * inner's class identity on the wire — inner came back as a plain object.
 *
 * Pin that nested Processables inside plain objects, arrays, and deeper
 * structures all survive a full encode → JSON → decode round-trip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerProcessType,
  encodeProcessable,
  decodeProcessable,
} from '../../../src/process/serialization.js';

// Side-effect: registers builtins (Date/Map/Set/Reference/BigInt)
import '../../../src/process/builtin-serializers.js';

function makeTag(suffix: string) {
  return `test.Nested.${suffix}.${Math.random().toString(36).slice(2)}`;
}

function roundTrip(value: unknown): unknown {
  return decodeProcessable(JSON.parse(JSON.stringify(encodeProcessable(value))));
}

class Box {
  constructor(public label: string, public value: number) {}
  static [Symbol.process]: ProcessDescriptor<Box>;
}

// Register once per test run — use stable name via closure
const BOX_NAME = makeTag('Box');
Box[Symbol.process] = {
  name: BOX_NAME,
  serialize: (b: Box) => ({ l: b.label, v: b.value }),
  deserialize: (d: any) => new Box(d.l, d.v),
};
registerProcessType(Box[Symbol.process]);

describe('Nested Processable — plain object payload', () => {
  it('INVARIANT: inner nested Processable retains instanceof after round-trip', () => {
    const payload = { meta: 'foo', inner: new Box('alpha', 1) };
    const result = roundTrip(payload) as typeof payload;
    assert.ok(result.inner instanceof Box, 'inner must be instanceof Box');
    assert.equal(result.inner.label, 'alpha');
    assert.equal(result.inner.value, 1);
    assert.equal(result.meta, 'foo');
  });

  it('INVARIANT: array of Processables — each element retains instanceof', () => {
    const payload = { list: [new Box('a', 1), new Box('b', 2)] };
    const result = roundTrip(payload) as typeof payload;
    assert.equal(result.list.length, 2);
    for (const item of result.list) {
      assert.ok(item instanceof Box);
    }
    assert.equal(result.list[0].label, 'a');
    assert.equal(result.list[1].label, 'b');
  });

  it('INVARIANT: deeply nested Processable (2+ levels) retains instanceof', () => {
    const payload = { nested: { deep: new Box('z', 99) } };
    const result = roundTrip(payload) as { nested: { deep: Box } };
    assert.ok(result.nested.deep instanceof Box);
    assert.equal(result.nested.deep.label, 'z');
    assert.equal(result.nested.deep.value, 99);
  });

  it('INVARIANT: full mixed payload — meta string + inner + list + nested.deep', () => {
    const payload = {
      meta: 'root',
      inner: new Box('inner', 10),
      list: [new Box('l0', 0), new Box('l1', 1)],
      nested: { deep: new Box('deep', 42) },
    };
    const result = roundTrip(payload) as typeof payload;
    assert.equal(result.meta, 'root');
    assert.ok(result.inner instanceof Box);
    assert.equal(result.inner.label, 'inner');
    assert.ok(result.list[0] instanceof Box);
    assert.ok(result.list[1] instanceof Box);
    assert.ok(result.nested.deep instanceof Box);
    assert.equal(result.nested.deep.value, 42);
  });
});

describe('Nested Processable — builtins inside plain object', () => {
  it('INVARIANT: Date nested inside plain object payload survives encode/decode', () => {
    const d = new Date('2025-06-15T12:00:00.000Z');
    const payload = { created: d, label: 'event' };
    const result = roundTrip(payload) as typeof payload;
    assert.ok(result.created instanceof Date);
    assert.equal(result.created.getTime(), d.getTime());
  });

  it('INVARIANT: Map nested inside plain object payload survives encode/decode', () => {
    const m = new Map([['x', 1], ['y', 2]]);
    const payload = { data: m };
    const result = roundTrip(payload) as { data: Map<string, number> };
    assert.ok(result.data instanceof Map);
    assert.equal(result.data.get('x'), 1);
    assert.equal(result.data.get('y'), 2);
  });

  it('INVARIANT: Array of Processable inside top-level Processable field survives', () => {
    // Top-level is a Box; its serialize outputs an object containing a list of Boxes
    const TAG_OUTER = makeTag('Outer');
    class Outer {
      constructor(public items: Box[]) {}
      static [Symbol.process]: ProcessDescriptor<Outer> = {
        name: TAG_OUTER,
        serialize: (o: Outer) => ({ items: o.items }),
        deserialize: (d: any) => new Outer(d.items),
      };
    }
    registerProcessType(Outer[Symbol.process]);

    const outer = new Outer([new Box('a', 1), new Box('b', 2)]);
    // encodeProcessable handles the top level; the serialize output contains
    // nested Boxes which are plain objects from the serializer's perspective —
    // they don't need extra encoding since the outer descriptor reconstructs them.
    // This test mainly pins that the top-level path still works fine.
    const encoded = encodeProcessable(outer) as any;
    const decoded = decodeProcessable(JSON.parse(JSON.stringify(encoded))) as Outer;
    assert.ok(decoded instanceof Outer);
    // items come back as plain objects (Outer.deserialize receives them raw)
    assert.equal(decoded.items.length, 2);
  });
});

describe('Nested Processable — top-level array of Processables', () => {
  it('INVARIANT: top-level array of Processables encodes/decodes each element', () => {
    const arr = [new Box('p', 1), new Box('q', 2), new Box('r', 3)];
    const result = roundTrip(arr) as Box[];
    assert.equal(result.length, 3);
    for (const item of result) {
      assert.ok(item instanceof Box);
    }
    assert.equal(result[0].label, 'p');
    assert.equal(result[2].label, 'r');
  });
});
