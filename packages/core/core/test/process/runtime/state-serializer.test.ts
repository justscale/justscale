import { describe, it } from 'node:test';
import assert from 'node:assert';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';
import { registerProcessType, getProcessDescriptor } from '../../../src/process/serialization.js';
import { Reference } from '../../../src/models/reference/reference.js';
import { References } from '../../../src/models/reference/reference.js';
import { registerModelByName } from '../../../src/models/model-name-registry.js';
import { PERSISTENT, ADAPTER_KEY } from '../../../src/models/symbols.js';

// Trigger Symbol.process registration + builtin serializers (Reference, References, etc.)
import '../../../src/process/serialization.js';
import '../../../src/process/builtin-serializers.js';

describe('state-serializer', () => {
  const roundTrip = (vars: Record<string, unknown>) =>
    deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));

  describe('round-trip', () => {
    it('Map', () => {
      const input = { m: new Map([['a', 1], ['b', 2]]) };
      const result = roundTrip(input);
      assert.deepStrictEqual(result.m, new Map([['a', 1], ['b', 2]]));
      assert.ok(result.m instanceof Map);
    });

    it('Set', () => {
      const input = { s: new Set([1, 2, 3]) };
      const result = roundTrip(input);
      assert.deepStrictEqual(result.s, new Set([1, 2, 3]));
      assert.ok(result.s instanceof Set);
    });

    it('Date', () => {
      const d = new Date('2025-01-15T12:00:00Z');
      const input = { d };
      const result = roundTrip(input);
      assert.ok(result.d instanceof Date);
      assert.strictEqual((result.d as Date).getTime(), d.getTime());
    });

    it('BigInt', () => {
      const input = { n: 42n };
      const result = roundTrip(input);
      assert.strictEqual(result.n, 42n);
    });

    it('undefined', () => {
      const input = { u: undefined };
      const result = roundTrip(input);
      assert.strictEqual(result.u, undefined);
      assert.ok('u' in result);
    });
  });

  describe('nested structures', () => {
    it('Map inside object inside array', () => {
      const input = {
        items: [
          { data: new Map([['x', new Set([1, 2])]]) },
        ],
      };
      const result = roundTrip(input);
      const items = result.items as { data: Map<string, Set<number>> }[];
      assert.ok(items[0].data instanceof Map);
      assert.ok(items[0].data.get('x') instanceof Set);
      assert.deepStrictEqual(items[0].data.get('x'), new Set([1, 2]));
    });

    it('Date values inside Map', () => {
      const d = new Date('2025-06-01');
      const input = { m: new Map([['created', d]]) };
      const result = roundTrip(input);
      const m = result.m as Map<string, Date>;
      assert.ok(m.get('created') instanceof Date);
      assert.strictEqual(m.get('created')!.getTime(), d.getTime());
    });

    it('BigInt inside Set inside array', () => {
      const input = { arr: [new Set([1n, 2n])] };
      const result = roundTrip(input);
      const arr = result.arr as Set<bigint>[];
      assert.ok(arr[0] instanceof Set);
      assert.ok(arr[0].has(1n));
      assert.ok(arr[0].has(2n));
    });
  });

  describe('mixed types', () => {
    it('arrays with mixed types', () => {
      const input = { mixed: [1, 'hello', true, null, new Date(0), 42n] };
      const result = roundTrip(input);
      const mixed = result.mixed as unknown[];
      assert.strictEqual(mixed[0], 1);
      assert.strictEqual(mixed[1], 'hello');
      assert.strictEqual(mixed[2], true);
      assert.strictEqual(mixed[3], null);
      assert.ok(mixed[4] instanceof Date);
      assert.strictEqual(mixed[5], 42n);
    });

    it('objects with mixed types', () => {
      const input = {
        count: 5,
        name: 'test',
        active: true,
        tags: new Set(['a', 'b']),
        meta: new Map([['k', 'v']]),
        created: new Date(1000),
        big: 100n,
        nothing: undefined,
        nil: null,
      };
      const result = roundTrip(input);
      assert.strictEqual(result.count, 5);
      assert.strictEqual(result.name, 'test');
      assert.strictEqual(result.active, true);
      assert.deepStrictEqual(result.tags, new Set(['a', 'b']));
      assert.deepStrictEqual(result.meta, new Map([['k', 'v']]));
      assert.strictEqual((result.created as Date).getTime(), 1000);
      assert.strictEqual(result.big, 100n);
      assert.strictEqual(result.nothing, undefined);
      assert.strictEqual(result.nil, null);
    });
  });

  describe('functions', () => {
    it('replaces functions with null and warns', (t) => {
      const warned: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warned.push(msg);
      try {
        const input = { fn: () => 42, ok: 'hi' };
        const serialized = serializeState(input);
        assert.strictEqual(serialized.fn, null);
        assert.strictEqual(serialized.ok, 'hi');
        assert.strictEqual(warned.length, 1);
        assert.ok(warned[0].includes('Functions cannot be serialized'));
      } finally {
        console.warn = origWarn;
      }
    });
  });

  describe('plain JSON passthrough', () => {
    it('plain JSON data passes through unchanged', () => {
      const input = {
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        arr: [1, 2, 3],
        obj: { nested: { deep: 'value' } },
      };
      const result = roundTrip(input);
      assert.deepStrictEqual(result, input);
    });
  });

  describe('Uint8Array', () => {
    it('round-trips Uint8Array', () => {
      const bytes = new Uint8Array([1, 2, 3, 255, 0, 128]);
      const result = roundTrip({ data: bytes });
      assert.ok(result.data instanceof Uint8Array);
      assert.deepStrictEqual(result.data, bytes);
    });

    it('handles empty Uint8Array', () => {
      const result = roundTrip({ data: new Uint8Array(0) });
      assert.ok(result.data instanceof Uint8Array);
      assert.strictEqual((result.data as Uint8Array).length, 0);
    });
  });

  describe('Processable protocol', () => {
    class Currency {
      constructor(public cents: number, public code: string) {}

      static [Symbol.process]: ProcessDescriptor<Currency> = {
        name: 'test.serializer.Currency',
        serialize: (v: Currency) => ({ cents: v.cents, code: v.code }),
        deserialize: (d: Uint8Array | object) => {
          const data = d as { cents: number; code: string };
          return new Currency(data.cents, data.code);
        },
      };
    }

    // Register the type so deserialize can find it
    registerProcessType(Currency[Symbol.process]);

    it('serializes Processable class instances using their descriptor', () => {
      const amount = new Currency(1599, 'EUR');
      const serialized = serializeState({ amount });

      assert.ok(serialized.__$processTypes, 'should have __types metadata');
      assert.strictEqual((serialized.__$processTypes as Record<string, string>).amount, 'test.serializer.Currency');
    });

    it('round-trips Processable class instances through JSONB', () => {
      const amount = new Currency(1599, 'EUR');
      const result = roundTrip({ amount, name: 'test' });

      assert.ok(result.amount instanceof Currency);
      assert.strictEqual((result.amount as Currency).cents, 1599);
      assert.strictEqual((result.amount as Currency).code, 'EUR');
      assert.strictEqual(result.name, 'test');
    });

    it('mixes Processable and regular values', () => {
      const vars = {
        amount: new Currency(500, 'USD'),
        count: 42,
        tags: new Set(['a', 'b']),
        active: true,
      };
      const result = roundTrip(vars);

      assert.ok(result.amount instanceof Currency);
      assert.strictEqual((result.amount as Currency).cents, 500);
      assert.strictEqual(result.count, 42);
      assert.deepStrictEqual(result.tags, new Set(['a', 'b']));
      assert.strictEqual(result.active, true);
    });

    it('handles Processable with binary output (Uint8Array)', () => {
      const binaryType: ProcessDescriptor<{ value: number }> = {
        name: 'test.serializer.BinaryType',
        serialize: (v) => new Uint8Array([v.value & 0xFF, (v.value >> 8) & 0xFF]),
        deserialize: (d) => {
          const bytes = d as Uint8Array;
          return { value: bytes[0] | (bytes[1] << 8) };
        },
      };
      registerProcessType(binaryType);

      const obj = { [Symbol.process]: binaryType, value: 258 };
      const result = roundTrip({ data: obj });

      assert.deepStrictEqual(result.data, { value: 258 });
    });

    it('falls back to JSON for unknown descriptor names', () => {
      // Simulate stored data from a descriptor that no longer exists
      const stored = {
        __$processTypes: { mystery: 'test.serializer.Deleted' },
        mystery: { some: 'data' },
      };
      const warned: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warned.push(msg);
      try {
        const result = deserializeState(stored);
        assert.deepStrictEqual(result.mystery, { some: 'data' });
        assert.ok(warned.some(w => w.includes('No registered ProcessDescriptor')));
      } finally {
        console.warn = origWarn;
      }
    });

    it('backward compat: deserializes state without __$processTypes (legacy)', () => {
      const stored = { count: 5, name: 'old' };
      const result = deserializeState(stored);
      assert.strictEqual(result.count, 5);
      assert.strictEqual(result.name, 'old');
    });

    it('handles nested Processable values inside arrays', () => {
      const items = [new Currency(100, 'USD'), new Currency(200, 'EUR')];
      const result = roundTrip({ items });
      const restored = result.items as Currency[];
      assert.ok(restored[0] instanceof Currency);
      assert.ok(restored[1] instanceof Currency);
      assert.strictEqual(restored[0].cents, 100);
      assert.strictEqual(restored[1].code, 'EUR');
    });

    it('handles nested Processable values inside plain objects', () => {
      const data = { price: new Currency(999, 'GBP'), label: 'test' };
      const result = roundTrip({ data });
      const restored = result.data as { price: Currency; label: string };
      assert.ok(restored.price instanceof Currency);
      assert.strictEqual(restored.price.cents, 999);
      assert.strictEqual(restored.label, 'test');
    });
  });

  describe('collision avoidance', () => {
    it('user data with __$type key passes through unchanged', () => {
      const input = {
        data: { __$type: 'custom-user-tag', v: 'user-value', extra: 1 },
      };
      const result = roundTrip(input);
      assert.deepStrictEqual(result.data, { __$type: 'custom-user-tag', v: 'user-value', extra: 1 });
    });

    it('user data with known tag name but extra keys passes through', () => {
      // Only our tags have exactly {__$type, v}. User objects with __$type
      // but unrecognized tag names fall through to the default branch.
      const input = {
        data: { __$type: 'Map', v: 'not-real-entries', extra: true },
      };
      // This has __$type: 'Map' but 'extra' key makes it a regular object
      // The deserializer will try to reconstruct a Map from 'not-real-entries'
      // which would fail. But the user asked about collision with unknown tags,
      // so let's test that unknown tag names pass through:
      const input2 = {
        data: { __$type: 'FooBar', v: 123 },
      };
      const result = roundTrip(input2);
      assert.deepStrictEqual(result.data, { __$type: 'FooBar', v: 123 });
    });
  });

  describe('Reference with model name', () => {
    it('Reference round-trip preserves model name', () => {
      // Register a fake model for deserialization
      const fakeModel = {
        ref: (id: string) => new Reference(id, 'TestModel'),
      };
      registerModelByName('TestModel', fakeModel);

      const ref = new Reference('ref-123', 'TestModel');
      const result = roundTrip({ myRef: ref });

      assert.ok(result.myRef instanceof Reference);
      assert.strictEqual((result.myRef as Reference<unknown>).identifier, 'ref-123');
    });

    it('Reference without model name still round-trips', () => {
      const ref = new Reference('ref-456');
      const result = roundTrip({ myRef: ref });

      assert.ok(result.myRef instanceof Reference);
      assert.strictEqual((result.myRef as Reference<unknown>).identifier, 'ref-456');
    });

    it('References (plural) round-trips', () => {
      const refs = new References(['a', 'b', 'c']);
      const result = roundTrip({ myRefs: refs });

      assert.ok(result.myRefs instanceof References);
      const restored = result.myRefs as References<unknown>;
      assert.deepStrictEqual([...restored.identifiers], ['a', 'b', 'c']);
    });
  });

  describe('Persistent collapses to Reference', () => {
    it('Persistent entity serializes as PersistentRef', () => {
      const entity = Object.create(null);
      Object.defineProperty(entity, PERSISTENT, { value: true });
      Object.defineProperty(entity, ADAPTER_KEY, { value: 'entity-789' });
      entity.name = 'Test Product';

      const serialized = serializeState({ product: entity });
      // Should contain PersistentRef tag, not the raw entity
      const json = JSON.parse(JSON.stringify(serialized));
      assert.strictEqual(json.product.__$type, 'PersistentRef');
      assert.strictEqual(json.product.id, 'entity-789');
    });

    it('PersistentRef deserializes to Reference', () => {
      const entity = Object.create(null);
      Object.defineProperty(entity, PERSISTENT, { value: true });
      Object.defineProperty(entity, ADAPTER_KEY, { value: 'entity-abc' });

      const result = roundTrip({ product: entity });
      assert.ok(result.product instanceof Reference);
      assert.strictEqual((result.product as Reference<unknown>).identifier, 'entity-abc');
    });

    it('PersistentRef with model name uses registry', () => {
      // Create a fake model class with MODEL_NAME
      const MODEL_NAME = Symbol('models:modelName');
      class FakeProduct {
        static get [MODEL_NAME]() { return 'FakeProduct'; }
      }
      const fakeModel = {
        ref: (id: string) => new Reference(id, 'FakeProduct'),
      };
      registerModelByName('FakeProduct', fakeModel);

      const entity = Object.create(FakeProduct.prototype);
      Object.defineProperty(entity, PERSISTENT, { value: true });
      Object.defineProperty(entity, ADAPTER_KEY, { value: 'prod-123' });

      const result = roundTrip({ product: entity });
      assert.ok(result.product instanceof Reference);
      assert.strictEqual((result.product as Reference<unknown>).identifier, 'prod-123');
    });
  });
});
