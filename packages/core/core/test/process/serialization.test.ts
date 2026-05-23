import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerProcessType,
  getProcessDescriptor,
  getProcessRegistry,
  isProcessable,
  hasProcessDescriptor,
  ensureRegistered,
  encodeProcessable,
  decodeProcessable,
} from '../../src/process/serialization.js';

// Import to trigger Symbol.process registration
import '../../src/process/serialization.js';

describe('Processable protocol', () => {
  describe('Symbol.process', () => {
    it('should be registered on the global Symbol object', () => {
      assert.ok(Symbol.process, 'Symbol.process should exist');
      assert.equal(typeof Symbol.process, 'symbol');
    });

    it('should be a well-known symbol via Symbol.for', () => {
      assert.equal(Symbol.process, Symbol.for('@justscale/process'));
    });
  });

  describe('ProcessDescriptor', () => {
    const descriptor: ProcessDescriptor<{ value: number }> = {
      name: 'test.NumberWrapper',
      serialize: (v) => ({ value: v.value }),
      deserialize: (d) => d as { value: number },
    };

    it('should register and retrieve a descriptor', () => {
      registerProcessType(descriptor);
      const retrieved = getProcessDescriptor('test.NumberWrapper');
      assert.equal(retrieved, descriptor);
    });

    it('should allow duplicate registration of same descriptor', () => {
      // Should not throw
      registerProcessType(descriptor);
    });

    it('should throw on duplicate name with different descriptor', () => {
      const other: ProcessDescriptor<{ value: number }> = {
        name: 'test.NumberWrapper',
        serialize: (v) => v,
        deserialize: (d) => d as { value: number },
      };
      assert.throws(() => registerProcessType(other), /Duplicate registration/);
    });

    it('should return undefined for unknown names', () => {
      assert.equal(getProcessDescriptor('nonexistent'), undefined);
    });

    it('should expose the full registry', () => {
      const reg = getProcessRegistry();
      assert.ok(reg.has('test.NumberWrapper'));
    });
  });

  describe('Processable interface', () => {
    class MoneyAmount {
      constructor(public cents: number, public currency: string) {}

      static [Symbol.process]: ProcessDescriptor<MoneyAmount> = {
        name: 'test.MoneyAmount',
        serialize: (v: MoneyAmount) => ({ cents: v.cents, currency: v.currency }),
        deserialize: (d: Uint8Array | object) => {
          const data = d as { cents: number; currency: string };
          return new MoneyAmount(data.cents, data.currency);
        },
      };
    }

    it('should detect Processable on a schema/constructor', () => {
      assert.ok(hasProcessDescriptor(MoneyAmount));
    });

    it('should detect Processable on an instance with Symbol.process', () => {
      const obj = { [Symbol.process]: MoneyAmount[Symbol.process] };
      assert.ok(isProcessable(obj));
    });

    it('should not detect Processable on plain objects', () => {
      assert.ok(!isProcessable({}));
      assert.ok(!isProcessable(null));
      assert.ok(!isProcessable('string'));
      assert.ok(!isProcessable(42));
    });

    it('should auto-register via ensureRegistered', () => {
      ensureRegistered(MoneyAmount);
      const desc = getProcessDescriptor('test.MoneyAmount');
      assert.ok(desc);
      assert.equal(desc.name, 'test.MoneyAmount');
    });

    it('should round-trip serialize/deserialize', () => {
      const original = new MoneyAmount(1599, 'EUR');
      const serialized = MoneyAmount[Symbol.process].serialize(original);
      const restored = MoneyAmount[Symbol.process].deserialize(serialized);

      assert.ok(restored instanceof MoneyAmount);
      assert.equal(restored.cents, 1599);
      assert.equal(restored.currency, 'EUR');
    });
  });

  describe('proto-style schema (simulated)', () => {
    // Simulates what proto codegen would generate
    const OrderSchema = {
      $type: 'message' as const,
      $name: 'shop.Order',
      create(partial: Partial<{ id: string; total: number }> = {}) {
        return { id: '', total: 0, ...partial };
      },
      encode(value: { id: string; total: number }): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(value));
      },
      decode(data: Uint8Array): { id: string; total: number } {
        return JSON.parse(new TextDecoder().decode(data));
      },
      // Processable protocol — codegen would add this
      [Symbol.process]: {
        name: 'shop.Order',
        serialize(value: { id: string; total: number }): Uint8Array {
          return new TextEncoder().encode(JSON.stringify(value));
        },
        deserialize(data: Uint8Array | object): { id: string; total: number } {
          if (data instanceof Uint8Array) {
            return JSON.parse(new TextDecoder().decode(data));
          }
          return data as { id: string; total: number };
        },
      } satisfies ProcessDescriptor<{ id: string; total: number }>,
    };

    it('should detect as Processable', () => {
      assert.ok(hasProcessDescriptor(OrderSchema));
    });

    it('should round-trip through binary', () => {
      const order = { id: 'ord_123', total: 4999 };
      const binary = OrderSchema[Symbol.process].serialize(order);
      assert.ok(binary instanceof Uint8Array);

      const restored = OrderSchema[Symbol.process].deserialize(binary);
      assert.deepEqual(restored, order);
    });

    it('should register in the type registry', () => {
      ensureRegistered(OrderSchema);
      const desc = getProcessDescriptor('shop.Order');
      assert.ok(desc);
      assert.equal(desc.name, 'shop.Order');
    });
  });

  describe('encodeProcessable / decodeProcessable', () => {
    class Amount {
      constructor(public cents: number, public currency: string) {}
      static [Symbol.process]: ProcessDescriptor<Amount> = {
        name: 'test.encode.Amount',
        serialize: (v: Amount) => ({ c: v.cents, cur: v.currency }),
        deserialize: (d: Uint8Array | object) => {
          const data = d as { c: number; cur: string };
          return new Amount(data.c, data.cur);
        },
      };
    }
    registerProcessType(Amount[Symbol.process]);

    it('encodes Processable values with __$p tag', () => {
      const encoded = encodeProcessable(new Amount(500, 'EUR'));
      assert.ok(typeof encoded === 'object');
      assert.equal((encoded as any).__$p, 'test.encode.Amount');
      assert.deepEqual((encoded as any).d, { c: 500, cur: 'EUR' });
    });

    it('passes through non-Processable values unchanged', () => {
      assert.equal(encodeProcessable('hello'), 'hello');
      assert.equal(encodeProcessable(42), 42);
      assert.equal(encodeProcessable(null), null);
      // Plain objects are walked (to find nested Processables); referential
      // identity is not preserved — use deepEqual.
      assert.deepEqual(encodeProcessable({ a: 1 }), { a: 1 });
    });

    it('decodes Processable-encoded values', () => {
      const encoded = { __$p: 'test.encode.Amount', d: { c: 999, cur: 'USD' } };
      const decoded = decodeProcessable(encoded) as Amount;
      assert.ok(decoded instanceof Amount);
      assert.equal(decoded.cents, 999);
      assert.equal(decoded.currency, 'USD');
    });

    it('passes through non-encoded values unchanged', () => {
      assert.equal(decodeProcessable('hello'), 'hello');
      assert.equal(decodeProcessable(42), 42);
      // Plain objects are walked to find nested envelopes; referential identity
      // is not preserved — use deepEqual.
      assert.deepEqual(decodeProcessable({ a: 1 }), { a: 1 });
    });

    it('round-trips through JSON (simulating signal bus JSONB)', () => {
      const original = new Amount(1250, 'GBP');
      const encoded = encodeProcessable(original);
      const jsonRoundTrip = JSON.parse(JSON.stringify(encoded));
      const decoded = decodeProcessable(jsonRoundTrip) as Amount;
      assert.ok(decoded instanceof Amount);
      assert.equal(decoded.cents, 1250);
      assert.equal(decoded.currency, 'GBP');
    });
  });
});
