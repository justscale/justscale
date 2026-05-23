import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../../src/runtime/process/storage.js';
import type { ProcessState } from '../../../src/process/types.js';

describe('InMemoryProcessStorage', () => {
  let storage: InMemoryProcessStorageInstance;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
  });

  const createTestState = (overrides: Partial<ProcessState> = {}): ProcessState => ({
    processId: 'test-process',
    instanceId: 'test-instance-1',
    version: '1.0.0',
    pc: 0,
    variables: {},
    timers: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    status: 'pending',
    ...overrides,
  });

  describe('save()', () => {
    it('saves a new process state', async () => {
      const state = createTestState();
      await storage.save(state);

      const loaded = await storage.load(state.instanceId);
      assert.ok(loaded);
      assert.strictEqual(loaded.instanceId, state.instanceId);
      assert.strictEqual(loaded.processId, state.processId);
    });

    it('updates an existing process state', async () => {
      const state = createTestState();
      await storage.save(state);

      state.pc = 5;
      state.status = 'running';
      await storage.save(state);

      const loaded = await storage.load(state.instanceId);
      assert.ok(loaded);
      assert.strictEqual(loaded.pc, 5);
      assert.strictEqual(loaded.status, 'running');
    });

    it('stores a copy, not a reference', async () => {
      const state = createTestState();
      await storage.save(state);

      state.pc = 999;
      const loaded = await storage.load(state.instanceId);
      assert.ok(loaded);
      assert.strictEqual(loaded.pc, 0); // Should be original value
    });

    it('updates the updatedAt timestamp', async () => {
      const originalDate = new Date('2024-01-01');
      const state = createTestState({ updatedAt: originalDate });
      await storage.save(state);

      const loaded = await storage.load(state.instanceId);
      assert.ok(loaded);
      assert.ok(loaded.updatedAt > originalDate);
    });
  });

  describe('load()', () => {
    it('returns null for non-existent instance', async () => {
      const result = await storage.load('non-existent');
      assert.strictEqual(result, null);
    });

    it('returns a copy, not a reference', async () => {
      const state = createTestState();
      await storage.save(state);

      const loaded1 = await storage.load(state.instanceId);
      const loaded2 = await storage.load(state.instanceId);

      assert.ok(loaded1);
      assert.ok(loaded2);
      assert.notStrictEqual(loaded1, loaded2);
    });
  });

  describe('delete()', () => {
    it('deletes an existing state', async () => {
      const state = createTestState();
      await storage.save(state);
      await storage.delete(state.instanceId);

      const loaded = await storage.load(state.instanceId);
      assert.strictEqual(loaded, null);
    });

    it('handles deleting non-existent state gracefully', async () => {
      // Should not throw
      await storage.delete('non-existent');
    });
  });

  describe('complete()', () => {
    it('marks a process as completed with result', async () => {
      const state = createTestState({ status: 'running' });
      await storage.save(state);

      const result = { success: true, value: 42 };
      await storage.complete(state.instanceId, result);

      const loaded = await storage.load(state.instanceId);
      assert.ok(loaded);
      assert.strictEqual(loaded.status, 'completed');
      assert.deepStrictEqual(loaded.result, result);
      assert.ok(loaded.completedAt);
    });

    it('ignores non-existent instance', async () => {
      // Should not throw
      await storage.complete('non-existent', { result: 'ignored' });
    });
  });

  describe('fail()', () => {
    it('marks a process as failed with error', async () => {
      const state = createTestState({ status: 'running' });
      await storage.save(state);

      await storage.fail(state.instanceId, 'Something went wrong');

      const loaded = await storage.load(state.instanceId);
      assert.ok(loaded);
      assert.strictEqual(loaded.status, 'failed');
      assert.strictEqual(loaded.error, 'Something went wrong');
      assert.ok(loaded.completedAt);
    });
  });

  describe('findByProcessId()', () => {
    it('returns all instances of a process', async () => {
      await storage.save(createTestState({ instanceId: 'inst-1', processId: 'proc-a' }));
      await storage.save(createTestState({ instanceId: 'inst-2', processId: 'proc-a' }));
      await storage.save(createTestState({ instanceId: 'inst-3', processId: 'proc-b' }));

      const results: ProcessState[] = [];
      for await (const state of storage.findByProcessId('proc-a')) {
        results.push(state);
      }

      assert.strictEqual(results.length, 2);
      assert.ok(results.every(s => s.processId === 'proc-a'));
    });

    it('returns empty iterable for unknown process', async () => {
      const results: ProcessState[] = [];
      for await (const state of storage.findByProcessId('unknown')) {
        results.push(state);
      }
      assert.strictEqual(results.length, 0);
    });
  });

  describe('findByStatus()', () => {
    it('returns processes with matching status', async () => {
      await storage.save(createTestState({ instanceId: 'inst-1', status: 'pending' }));
      await storage.save(createTestState({ instanceId: 'inst-2', status: 'running' }));
      await storage.save(createTestState({ instanceId: 'inst-3', status: 'suspended' }));
      await storage.save(createTestState({ instanceId: 'inst-4', status: 'suspended' }));

      const suspended: ProcessState[] = [];
      for await (const state of storage.findByStatus('suspended')) {
        suspended.push(state);
      }

      assert.strictEqual(suspended.length, 2);
      assert.ok(suspended.every(s => s.status === 'suspended'));
    });
  });

  describe('findWaitingForSignal()', () => {
    it('returns processes waiting for a specific signal', async () => {
      await storage.save(createTestState({
        instanceId: 'inst-1',
        status: 'suspended',
        variables: {
          __waitingForSignal: 'orders.complete',
          __signalIdentity: { orderId: '123' },
        },
      }));
      await storage.save(createTestState({
        instanceId: 'inst-2',
        status: 'suspended',
        variables: {
          __waitingForSignal: 'orders.complete',
          __signalIdentity: { orderId: '456' },
        },
      }));
      await storage.save(createTestState({
        instanceId: 'inst-3',
        status: 'suspended',
        variables: {
          __waitingForSignal: 'other.signal',
        },
      }));

      const results: ProcessState[] = [];
      for await (const state of storage.findWaitingForSignal('orders.complete', { orderId: '123' })) {
        results.push(state);
      }

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].instanceId, 'inst-1');
    });

    it('ignores non-suspended processes', async () => {
      await storage.save(createTestState({
        instanceId: 'inst-1',
        status: 'running', // Not suspended
        variables: {
          __waitingForSignal: 'orders.complete',
        },
      }));

      const results: ProcessState[] = [];
      for await (const state of storage.findWaitingForSignal('orders.complete', {})) {
        results.push(state);
      }

      assert.strictEqual(results.length, 0);
    });
  });

  describe('findExpiredTimers()', () => {
    it('returns processes with expired timers', async () => {
      const past = new Date(Date.now() - 60000);
      const future = new Date(Date.now() + 60000);

      await storage.save(createTestState({
        instanceId: 'inst-1',
        status: 'suspended',
        timers: [{ id: 't1', expiresAt: past, opcodeIndex: 5 }],
      }));
      await storage.save(createTestState({
        instanceId: 'inst-2',
        status: 'suspended',
        timers: [{ id: 't2', expiresAt: future, opcodeIndex: 5 }],
      }));

      const results: ProcessState[] = [];
      for await (const state of storage.findExpiredTimers(new Date())) {
        results.push(state);
      }

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].instanceId, 'inst-1');
    });
  });

  describe('Testing utilities', () => {
    it('clear() removes all stored processes', async () => {
      await storage.save(createTestState({ instanceId: 'inst-1' }));
      await storage.save(createTestState({ instanceId: 'inst-2' }));

      assert.strictEqual(storage.size, 2);

      storage.clear();

      assert.strictEqual(storage.size, 0);
    });

    it('getStats() returns counts by status', async () => {
      await storage.save(createTestState({ instanceId: 'inst-1', status: 'pending' }));
      await storage.save(createTestState({ instanceId: 'inst-2', status: 'running' }));
      await storage.save(createTestState({ instanceId: 'inst-3', status: 'completed' }));
      await storage.save(createTestState({ instanceId: 'inst-4', status: 'completed' }));

      const stats = storage.getStats();

      assert.strictEqual(stats.pending, 1);
      assert.strictEqual(stats.running, 1);
      assert.strictEqual(stats.suspended, 0);
      assert.strictEqual(stats.completed, 2);
      assert.strictEqual(stats.failed, 0);
    });
  });
});
