/**
 * Processable protocol — CROSS-ADAPTER invariants.
 *
 * The same serialized bytes MUST round-trip identically regardless of
 * which adapter (pg, in-memory, redis) produced them. The serializer
 * lives in core — it's adapter-agnostic by design. Pin that contract
 * so a refactor that accidentally couples the serializer to a specific
 * adapter is caught.
 *
 * We simulate "two adapters" by using the same serialize functions but
 * verifying that the wire format is identical, parse-able as pure JSON,
 * and that the reconstructed objects are equivalent — regardless of
 * which side produced them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
  registerProcessType,
  getProcessDescriptor,
} from '../../../src/process/serialization.js';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';
import { Reference } from '../../../src/models/reference/reference.js';
import { PERSISTENT, ADAPTER_KEY } from '../../../src/models/symbols.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

describe('Cross-adapter — adapter-neutrality of serialized form', () => {
  it('INVARIANT: the serialized output is pure JSON — parse/stringify is a no-op on the wire', () => {
    const vars = {
      ref: new Reference<unknown>('user-xa'),
      created: new Date('2025-08-08T08:08:08Z'),
      count: 42n,
    };
    const serialized = serializeState(vars);
    const json = JSON.stringify(serialized);
    // Any adapter capable of storing a JSON string can round-trip this
    const back = JSON.parse(json);
    const restored = deserializeState(back);

    assert.ok(restored.ref instanceof Reference);
    assert.equal((restored.ref as Reference<unknown>).identifier, 'user-xa');
    assert.ok(restored.created instanceof Date);
    assert.equal(restored.count, 42n);
  });

  it('INVARIANT: Reference.identifier is a STABLE STRING — adapter-independent', () => {
    // Different adapters mustn't reformat the identifier (no "pg-" prefixes,
    // no base64 encoding, etc.). Pin the raw-string invariant.
    const ref = new Reference<unknown>('entity-abc-123');
    const encoded = encodeProcessable(ref) as Record<string, unknown>;
    const data = (encoded as any).d;
    assert.equal(data.id, 'entity-abc-123', 'identifier string must be stored as-is');
    assert.equal(typeof data.id, 'string');
  });

  it('INVARIANT: PersistentRef id is a STABLE STRING on the wire (no adapter namespacing)', () => {
    const entity = Object.create(null);
    Object.defineProperty(entity, PERSISTENT, { value: true });
    Object.defineProperty(entity, ADAPTER_KEY, { value: 'pg-entity-xyz' });

    const serialized = serializeState({ e: entity });
    const json = JSON.parse(JSON.stringify(serialized));
    assert.equal(json.e.id, 'pg-entity-xyz', 'ADAPTER_KEY flows through AS-IS, no mangling');
  });

  it('INVARIANT: same entity id → same wire bytes — two emitters produce identical payloads', () => {
    // Two different "processes" (on different adapters) emit the SAME
    // logical value. The serialized bytes must be identical character-
    // for-character so that idempotency keys / dedupe keys work.
    const ref1 = new Reference<unknown>('shared-id', 'SharedModel');
    const ref2 = new Reference<unknown>('shared-id', 'SharedModel');
    const json1 = JSON.stringify(encodeProcessable(ref1));
    const json2 = JSON.stringify(encodeProcessable(ref2));
    assert.equal(json1, json2, 'identical inputs must produce identical serialized bytes');
  });
});

describe('Cross-adapter — custom type registered globally is usable from any adapter', () => {
  class Money {
    constructor(public cents: number, public currency: string) {}
    static [Symbol.process]: ProcessDescriptor<Money> = {
      name: 'test.crossadapter.Money',
      serialize: (v: Money) => ({ c: v.cents, cur: v.currency }),
      deserialize: (d: any) => new Money(d.c, d.cur),
    };
  }
  registerProcessType(Money[Symbol.process]);

  it('INVARIANT: descriptor registered ONCE is reachable from "any" adapter (registry is process-global)', () => {
    // There's ONE registry per process. Pin that.
    const first = getProcessDescriptor('test.crossadapter.Money');
    const second = getProcessDescriptor('test.crossadapter.Money');
    assert.equal(first, second, 'registry must return the same descriptor every time');
  });

  it('INVARIANT: serialize on "adapter A" / deserialize on "adapter B" works as long as both imported builtin-serializers', () => {
    // Simulate adapter A emitting, adapter B receiving.
    const emittedOnA = JSON.stringify(encodeProcessable(new Money(599, 'EUR')));
    // On "adapter B", we take the bytes and decode them
    const received = decodeProcessable(JSON.parse(emittedOnA)) as Money;
    assert.ok(received instanceof Money);
    assert.equal(received.cents, 599);
    assert.equal(received.currency, 'EUR');
  });

  it('INVARIANT: deserializing on an adapter where the descriptor is NOT registered throws (proc-3)', () => {
    // Simulate: adapter B received a payload of type 'test.crossadapter.Ghost'
    // which is not in its registry. New behaviour: throw so the registration
    // bug is immediately visible. Silent pass-through made "forgot to register"
    // indistinguishable from "real data happens to have __$p".
    const ghostEnvelope = {
      __$p: 'test.crossadapter.Ghost-NotRegistered',
      d: { some: 'payload' },
    };
    assert.throws(
      () => decodeProcessable(ghostEnvelope),
      /Unknown descriptor 'test\.crossadapter\.Ghost-NotRegistered'/,
    );
  });
});

describe('Cross-adapter — wire format is self-describing', () => {
  it('INVARIANT: encoded envelope carries the descriptor NAME so a receiver can identify the type without shape inspection', () => {
    class Tagged {
      constructor(public n: number) {}
      static [Symbol.process]: ProcessDescriptor<Tagged> = {
        name: 'test.crossadapter.Tagged',
        serialize: (v: Tagged) => ({ n: v.n }),
        deserialize: (d: any) => new Tagged(d.n),
      };
    }
    registerProcessType(Tagged[Symbol.process]);

    const env = encodeProcessable(new Tagged(7)) as Record<string, unknown>;
    // The consumer sees __$p and can dispatch even before reading d.
    assert.equal(env.__$p, 'test.crossadapter.Tagged');
    assert.ok('d' in env);
  });

  it('INVARIANT: state-serializer top-level __$processTypes is a flat name-map — consumers can scan it without walking data', () => {
    const round = serializeState({
      a: new Date(0),
      b: 'plain',
      c: new Reference<unknown>('id-c'),
    });
    const types = round.__$processTypes as Record<string, string>;
    assert.equal(types.a, 'justscale.Date');
    assert.equal(types.c, 'justscale.Reference');
    // Plain values are NOT in the map
    assert.equal(types.b, undefined);
  });
});

describe('Cross-adapter — identifier stability across repeated round-trips', () => {
  it('INVARIANT: 10 serialize/deserialize cycles preserve the same Reference identifier', () => {
    let ref: Reference<unknown> | unknown = new Reference<unknown>('persistent-loop');
    for (let i = 0; i < 10; i++) {
      ref = decodeProcessable(JSON.parse(JSON.stringify(encodeProcessable(ref))));
      assert.ok(ref instanceof Reference, `iteration ${i} must preserve Reference type`);
      assert.equal((ref as Reference<unknown>).identifier, 'persistent-loop');
    }
  });

  it('INVARIANT: 10 state-serializer cycles preserve Date + BigInt + Reference', () => {
    let vars: Record<string, unknown> = {
      d: new Date('2025-01-01'),
      n: 999n,
      r: new Reference<unknown>('x'),
    };
    for (let i = 0; i < 10; i++) {
      vars = deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));
    }
    assert.ok(vars.d instanceof Date);
    assert.equal((vars.d as Date).toISOString(), '2025-01-01T00:00:00.000Z');
    assert.equal(vars.n, 999n);
    assert.ok(vars.r instanceof Reference);
    assert.equal((vars.r as Reference<unknown>).identifier, 'x');
  });
});
