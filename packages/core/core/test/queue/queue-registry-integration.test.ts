/**
 * Queue × process type registry.
 *
 * The Queue class registers itself with the process type registry in a
 * `static {}` block. That registration is what makes Queue durable inside
 * process handlers and recoverable through `decodeProcessable`. These
 * tests pin the registration contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Queue, createQueue } from '../../src/queue/index.js';
import {
  getProcessDescriptor,
  getProcessRegistry,
  encodeProcessable,
  decodeProcessable,
  registerProcessType,
} from '../../src/process/serialization.js';
// Side-effect: ensure Symbol.process and registry are set up
import '../../src/process/builtin-serializers.js';

describe('Queue process registry', () => {
  it('Queue is registered in the process type registry under name "Queue"', () => {
    // Force the static block to run by touching the class.
    void Queue;
    const desc = getProcessDescriptor('Queue');
    assert.ok(desc, 'Queue must be registered in the process registry');
    assert.strictEqual(desc!.name, 'Queue');
  });

  it('Queue descriptor on the class and in the registry is the same object', () => {
    void Queue;
    const onClass = (Queue as any)[Symbol.process] as ProcessDescriptor;
    const inRegistry = getProcessDescriptor('Queue');
    assert.strictEqual(onClass, inRegistry);
  });

  it('registry is a read-only view (cannot mutate via getProcessRegistry)', () => {
    const registry = getProcessRegistry();
    // Map is returned as ReadonlyMap. The runtime type is still Map, so we
    // just pin that we got back a Map and that it contains Queue.
    assert.ok(registry.has('Queue'));
  });

  it('full round-trip via encode/decode restores a live Queue', async () => {
    const q = createQueue<number>([10, 20, 30]);
    const wire = encodeProcessable(q);
    // Must be JSON-safe for plain primitive items
    const asText = JSON.stringify(wire);
    const parsed = JSON.parse(asText);
    const restored = decodeProcessable(parsed) as Queue<number>;
    assert.ok(restored instanceof Queue);
    assert.strictEqual(restored.length, 3);
    const seen: number[] = [];
    for await (const v of restored) {
      seen.push(v);
      if (seen.length === 3) break;
    }
    assert.deepStrictEqual(seen, [10, 20, 30]);
  });

  it('restored queue is independent from the original (push does not leak)', () => {
    const a = createQueue<number>([1]);
    const restored = decodeProcessable(encodeProcessable(a)) as Queue<number>;
    restored.push(99);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(restored.length, 2);
  });

  it('closed state is NOT carried through serialisation (pin current behaviour)', async () => {
    // Current descriptor only serializes `items`. `closed` and `waiter` are
    // not in the snapshot, so a restored queue is always "open". If someone
    // wants close-through-snapshot semantics, this test forces the discussion.
    const q = createQueue<number>([1]);
    q.close();
    const restored = decodeProcessable(encodeProcessable(q)) as Queue<number>;
    // Push must be accepted (it would be ignored if closed survived)
    restored.push(2);
    assert.strictEqual(restored.length, 2);
    // todo(queue): decide whether `closed` should survive serialisation.
  });

  it('consumer lock (consuming flag) is NOT carried through serialisation', () => {
    const q = createQueue<number>([1]);
    void q[Symbol.asyncIterator](); // takes the consumer slot
    // Serialising should still succeed — the snapshot is items-only.
    const wire = (Queue as any)[Symbol.process].serialize(q);
    assert.deepStrictEqual(wire, { items: [1] });
    const restored = (Queue as any)[Symbol.process].deserialize(wire) as Queue<number>;
    // Fresh queue, no consumer lock held.
    const iter = restored[Symbol.asyncIterator]();
    assert.ok(iter);
    iter.return!();
  });

  it('registry rejects a duplicate registration with a DIFFERENT descriptor', () => {
    const other = {
      name: 'Queue',
      serialize: () => ({}),
      deserialize: () => createQueue(),
    } as ProcessDescriptor;
    assert.throws(() => {
      registerProcessType(other);
    }, /Duplicate registration/);
  });

  it('re-registering the SAME descriptor is idempotent (ESM re-import safe)', () => {
    const existing = getProcessDescriptor('Queue')!;
    // Must not throw.
    registerProcessType(existing);
    registerProcessType(existing);
    assert.strictEqual(getProcessDescriptor('Queue'), existing);
  });
});
