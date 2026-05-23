import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeState, deserializeState } from '../../src/runtime/process/state-serializer.js';
import { getProcessDescriptor } from '../../src/process/serialization.js';
import { Reference } from '../../src/models/reference/reference.js';

// Trigger registration
import '../../src/process/builtin-serializers.js';

const roundTrip = (vars: Record<string, unknown>) =>
  deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));

describe('Built-in Processable types', () => {
  describe('registration', () => {
    it('Date is registered', () => {
      assert.ok(getProcessDescriptor('justscale.Date'));
    });

    it('Map is registered', () => {
      assert.ok(getProcessDescriptor('justscale.Map'));
    });

    it('Set is registered', () => {
      assert.ok(getProcessDescriptor('justscale.Set'));
    });

    it('Reference is registered', () => {
      assert.ok(getProcessDescriptor('justscale.Reference'));
    });
  });

  describe('Symbol.process on constructors', () => {
    it('Date has [Symbol.process]', () => {
      assert.ok((Date as any)[Symbol.process]);
      assert.equal((Date as any)[Symbol.process].name, 'justscale.Date');
    });

    it('Map has [Symbol.process]', () => {
      assert.ok((Map as any)[Symbol.process]);
      assert.equal((Map as any)[Symbol.process].name, 'justscale.Map');
    });

    it('Set has [Symbol.process]', () => {
      assert.ok((Set as any)[Symbol.process]);
      assert.equal((Set as any)[Symbol.process].name, 'justscale.Set');
    });

    it('Reference has [Symbol.process]', () => {
      assert.ok((Reference as any)[Symbol.process]);
      assert.equal((Reference as any)[Symbol.process].name, 'justscale.Reference');
    });
  });

  describe('Date round-trip via state serializer', () => {
    it('serializes with __types metadata', () => {
      const d = new Date('2025-06-15T12:00:00Z');
      const serialized = serializeState({ created: d });
      assert.ok(serialized.__$processTypes);
      assert.equal((serialized.__$processTypes as Record<string, string>).created, 'justscale.Date');
    });

    it('round-trips through JSONB', () => {
      const d = new Date('2025-06-15T12:00:00Z');
      const result = roundTrip({ created: d, name: 'test' });
      assert.ok(result.created instanceof Date);
      assert.equal((result.created as Date).toISOString(), '2025-06-15T12:00:00.000Z');
      assert.equal(result.name, 'test');
    });
  });

  describe('Map round-trip via state serializer', () => {
    it('round-trips through JSONB', () => {
      const m = new Map([['a', 1], ['b', 2]]);
      const result = roundTrip({ data: m });
      assert.ok(result.data instanceof Map);
      assert.equal((result.data as Map<string, number>).get('a'), 1);
      assert.equal((result.data as Map<string, number>).get('b'), 2);
    });
  });

  describe('Set round-trip via state serializer', () => {
    it('round-trips through JSONB', () => {
      const s = new Set([1, 2, 3]);
      const result = roundTrip({ tags: s });
      assert.ok(result.tags instanceof Set);
      assert.ok((result.tags as Set<number>).has(1));
      assert.ok((result.tags as Set<number>).has(2));
      assert.ok((result.tags as Set<number>).has(3));
    });
  });

  describe('Reference round-trip via state serializer', () => {
    it('serializes with __types metadata', () => {
      const ref = new Reference<unknown>('user-123');
      const serialized = serializeState({ author: ref });
      assert.ok(serialized.__$processTypes);
      assert.equal((serialized.__$processTypes as Record<string, string>).author, 'justscale.Reference');
    });

    it('round-trips through JSONB', () => {
      const ref = new Reference<unknown>('user-123');
      const result = roundTrip({ author: ref });
      assert.ok(result.author instanceof Reference);
      assert.equal((result.author as Reference<unknown>).identifier, 'user-123');
    });
  });

  describe('BigInt registration', () => {
    it('BigInt descriptor is registered', () => {
      assert.ok(getProcessDescriptor('justscale.BigInt'));
    });

    it('BigInt descriptor round-trips', () => {
      const desc = getProcessDescriptor('justscale.BigInt')!;
      const serialized = desc.serialize(42n as any);
      const restored = desc.deserialize(serialized);
      assert.equal(restored, 42n);
    });
  });

  describe('nested builtins', () => {
    it('handles Reference nested inside a plain object', () => {
      const data = { author: new Reference<unknown>('user-789'), title: 'hi' };
      const result = roundTrip({ post: data });
      const restored = result.post as { author: Reference<unknown>; title: string };
      assert.ok(restored.author instanceof Reference);
      assert.equal(restored.author.identifier, 'user-789');
      assert.equal(restored.title, 'hi');
    });

    it('handles Date nested inside an array', () => {
      const dates = [new Date('2025-01-01'), new Date('2025-06-01')];
      const result = roundTrip({ dates });
      const restored = result.dates as Date[];
      assert.ok(restored[0] instanceof Date);
      assert.ok(restored[1] instanceof Date);
      assert.equal(restored[0].getFullYear(), 2025);
    });
  });

  describe('mixed builtins', () => {
    it('round-trips multiple builtin types together', () => {
      const vars = {
        created: new Date('2025-01-01'),
        tags: new Set(['important', 'urgent']),
        meta: new Map([['priority', 'high']]),
        author: new Reference<unknown>('user-456'),
        title: 'Hello World',
        count: 42,
      };
      const result = roundTrip(vars);

      assert.ok(result.created instanceof Date);
      assert.ok(result.tags instanceof Set);
      assert.ok(result.meta instanceof Map);
      assert.ok(result.author instanceof Reference);
      assert.equal(result.title, 'Hello World');
      assert.equal(result.count, 42);

      assert.equal((result.created as Date).getFullYear(), 2025);
      assert.ok((result.tags as Set<string>).has('important'));
      assert.equal((result.meta as Map<string, string>).get('priority'), 'high');
      assert.equal((result.author as Reference<unknown>).identifier, 'user-456');
    });
  });
});
