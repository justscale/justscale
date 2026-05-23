/**
 * Queue × Processable — message serialization round-trip edges.
 *
 * Queues become durable inside process handlers via Symbol.process. The
 * queue's own descriptor serializes `items` verbatim — so any payload inside
 * must either be (a) plain JSON, (b) Processable at the top level, or
 * (c) it will SILENTLY LOSE FIDELITY. These tests pin exactly what survives.
 *
 * The Processable protocol (src/process/serialization.ts) only encodes the
 * value itself at the CALL SITE — it does not walk nested structures. So
 * a Queue<Date>, Queue<Map>, Queue<BigInt> that stores raw items will lose
 * class identity when the queue itself is serialized into a process snapshot.
 * This file pins that gap; a fix is a separate PR.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createQueue, Queue } from '../../src/queue/index.js';
import {
  encodeProcessable,
  decodeProcessable,
  findProcessDescriptor,
} from '../../src/process/serialization.js';
// Side-effect: register builtins (Date, Map, Set, Reference, BigInt)
import '../../src/process/builtin-serializers.js';

const descriptorFor = <T>(_q: Queue<T>): ProcessDescriptor<Queue<T>> =>
  (Queue as any)[Symbol.process] as ProcessDescriptor<Queue<T>>;

describe('Queue Processable round-trip', () => {
  it('queue instances expose a process descriptor via findProcessDescriptor', () => {
    const q = createQueue<number>([1, 2]);
    const d = findProcessDescriptor(q);
    assert.ok(d, 'Queue instance must be discoverable as Processable');
    assert.strictEqual(d!.name, 'Queue');
  });

  it('plain-object message: serialize -> deserialize preserves shape', async () => {
    const q = createQueue<{ id: number; name: string }>([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    const d = descriptorFor(q);
    const wire = d.serialize(q);
    const restored = d.deserialize(wire);
    assert.strictEqual(restored.length, 2);
    const items: { id: number; name: string }[] = [];
    for await (const v of restored) {
      items.push(v);
      if (items.length === 2) break;
    }
    assert.deepStrictEqual(items, [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
  });

  it('Date message: raw serialize DROPS class identity (baseline gap)', async () => {
    // This pins the current reality: the queue descriptor doesn't walk items.
    // If/when queues grow nested Processable encoding, this test flips.
    const d = Date.now();
    const q = createQueue<Date>([new Date(d)]);
    const wire = descriptorFor(q).serialize(q);

    // Round-trip the whole wire through JSON (simulates storage).
    const json = JSON.parse(JSON.stringify(wire));
    const restored = descriptorFor(q).deserialize(json);
    const first = (restored as any).items[0];
    assert.strictEqual(typeof first, 'string', 'Date becomes ISO string after JSON');
    assert.ok(!(first instanceof Date));
    // todo(queue): nested Processable encoding — queue items should be walked
    // through encodeProcessable so Date survives JSON round-trip.
  });

  it('BigInt message: raw serialize crashes on JSON.stringify (baseline gap)', () => {
    // BigInt is not JSON-serializable. The queue serializer spreads items as-is,
    // so storing the snapshot must throw at the JSON boundary. Pins the gap.
    const q = createQueue<bigint>([1n, 2n, 3n]);
    const wire = descriptorFor(q).serialize(q);
    assert.throws(() => JSON.stringify(wire), /BigInt/);
    // todo(queue): items containing bigint should be encoded via the
    // 'justscale.BigInt' descriptor so the snapshot is JSON-safe.
  });

  it('Map message: raw serialize produces an empty object after JSON (gap)', () => {
    const q = createQueue<Map<string, number>>([new Map([['a', 1], ['b', 2]])]);
    const wire = descriptorFor(q).serialize(q);
    const json = JSON.parse(JSON.stringify(wire));
    const restored = descriptorFor(q).deserialize(json);
    const first = (restored as any).items[0];
    // Maps stringify to '{}' — data is lost.
    assert.ok(!(first instanceof Map));
    assert.deepStrictEqual(first, {});
    // todo(queue): Map/Set items silently collapse to {} through JSON.
  });

  it('Set message: same gap as Map', () => {
    const q = createQueue<Set<number>>([new Set([1, 2, 3])]);
    const wire = descriptorFor(q).serialize(q);
    const json = JSON.parse(JSON.stringify(wire));
    const restored = descriptorFor(q).deserialize(json);
    const first = (restored as any).items[0];
    assert.ok(!(first instanceof Set));
    assert.deepStrictEqual(first, {});
  });

  it('nested Processable class inside a plain-object message loses identity (gap)', () => {
    // Sibling-agent Processable finding #2: nested Processable is not walked.
    class Money {
      constructor(public cents: bigint, public currency: string) {}
      static [Symbol.process]: ProcessDescriptor<Money> = {
        name: 'test.Money',
        serialize: (m) => ({ c: m.cents.toString(), cur: m.currency }),
        deserialize: (d: any) => new Money(BigInt(d.c), d.cur),
      };
    }

    const q = createQueue<{ meta: string; amount: Money }>([
      { meta: 'm1', amount: new Money(100n, 'EUR') },
    ]);
    const wire = descriptorFor(q).serialize(q);
    // Simulate what happens if a caller json-serialises the snapshot:
    // Money.cents is a BigInt nested 3 levels deep; throws.
    assert.throws(() => JSON.stringify(wire), /BigInt/);
    // todo(processable): nested Processable types should be walked by the
    // queue item serializer (or by encodeProcessable's recursive form).
  });

  it('function inside a message is dropped silently by JSON', () => {
    const q = createQueue<{ op: string; cb: () => void }>([
      { op: 'go', cb: () => 42 },
    ]);
    const wire = descriptorFor(q).serialize(q);
    const json = JSON.parse(JSON.stringify(wire));
    const restored = descriptorFor(q).deserialize(json);
    const first = (restored as any).items[0];
    assert.strictEqual(first.op, 'go');
    assert.strictEqual(first.cb, undefined, 'function silently dropped');
    // todo(queue): non-serialisable message payloads should error at enqueue,
    // not silently drop properties at deserialisation.
  });

  it('Queue inside Queue leaks internal state (items/waiter/closed/consuming) through JSON', () => {
    // Finding (bug-shape, pinned): the outer descriptor does not recurse.
    // JSON.stringify then walks the inner Queue as a bare instance and
    // captures every enumerable own property — including waiter/closed/
    // consuming. Those are implementation details that must NOT be on
    // the wire.
    const inner = createQueue<number>([7, 8, 9]);
    const outer = createQueue<Queue<number>>([inner]);
    const wire = descriptorFor(outer).serialize(outer);
    const json = JSON.parse(JSON.stringify(wire));
    const restored = descriptorFor(outer).deserialize(json);
    const nested = (restored as any).items[0];
    assert.ok(!(nested instanceof Queue), 'inner queue lost class identity');
    // Pin the leaked shape — implementation-detail fields escape the abstraction.
    assert.deepStrictEqual(nested, {
      items: [7, 8, 9],
      waiter: null,
      closed: false,
      consuming: false,
    });
    // todo(queue): internal Queue fields (waiter/closed/consuming) should
    // be non-enumerable OR nested Queues should be encoded via their
    // descriptor, not bare JSON walk.
  });

  it('encodeProcessable(queue) produces a tagged envelope that decode restores', () => {
    const q = createQueue<string>(['hi', 'there']);
    const encoded = encodeProcessable(q) as Record<string, unknown>;
    assert.ok('__$p' in encoded, 'encoded value must carry the payload tag');
    assert.strictEqual(encoded['__$p'], 'Queue');

    const json = JSON.parse(JSON.stringify(encoded));
    const restored = decodeProcessable(json) as Queue<string>;
    assert.ok(restored instanceof Queue);
    assert.strictEqual(restored.length, 2);
  });

  it('decoding an unknown descriptor name throws (proc-3: silent pass-through hides registration bugs)', () => {
    // The decoder must throw for unrecognised __$p names so that "forgot to register"
    // is immediately visible rather than silently returning an inert envelope.
    const mystery = { __$p: 'nonexistent.Type', d: { foo: 1 } };
    assert.throws(
      () => decodeProcessable(mystery),
      /Unknown descriptor 'nonexistent\.Type'/,
    );
  });

  it('serialize does not share array reference with the live queue', () => {
    const q = createQueue<number>([1, 2, 3]);
    const wire = descriptorFor(q).serialize(q) as { items: number[] };
    wire.items.push(999);
    // Mutating the serialized snapshot must not leak back into the live queue.
    assert.strictEqual(q.length, 3);
  });

  it('serialize of an emptied queue returns items: []', async () => {
    const q = createQueue<number>([1]);
    for await (const _ of q) break;
    assert.strictEqual(q.length, 0);
    assert.deepStrictEqual(descriptorFor(q).serialize(q), { items: [] });
  });

  it('deserialise preserves undefined/null item placeholders', () => {
    // Pins: the snapshot format is items-as-array with positional truth.
    // If someone swaps to sparse handling later, these positions matter.
    const wire = { items: [null, undefined, 0, false, ''] as unknown[] };
    const restored = (Queue as any)[Symbol.process].deserialize(wire) as Queue<unknown>;
    // Note: JSON.stringify({items:[undefined]}) becomes {items:[null]} — we
    // assert only on the in-memory path here.
    assert.strictEqual(restored.length, 5);
  });
});
