/**
 * DataLoader Tests
 *
 * Tests for the DataLoader batching and caching functionality.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { DataLoader } from '../src/query/dataloader.js';

describe('DataLoader', () => {
  describe('Basic functionality', () => {
    test('should load a single ID', async () => {
      const batchFn = async (ids: string[]) => {
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);
      const result = await loader.load('1');
      assert.strictEqual(result, 'value-1');
    });

    test('should return null for not found IDs', async () => {
      const batchFn = async (ids: string[]) => {
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, id === '1' ? 'value-1' : null);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);
      const result = await loader.load('999');
      assert.strictEqual(result, null);
    });

    test('should load multiple IDs', async () => {
      const batchFn = async (ids: string[]) => {
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);
      const results = await loader.loadMany(['1', '2', '3']);
      assert.deepStrictEqual(results, ['value-1', 'value-2', 'value-3']);
    });
  });

  describe('Batching', () => {
    test('should batch multiple load() calls in same tick', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      // These three calls happen in the same tick, should be batched
      const promise1 = loader.load('1');
      const promise2 = loader.load('2');
      const promise3 = loader.load('3');

      const results = await Promise.all([promise1, promise2, promise3]);

      assert.deepStrictEqual(results, ['value-1', 'value-2', 'value-3']);
      assert.strictEqual(batchCallCount, 1, 'Should only call batch function once');
    });

    test('should batch Promise.all calls', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      const results = await Promise.all([
        loader.load('1'),
        loader.load('2'),
        loader.load('3'),
      ]);

      assert.deepStrictEqual(results, ['value-1', 'value-2', 'value-3']);
      assert.strictEqual(batchCallCount, 1, 'Should only call batch function once');
    });

    test('should handle duplicate IDs in same batch', async () => {
      let batchCallCount = 0;
      const receivedIds: string[][] = [];
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        receivedIds.push([...ids]);
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      // Load same ID multiple times in same tick
      const promise1 = loader.load('1');
      const promise2 = loader.load('1');
      const promise3 = loader.load('2');

      const results = await Promise.all([promise1, promise2, promise3]);

      assert.deepStrictEqual(results, ['value-1', 'value-1', 'value-2']);
      assert.strictEqual(batchCallCount, 1, 'Should only call batch function once');
      // Should deduplicate IDs in batch
      assert.strictEqual(receivedIds[0].filter((id) => id === '1').length, 1);
    });

    test('should create separate batches across different ticks', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      // First batch
      const result1 = await loader.load('1');
      assert.strictEqual(result1, 'value-1');
      assert.strictEqual(batchCallCount, 1);

      // Second batch (different tick)
      const result2 = await loader.load('2');
      assert.strictEqual(result2, 'value-2');
      assert.strictEqual(batchCallCount, 2);
    });
  });

  describe('Caching', () => {
    test('should cache loaded values', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      const result1 = await loader.load('1');
      const result2 = await loader.load('1');
      const result3 = await loader.load('1');

      assert.strictEqual(result1, 'value-1');
      assert.strictEqual(result2, 'value-1');
      assert.strictEqual(result3, 'value-1');
      assert.strictEqual(batchCallCount, 1, 'Should only call batch function once');
    });

    test('should cache null values', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, null);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      const result1 = await loader.load('999');
      const result2 = await loader.load('999');

      assert.strictEqual(result1, null);
      assert.strictEqual(result2, null);
      assert.strictEqual(batchCallCount, 1, 'Should only call batch function once');
    });

    test('should clear cache', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      await loader.load('1');
      assert.strictEqual(batchCallCount, 1);

      loader.clear();

      await loader.load('1');
      assert.strictEqual(batchCallCount, 2, 'Should call batch function again after clear');
    });

    test('should prime cache with known values', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      // Prime the cache
      loader.prime('1', 'primed-value');

      const result = await loader.load('1');
      assert.strictEqual(result, 'primed-value');
      assert.strictEqual(batchCallCount, 0, 'Should not call batch function for primed value');
    });

    test('should mix primed and loaded values', async () => {
      let batchCallCount = 0;
      const batchFn = async (ids: string[]) => {
        batchCallCount++;
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      // Prime one value
      loader.prime('1', 'primed-value');

      // Load primed and non-primed values
      const results = await Promise.all([
        loader.load('1'), // primed
        loader.load('2'), // needs loading
        loader.load('3'), // needs loading
      ]);

      assert.deepStrictEqual(results, ['primed-value', 'value-2', 'value-3']);
      assert.strictEqual(batchCallCount, 1, 'Should only call batch function once for non-primed values');
    });
  });

  describe('Error handling', () => {
    test('should propagate errors from batch function', async () => {
      const batchFn = async () => {
        throw new Error('Batch failed');
      };

      const loader = new DataLoader(batchFn);

      await assert.rejects(
        async () => await loader.load('1'),
        { message: 'Batch failed' },
      );
    });

    test('should reject all pending promises on error', async () => {
      const batchFn = async () => {
        throw new Error('Batch failed');
      };

      const loader = new DataLoader(batchFn);

      const promise1 = loader.load('1');
      const promise2 = loader.load('2');
      const promise3 = loader.load('3');

      await assert.rejects(async () => await promise1, { message: 'Batch failed' });
      await assert.rejects(async () => await promise2, { message: 'Batch failed' });
      await assert.rejects(async () => await promise3, { message: 'Batch failed' });
    });

    test('should allow retrying after error', async () => {
      let attemptCount = 0;
      const batchFn = async (ids: string[]) => {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error('First attempt failed');
        }
        const map = new Map<string, string | null>();
        for (const id of ids) {
          map.set(id, `value-${id}`);
        }
        return map;
      };

      const loader = new DataLoader(batchFn);

      // First attempt should fail
      await assert.rejects(
        async () => await loader.load('1'),
        { message: 'First attempt failed' },
      );

      // Second attempt should succeed
      const result = await loader.load('1');
      assert.strictEqual(result, 'value-1');
      assert.strictEqual(attemptCount, 2);
    });
  });

  describe('Complex types', () => {
    test('should work with object values', async () => {
      interface User {
        id: string
        name: string
      }

      const batchFn = async (ids: string[]) => {
        const map = new Map<string, User | undefined>();
        for (const id of ids) {
          map.set(id, { id, name: `User ${id}` });
        }
        return map;
      };

      const loader = new DataLoader<User>(batchFn);

      const user = await loader.load('123');
      assert.deepStrictEqual(user, { id: '123', name: 'User 123' });
    });

    test('should work with arrays', async () => {
      const batchFn = async (ids: string[]) => {
        const map = new Map<string, string[] | undefined>();
        for (const id of ids) {
          map.set(id, [`item-${id}-1`, `item-${id}-2`]);
        }
        return map;
      };

      const loader = new DataLoader<string[]>(batchFn);

      const items = await loader.load('1');
      assert.deepStrictEqual(items, ['item-1-1', 'item-1-2']);
    });
  });
});
