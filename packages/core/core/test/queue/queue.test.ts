import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createQueue, Queue } from '../../src/queue/index.js';

describe('Queue', () => {
  describe('basic FIFO', () => {
    it('should push and consume items in order', async () => {
      const q = createQueue<string>();
      q.push('a');
      q.push('b');
      q.push('c');

      const results: string[] = [];
      let count = 0;
      for await (const item of q) {
        results.push(item);
        count++;
        if (count >= 3) break;
      }

      assert.deepStrictEqual(results, ['a', 'b', 'c']);
    });

    it('should remove items after consumption', async () => {
      const q = createQueue<number>();
      q.push(1);
      q.push(2);
      assert.strictEqual(q.length, 2);

      for await (const _item of q) {
        break; // consume one
      }

      assert.strictEqual(q.length, 1);
    });

    it('should report correct length', () => {
      const q = createQueue<string>();
      assert.strictEqual(q.length, 0);
      q.push('a');
      assert.strictEqual(q.length, 1);
      q.push('b');
      assert.strictEqual(q.length, 2);
    });

    it('should accept initial items', async () => {
      const q = createQueue<number>([10, 20, 30]);
      assert.strictEqual(q.length, 3);

      const results: number[] = [];
      for await (const item of q) {
        results.push(item);
        if (results.length >= 3) break;
      }
      assert.deepStrictEqual(results, [10, 20, 30]);
    });
  });

  describe('async waiting', () => {
    it('should wait for items when buffer is empty', async () => {
      const q = createQueue<number>();

      const consumer = (async () => {
        const results: number[] = [];
        for await (const item of q) {
          results.push(item);
          if (results.length >= 2) break;
        }
        return results;
      })();

      // Push after consumer starts waiting
      setTimeout(() => q.push(1), 10);
      setTimeout(() => q.push(2), 20);

      const results = await consumer;
      assert.deepStrictEqual(results, [1, 2]);
    });

    it('should deliver push directly to waiting consumer', async () => {
      const q = createQueue<string>();

      // Start consuming — will wait since buffer is empty
      const consumer = (async () => {
        for await (const item of q) {
          return item;
        }
      })();

      // Push while consumer is waiting
      q.push('direct');

      const result = await consumer;
      assert.strictEqual(result, 'direct');
      assert.strictEqual(q.length, 0); // not buffered
    });
  });

  describe('close', () => {
    it('should end iteration after close and drain', async () => {
      const q = createQueue<number>();
      q.push(1);
      q.push(2);
      q.close();

      const results: number[] = [];
      for await (const item of q) {
        results.push(item);
      }

      assert.deepStrictEqual(results, [1, 2]);
    });

    it('should resolve pending waiter on close', async () => {
      const q = createQueue<string>();

      const consumer = (async () => {
        const results: string[] = [];
        for await (const item of q) {
          results.push(item);
        }
        return results;
      })();

      // Close while consumer is waiting
      setTimeout(() => q.close(), 10);

      const results = await consumer;
      assert.deepStrictEqual(results, []);
    });

    it('should ignore pushes after close', () => {
      const q = createQueue<string>();
      q.close();
      q.push('ignored');
      assert.strictEqual(q.length, 0);
    });
  });

  describe('single consumer', () => {
    it('should throw on concurrent iteration', () => {
      const q = createQueue<string>();
      q.push('a');

      // First iterator is fine
      const iter1 = q[Symbol.asyncIterator]();

      // Second iterator should throw
      assert.throws(() => {
        q[Symbol.asyncIterator]();
      }, /single-consumer/);

      // Clean up
      iter1.return!();
    });

    it('should allow re-iteration after previous iterator ends', async () => {
      const q = createQueue<number>();
      q.push(1);

      // First consumer
      for await (const _item of q) {
        break;
      }

      // Second consumer should work
      q.push(2);
      for await (const item of q) {
        assert.strictEqual(item, 2);
        break;
      }
    });
  });

  describe('cleanup', () => {
    it('should support iterator return (break from for-await)', async () => {
      const q = createQueue<number>();
      q.push(1);
      q.push(2);
      q.push(3);

      for await (const _item of q) {
        break; // triggers return()
      }

      // Should be able to iterate again
      assert.strictEqual(q.length, 2); // 2 and 3 still in buffer
    });
  });

  describe('serialization', () => {
    it('should have Symbol.process descriptor', () => {
      const descriptor = (Queue as any)[Symbol.process];
      assert.ok(descriptor, 'Queue should have Symbol.process');
      assert.strictEqual(descriptor.name, 'Queue');
      assert.strictEqual(typeof descriptor.serialize, 'function');
      assert.strictEqual(typeof descriptor.deserialize, 'function');
    });

    it('should serialize and deserialize correctly', () => {
      const q = createQueue<string>(['x', 'y', 'z']);
      const descriptor = (Queue as any)[Symbol.process];

      const serialized = descriptor.serialize(q);
      assert.deepStrictEqual(serialized, { items: ['x', 'y', 'z'] });

      const restored = descriptor.deserialize(serialized) as Queue<string>;
      assert.strictEqual(restored.length, 3);
    });

    it('should only serialize unconsumed items', async () => {
      const q = createQueue<number>([1, 2, 3]);
      const descriptor = (Queue as any)[Symbol.process];

      // Consume one item
      for await (const _item of q) {
        break;
      }

      const serialized = descriptor.serialize(q);
      assert.deepStrictEqual(serialized, { items: [2, 3] });
    });
  });
});
