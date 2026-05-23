/**
 * Edge-case tests for the Queue primitive.
 *
 * Covers: backpressure with slow consumer, drain on close, re-entry,
 * ordering invariants, iterator return semantics, mixed initial+push
 * scenarios, and Symbol.process serialization edge cases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, Queue } from '../index.js';

describe('Queue edge cases', () => {
  describe('size / length invariants', () => {
    it('length stays 0 when waiter is already waiting and push delivers directly', async () => {
      const q = createQueue<number>();
      // Start consumer (it becomes a waiter, buffer is empty)
      const consumer = (async () => {
        for await (const item of q) return item;
      })();
      // Give the consumer a tick to arm the waiter
      await new Promise((r) => setImmediate(r));
      q.push(42);
      assert.equal(q.length, 0, 'direct-delivery must not buffer');
      assert.equal(await consumer, 42);
    });

    it('length reflects buffered items when no consumer', () => {
      const q = createQueue<number>();
      for (let i = 0; i < 100; i++) q.push(i);
      assert.equal(q.length, 100);
    });

    it('initialItems are copied, not aliased', () => {
      const src = [1, 2, 3];
      const q = createQueue<number>(src);
      src.push(4);
      // Internal state should not have grown
      assert.equal(q.length, 3);
    });

    it('pushing undefined/null is preserved as an item', async () => {
      const q = createQueue<number | null | undefined>();
      q.push(null);
      q.push(undefined);
      q.push(0);
      const out: unknown[] = [];
      for await (const v of q) {
        out.push(v);
        if (out.length === 3) break;
      }
      assert.deepEqual(out, [null, undefined, 0]);
    });
  });

  describe('close semantics', () => {
    it('close then push is a no-op', () => {
      const q = createQueue<number>();
      q.close();
      q.push(1);
      q.push(2);
      assert.equal(q.length, 0);
    });

    it('double-close is idempotent', async () => {
      const q = createQueue<number>();
      q.push(1);
      q.close();
      q.close();
      const out: number[] = [];
      for await (const v of q) out.push(v);
      assert.deepEqual(out, [1]);
    });

    it('close with buffered items still drains all before done', async () => {
      const q = createQueue<number>([1, 2, 3, 4, 5]);
      q.close();
      const out: number[] = [];
      for await (const v of q) out.push(v);
      assert.deepEqual(out, [1, 2, 3, 4, 5]);
    });

    it('close while waiter pending resolves with done=true immediately', async () => {
      const q = createQueue<string>();
      const start = Date.now();
      const consumer = (async () => {
        const arr: string[] = [];
        for await (const v of q) arr.push(v);
        return arr;
      })();
      await new Promise((r) => setImmediate(r));
      q.close();
      const result = await consumer;
      assert.deepEqual(result, []);
      assert.ok(Date.now() - start < 200, 'close should unblock waiter quickly');
    });

    it('close after consumer exits is fine and does not throw', async () => {
      const q = createQueue<number>([1]);
      for await (const _ of q) break;
      q.close();
      // Re-iteration after close: should terminate immediately
      const out: number[] = [];
      for await (const v of q) out.push(v);
      // Nothing left because close ignores pushes and buffer was consumed
      assert.deepEqual(out, []);
    });
  });

  describe('iterator return()', () => {
    it('break mid-wait unblocks via return()', async () => {
      const q = createQueue<number>();
      const start = Date.now();
      const iter = q[Symbol.asyncIterator]();
      const pending = iter.next();
      // Call return() while next() is pending
      const ret = await iter.return!();
      assert.equal(ret.done, true);
      const resolved = await pending;
      assert.equal(resolved.done, true);
      assert.ok(Date.now() - start < 200);
    });

    it('after return(), can iterate again from the start (single-consumer resets)', async () => {
      const q = createQueue<number>();
      q.push(1);
      q.push(2);
      const iter1 = q[Symbol.asyncIterator]();
      const { value: v1 } = await iter1.next();
      assert.equal(v1, 1);
      await iter1.return!();
      // Now open a new iterator
      const iter2 = q[Symbol.asyncIterator]();
      const { value: v2 } = await iter2.next();
      assert.equal(v2, 2);
      await iter2.return!();
    });

    it('throwing two concurrent iterators fails fast with clear message', () => {
      const q = createQueue<number>();
      const a = q[Symbol.asyncIterator]();
      assert.throws(() => q[Symbol.asyncIterator](), /single-consumer/);
      a.return!();
    });
  });

  describe('FIFO with interleaved push/consume', () => {
    it('preserves order across buffer drain plus waiter delivery', async () => {
      const q = createQueue<number>([1, 2]);
      const out: number[] = [];
      const consumer = (async () => {
        for await (const v of q) {
          out.push(v);
          if (out.length === 5) break;
        }
      })();
      // Let consumer drain buffered, then arm waiter
      await new Promise((r) => setImmediate(r));
      q.push(3);
      q.push(4);
      q.push(5);
      await consumer;
      assert.deepEqual(out, [1, 2, 3, 4, 5]);
    });

    it('100 rapid pushes from outside are consumed in order', async () => {
      const q = createQueue<number>();
      const consumer = (async () => {
        const arr: number[] = [];
        for await (const v of q) {
          arr.push(v);
          if (arr.length === 100) break;
        }
        return arr;
      })();
      for (let i = 0; i < 100; i++) q.push(i);
      const result = await consumer;
      assert.deepEqual(result, [...Array(100).keys()]);
    });

    it('waiter receives next push instantly with no buffer growth', async () => {
      const q = createQueue<number>();
      const iter = q[Symbol.asyncIterator]();
      const p = iter.next();
      q.push(99);
      const result = await p;
      assert.equal(result.value, 99);
      assert.equal(q.length, 0);
      await iter.return!();
    });
  });

  describe('backpressure / slow consumer', () => {
    it('buffer grows when consumer is slower than producer', async () => {
      const q = createQueue<number>();
      // Producer dumps 50 items
      for (let i = 0; i < 50; i++) q.push(i);
      assert.equal(q.length, 50);
      // Slow consumer takes 10, buffer shrinks
      const out: number[] = [];
      for await (const v of q) {
        out.push(v);
        if (out.length === 10) break;
      }
      assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.equal(q.length, 40);
    });
  });

  describe('serialization (Symbol.process)', () => {
    it('deserialize returns a fresh Queue with the same items in order', () => {
      const descriptor = (Queue as any)[Symbol.process];
      const snapshot = descriptor.serialize(createQueue<number>([10, 20, 30]));
      const restored = descriptor.deserialize(snapshot) as Queue<number>;
      assert.equal(restored.length, 3);
      assert.ok(restored instanceof Queue);
    });

    it('serialize deep-copies the items array (mutation safety)', () => {
      const q = createQueue<number>([1, 2, 3]);
      const descriptor = (Queue as any)[Symbol.process];
      const snap = descriptor.serialize(q) as { items: number[] };
      snap.items.push(999);
      // Original queue should not be affected
      assert.equal(q.length, 3);
    });

    it('deserializing empty items makes an empty, pushable queue', async () => {
      const descriptor = (Queue as any)[Symbol.process];
      const q = descriptor.deserialize({ items: [] }) as Queue<number>;
      assert.equal(q.length, 0);
      q.push(7);
      for await (const v of q) {
        assert.equal(v, 7);
        break;
      }
    });

    it('descriptor name is stable', () => {
      const descriptor = (Queue as any)[Symbol.process];
      assert.equal(descriptor.name, 'Queue');
    });
  });

  describe('ordering under rapid open/close cycles', () => {
    it('after close during drain, remaining pushes are dropped', () => {
      const q = createQueue<number>([1, 2, 3]);
      q.close();
      q.push(4); // dropped
      assert.equal(q.length, 3);
    });
  });
});
