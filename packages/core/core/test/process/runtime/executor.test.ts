import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  ProcessExecutor,
  generateInstanceId,
  resolvePath,
  extractIdentity,
} from '../../../src/runtime/process/executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import { createInMemoryLockProvider } from '../../../src/features/lock/memory.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../../src/process/types.js';
import { DONE, SUSPEND } from '../../../src/process/types.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

// Mock resolver function
const createMockResolver = (services: Record<string, unknown> = {}): Resolver =>
  (async (token: unknown) => services[String(token)]) as Resolver;

// Helper to create compiled switch process definitions for testing
const createSwitchProcess = (
  overrides: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> & {
    execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  }
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id: 'test-process',
  path: '/test/:testId',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

describe('Utility functions', () => {
  describe('generateInstanceId()', () => {
    it('replaces path params with values', () => {
      const result = generateInstanceId('/order/:orderId/fulfillment', ['order-123']);
      assert.strictEqual(result, 'order/order-123/fulfillment');
    });

    it('handles multiple params', () => {
      const result = generateInstanceId('/user/:userId/order/:orderId', ['user-1', 'order-2']);
      assert.strictEqual(result, 'user/user-1/order/order-2');
    });

    it('throws for missing params', () => {
      assert.throws(() => {
        generateInstanceId('/order/:orderId/:itemId', ['order-123']);
      }, /Missing parameter/);
    });
  });

  describe('resolvePath()', () => {
    it('replaces path params with values', () => {
      const result = resolvePath('/order/:orderId/fulfillment', ['order-123']);
      assert.strictEqual(result, '/order/order-123/fulfillment');
    });
  });

  describe('extractIdentity()', () => {
    it('extracts param names and values as record', () => {
      const result = extractIdentity('/order/:orderId/:userId', ['order-123', 'user-456']);
      assert.deepStrictEqual(result, { orderId: 'order-123', userId: 'user-456' });
    });

    it('ignores non-param segments', () => {
      const result = extractIdentity('/api/v1/order/:orderId', ['123']);
      assert.deepStrictEqual(result, { orderId: '123' });
    });
  });
});

describe('ProcessExecutor', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;
  let resolve: ReturnType<typeof createMockResolver>;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();
    resolve = createMockResolver();

    executor = new ProcessExecutor({
      resolve,
      storage,
      signalBus,
      timerScheduler,
      // Real lock provider so concurrent operations actually serialize.
      // Without this the executor's acquireLock is a no-op and tests
      // can't observe the per-instance mutual exclusion contract.
      lockProvider: createInMemoryLockProvider(),
    });
  });

  describe('start()', () => {
    it('creates a new process state', async () => {
      const process = createSwitchProcess({
        execute: async () => [DONE, { success: true }],
      });

      const handle = await executor.start(process, ['test-1']);

      assert.ok(handle);
      assert.strictEqual(handle.id, 'test/test-1');
    });

    it('executes process and completes', async () => {
      let executed = false;
      const process = createSwitchProcess({
        execute: async () => {
          executed = true;
          return [DONE, { success: true }];
        },
      });

      await executor.start(process, ['test-1']);

      assert.ok(executed);
    });

    it('stores result on completion', async () => {
      const process = createSwitchProcess({
        execute: async () => [DONE, { success: true, orderId: '123' }],
      });

      const handle = await executor.start(process, ['test-1']);
      const result = await handle.wait();

      assert.deepStrictEqual(result, { success: true, orderId: '123' });
    });

    it('returns same handle for existing process (idempotent)', async () => {
      const process = createSwitchProcess({
        execute: async () => [DONE, { done: true }],
      });

      const handle1 = await executor.start(process, ['test-1']);
      const handle2 = await executor.start(process, ['test-1']);

      assert.strictEqual(handle1.id, handle2.id);
    });

    it('suspends process on SUSPEND result', async () => {
      const process = createSwitchProcess({
        execute: async () => [SUSPEND, { signal: 'test.signal' }],
      });

      await executor.start(process, ['test-1']);

      const state = await storage.load('test/test-1');
      assert.ok(state);
      assert.strictEqual(state.status, 'suspended');

      // Signal bus should have a subscription
      assert.strictEqual(signalBus.subscriptionCount, 1);
    });

    it('suspends on race with multiple branches', async () => {
      const process = createSwitchProcess({
        execute: async (ctx) => {
          ctx.state.vars.__raceBranches = [
            { id: 'payment', signal: 'payment.received', resumeStep: 1 },
            { id: 'timeout', timer: { minutes: 15 }, resumeStep: 2 },
          ];
          return [SUSPEND, {
            race: [
              { id: 'payment', signal: 'payment.received', resumeStep: 1 },
              { id: 'timeout', timer: { minutes: 15 }, resumeStep: 2 },
            ],
          }];
        },
      });

      await executor.start(process, ['test-1']);

      const state = await storage.load('test/test-1');
      assert.ok(state);
      assert.strictEqual(state.status, 'suspended');
    });
  });

  describe('get()', () => {
    it('returns state for existing process', async () => {
      const process = createSwitchProcess({
        execute: async () => [DONE, null],
      });

      await executor.start(process, ['test-1']);

      const state = await executor.get('test/test-1');
      assert.ok(state);
      assert.strictEqual(state.instanceId, 'test/test-1');
    });

    it('returns null for non-existent process', async () => {
      const state = await executor.get('non-existent');
      assert.strictEqual(state, null);
    });
  });

  describe('emit()', () => {
    it('emits signal to waiting process', async () => {
      // Process that suspends first, then completes on resume
      const process = createSwitchProcess({
        stepMap: { entry: 0, resume: 1 },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { signal: 'orders.complete' }];
          }
          return [DONE, { received: true }];
        },
      });

      await executor.start(process, ['order-123']);

      const matchCount = await executor.emit('orders.complete', { testId: 'order-123' }, { paid: true });

      assert.strictEqual(matchCount, 1);
    });
  });

  describe('queryByStatus()', () => {
    it('returns processes with matching status', async () => {
      const suspendProcess = createSwitchProcess({
        id: 'suspend-process',
        execute: async () => [SUSPEND, { signal: 'test' }],
      });

      const completeProcess = createSwitchProcess({
        id: 'complete-process',
        execute: async () => [DONE, null],
      });

      await executor.start(suspendProcess, ['suspended-1']);
      await executor.start(completeProcess, ['completed-1']);

      const suspended = [];
      for await (const state of executor.queryByStatus('suspended')) {
        suspended.push(state);
      }

      assert.strictEqual(suspended.length, 1);
      assert.strictEqual(suspended[0].instanceId, 'test/suspended-1');
    });
  });

  describe('queryByProcessId()', () => {
    it('returns all instances of a process definition', async () => {
      const process = createSwitchProcess({
        id: 'my-process',
        execute: async () => [DONE, null],
      });

      await executor.start(process, ['instance-1']);
      await executor.start(process, ['instance-2']);

      const results = [];
      for await (const state of executor.queryByProcessId('my-process')) {
        results.push(state);
      }

      assert.strictEqual(results.length, 2);
    });
  });

  describe('Error handling', () => {
    it('marks process as failed on execute error', async () => {
      const process = createSwitchProcess({
        execute: async () => {
          throw new Error('Execution failed!');
        },
      });

      const handle = await executor.start(process, ['test-1']);

      const state = await storage.load('test/test-1');
      assert.ok(state);
      assert.strictEqual(state.status, 'failed');
      assert.strictEqual(state.error, 'Execution failed!');

      // The wait() promise should reject
      await assert.rejects(handle.wait(), /Execution failed!/);
    });
  });

  describe('Service injection', () => {
    it('resolves and passes services to execute function', async () => {
      const mockOrderService = {
        getOrder: (id: string) => ({ id, name: 'Test Order' }),
      };

      // Create a resolver that returns the mock service
      const mockResolve = createMockResolver({
        OrderService: mockOrderService,
      });

      const injectionExecutor = new ProcessExecutor({
        resolve: mockResolve,
        storage,
        signalBus,
        timerScheduler,
      });

      let receivedServices: unknown = null;

      const process = createSwitchProcess({
        inject: { orders: 'OrderService' as unknown as ServiceToken },
        execute: async (ctx) => {
          receivedServices = ctx.services;
          return [DONE, null];
        },
      });

      await injectionExecutor.start(process, ['test-1']);

      assert.ok(receivedServices);
      assert.ok((receivedServices as Record<string, unknown>).orders);
    });
  });

  describe('cancel()', () => {
    it('cancels a suspended process', async () => {
      const process = createSwitchProcess({
        execute: async () => [SUSPEND, { signal: 'test.signal' }],
      });

      const handle = await executor.start(process, ['test-1']);
      // Attach catch to prevent unhandled rejection
      handle.wait().catch(() => {});

      const cancelled = await handle.cancel();
      assert.strictEqual(cancelled, true);

      const state = await storage.load('test/test-1');
      assert.ok(state);
      assert.strictEqual(state.status, 'cancelled');
    });

    it('returns false for already completed process', async () => {
      const process = createSwitchProcess({
        execute: async () => [DONE, { done: true }],
      });

      const handle = await executor.start(process, ['test-1']);

      const cancelled = await handle.cancel();
      assert.strictEqual(cancelled, false);
    });

    it('rejects the wait() promise on cancel', async () => {
      const process = createSwitchProcess({
        execute: async () => [SUSPEND, { signal: 'test.signal' }],
      });

      const handle = await executor.start(process, ['test-1']);
      await handle.cancel();

      await assert.rejects(handle.wait(), /Process cancelled/);
    });

    it('cleans up signal subscriptions on cancel', async () => {
      const process = createSwitchProcess({
        execute: async () => [SUSPEND, { signal: 'test.signal' }],
      });

      const handle = await executor.start(process, ['test-1']);
      // Attach catch to prevent unhandled rejection
      handle.wait().catch(() => {});
      assert.strictEqual(signalBus.subscriptionCount, 1);

      await executor.cancel('test/test-1');

      assert.strictEqual(signalBus.subscriptionCount, 0);
    });

    it('returns false for non-existent process', async () => {
      const result = await executor.cancel('non-existent');
      assert.strictEqual(result, false);
    });

    // Concurrency hardening: cancel() must serialize via the per-instance
    // lock so a second concurrent call sees the cancelled state and
    // returns false. Anything else means the cleanup paths could run
    // twice (double-deleting subscriptions, double-rejecting completions).

    it('concurrent double-cancel: exactly one returns true', async () => {
      const process = createSwitchProcess({
        execute: async () => [SUSPEND, { signal: 'test.signal' }],
      });

      const handle = await executor.start(process, ['conc-1']);
      handle.wait().catch(() => {});

      // Truly concurrent: Promise.all kicks off both cancel() calls
      // before either awaits.
      const [a, b] = await Promise.all([
        executor.cancel('test/conc-1'),
        executor.cancel('test/conc-1'),
      ]);
      // The lock-serialized cancel must yield exactly [true, false] in
      // some order — never [true, true] (double-cancel).
      assert.deepStrictEqual([a, b].sort(), [false, true]);
    });

    it('cancel after signal-emit but before resumption: process ends as cancelled, not resumed', async () => {
      // This is the close cousin of the "cancel during signal delivery"
      // race the audit flagged. We can't guarantee perfect interleaving
      // in a unit test, but we CAN pin the contract: even when emit and
      // cancel land back-to-back on a suspended process, the final
      // state is cancelled — not completed via the (now-stale) signal.
      const process = createSwitchProcess({
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { signal: 'race.go' }] as const;
          }
          // If signal resumed us despite the cancel, this branch would
          // run and we'd see status=completed.
          return [DONE, { resumed: true }];
        },
      });

      const handle = await executor.start(process, ['race-1']);
      handle.wait().catch(() => {});

      // Fire emit + cancel back-to-back. The signal-bus delivers to
      // matchCallbacks which the executor uses to schedule resumption.
      // Cancel must beat (or co-trigger) the resumption to the lock.
      const emitP = executor.emit('race.go', { id: 'race-1' });
      const cancelP = executor.cancel('test/race-1');
      await Promise.all([emitP, cancelP]);

      // Give any in-flight resumption microtask one tick to settle.
      await new Promise((r) => setTimeout(r, 20));

      const state = await storage.load('test/race-1');
      assert.ok(state, 'state should exist');
      // The cancel must win: status is 'cancelled', not 'completed'.
      // If this fails as 'completed', the emit/cancel interleave bug
      // is real and needs a tighter lock around resumption.
      assert.strictEqual(
        state!.status,
        'cancelled',
        `expected cancelled, got ${state!.status}; cancel/emit race may be losing to signal delivery`,
      );
    });
  });

  describe('Signal resumption', () => {
    it('resumes suspended process when signal fires', async () => {
      let resumeCount = 0;
      const process = createSwitchProcess({
        stepMap: { entry: 0, resume_signal: 1 },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            // First execution - suspend
            ctx.state.step = 1;
            return [SUSPEND, { signal: 'test.signal' }];
          } else {
            // Resume - complete
            resumeCount++;
            return [DONE, { resumed: true }];
          }
        },
      });

      const handle = await executor.start(process, ['test-1']);

      // Process should be suspended
      const state = await executor.get('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Emit the signal
      await executor.emit('test.signal', { testId: 'test-1' }, { data: 'payload' });

      // Process should complete
      const result = await handle.wait();
      assert.deepStrictEqual(result, { resumed: true });
      assert.strictEqual(resumeCount, 1);
    });
  });

  describe('Generator yields (ctx.emit)', () => {
    it('yields values and collects them via continuation', async () => {
      const process = createSwitchProcess({
        execute: async (ctx) => {
          ctx.emit({ event: 'step1' });
          ctx.emit({ event: 'step2' });
          ctx.emit({ event: 'step3' });
          return [DONE, { total: 3 }];
        },
      });

      await executor.start(process, ['gen-1']);

      // Verify yields are persisted in storage
      const stored = await storage.load('test/gen-1');
      assert.ok(stored, 'State should be in storage');
      const storedYields = (stored.variables as Record<string, unknown>).__yields as unknown[];
      assert.ok(storedYields, '__yields should be in stored state');
      assert.strictEqual(storedYields.length, 3, 'Should have 3 stored yields');

      const continuation = await executor.createContinuation<{ event: string }, { total: number }>(
        'test/gen-1'
      );

      // Use explicit iterator API
      const iter = continuation[Symbol.asyncIterator]();
      const yielded: { event: string }[] = [];

      let next = await iter.next();
      while (!next.done) {
        yielded.push(next.value);
        next = await iter.next();
      }

      assert.strictEqual(yielded.length, 3);
      assert.deepStrictEqual(yielded, [
        { event: 'step1' },
        { event: 'step2' },
        { event: 'step3' },
      ]);

      const result = await continuation.result;
      assert.deepStrictEqual(result, { total: 3 });
    });

    it('interleaves yields with signal suspension', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, after_signal: 1 },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.emit({ event: 'before_signal' });
            ctx.state.step = 1;
            return [SUSPEND, { signal: 'test.continue' }];
          }
          ctx.emit({ event: 'after_signal' });
          return [DONE, { done: true }];
        },
      });

      await executor.start(process, ['gen-2']);

      const continuation = await executor.createContinuation<{ event: string }, { done: boolean }>(
        'test/gen-2'
      );

      // Collect first yield
      const iter = continuation[Symbol.asyncIterator]();
      const first = await iter.next();
      assert.strictEqual(first.done, false);
      assert.deepStrictEqual(first.value, { event: 'before_signal' });

      // Resume by sending signal
      await executor.emit('test.continue', { testId: 'gen-2' }, {});

      // Should get second yield then done
      const second = await iter.next();
      assert.strictEqual(second.done, false);
      assert.deepStrictEqual(second.value, { event: 'after_signal' });

      const third = await iter.next();
      assert.strictEqual(third.done, true);

      const result = await continuation.result;
      assert.deepStrictEqual(result, { done: true });
    });

    it('completes immediately when no yields', async () => {
      const process = createSwitchProcess({
        execute: async () => [DONE, { empty: true }],
      });

      await executor.start(process, ['gen-3']);

      const continuation = await executor.createContinuation<never, { empty: boolean }>(
        'test/gen-3'
      );

      const yielded: unknown[] = [];
      for await (const value of continuation) {
        yielded.push(value);
      }

      assert.strictEqual(yielded.length, 0);

      const result = await continuation.result;
      assert.deepStrictEqual(result, { empty: true });
    });
  });

  describe('Scope fan-out', () => {
    it('fans out scope entities and collects results via signals', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, scope_resume: 1 },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            // Set up scope entities
            const scopeId = 0;
            ctx.state.vars[`__scope_${scopeId}_entities`] = [
              { id: 'a' },
              { id: 'b' },
              { id: 'c' },
            ];
            ctx.state.step = 1;
            return [SUSPEND, {
              scope: {
                scopeId,
                type: 'signal' as const,
                signal: 'item.done',
                resumeStep: 1,
              },
            }];
          }
          // After all scope entities complete
          const results = ctx.state.vars.__scope_0_results;
          return [DONE, { results }];
        },
      });

      await executor.start(process, ['scope-1']);

      // Verify suspended
      const state = await executor.get('test/scope-1');
      assert.strictEqual(state?.status, 'suspended');

      // Complete each entity
      await executor.notifyScopeEntityComplete('test/scope-1', 0, 'a', { processed: 'a' });
      await executor.notifyScopeEntityComplete('test/scope-1', 0, 'b', { processed: 'b' });
      await executor.notifyScopeEntityComplete('test/scope-1', 0, 'c', { processed: 'c' });

      // Should have resumed after all entities complete
      const finalState = await executor.get('test/scope-1');
      assert.strictEqual(finalState?.status, 'completed');
    });

    it('rejects duplicate entity IDs at runtime', async () => {
      const process = createSwitchProcess({
        execute: async (ctx) => {
          const scopeId = 0;
          ctx.state.vars[`__scope_${scopeId}_entities`] = [
            { id: 'dup' },
            { id: 'dup' },
          ];
          return [SUSPEND, {
            scope: {
              scopeId,
              type: 'signal' as const,
              signal: 'item.done',
              resumeStep: 1,
            },
          }];
        },
      });

      const handle = await executor.start(process, ['scope-dup']);
      // Catch the rejection from wait() to prevent unhandled rejection
      await handle.wait().catch(() => {});

      const state = await executor.get('test/scope-dup');
      assert.strictEqual(state?.status, 'failed');
      assert.ok(state?.error?.includes('Duplicate entity ID'));
    });

    it('rejects scope exceeding item limit', async () => {
      const process = createSwitchProcess({
        execute: async (ctx) => {
          const scopeId = 0;
          // Create 1001 entities
          ctx.state.vars[`__scope_${scopeId}_entities`] = Array.from(
            { length: 1001 },
            (_, i) => ({ id: String(i) })
          );
          return [SUSPEND, {
            scope: {
              scopeId,
              type: 'signal' as const,
              signal: 'item.done',
              resumeStep: 1,
            },
          }];
        },
      });

      const handle = await executor.start(process, ['scope-limit']);
      await handle.wait().catch(() => {});

      const state = await executor.get('test/scope-limit');
      assert.strictEqual(state?.status, 'failed');
      assert.ok(state?.error?.includes('exceeded maximum item limit'));
    });

    it('skips scope with empty entities', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, scope_resume: 1 },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            const scopeId = 0;
            ctx.state.vars[`__scope_${scopeId}_entities`] = [];
            ctx.state.step = 1;
            return [SUSPEND, {
              scope: {
                scopeId,
                type: 'signal' as const,
                signal: 'item.done',
                resumeStep: 1,
              },
            }];
          }
          return [DONE, { skipped: true }];
        },
      });

      const handle = await executor.start(process, ['scope-empty']);
      const result = await handle.wait();
      assert.deepStrictEqual(result, { skipped: true });
    });
  });

  describe('Parallel (signal.all)', () => {
    it('suspends on parallel config and resumes when all signals fire', async () => {
      // Simulates compiled signal.all([paymentSignal, shippingSignal])
      // Step 0: Initialize parallel state and suspend
      // Step 1: Collect results and complete
      const process = createSwitchProcess({
        id: 'parallel-process',
        path: '/order/:orderId',
        stepMap: { entry: 0, parallel_resume: 1 },
        signals: {
          'order.payment': { identity: ['orderId'], payloadType: 'object' },
          'order.shipping': { identity: ['orderId'], payloadType: 'object' },
        },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            // Initialize parallel state (what PARALLEL_START generates)
            ctx.state.vars.__parallel_0 = {
              parallelId: 0,
              pending: 2,
              results: [],
              errors: [],
              isSettled: false,
              branches: [
                { id: 0, type: 'signal', expr: { signalName: 'order.payment' } },
                { id: 1, type: 'signal', expr: { signalName: 'order.shipping' } },
              ],
            };
            // Set resume step (what PARALLEL_WAIT generates)
            ctx.state.step = 1;
            return [SUSPEND, {
              parallel: ctx.state.vars.__parallel_0 as any,
            }];
          }
          // Step 1: PARALLEL_COLLECT - read results from parallel state
          const parallelState = ctx.state.vars.__parallel_0 as any;
          ctx.state.vars.results = parallelState.results;
          return [DONE, {
            payment: (ctx.state.vars.results as unknown[])[0],
            shipping: (ctx.state.vars.results as unknown[])[1],
          }];
        },
      });

      const handle = await executor.start(process, ['order-1']);

      // Should be suspended
      const state = await storage.load('order/order-1');
      assert.ok(state);
      assert.strictEqual(state.status, 'suspended');

      // Fire first signal (payment)
      await executor.emit('order.payment', { orderId: 'order-1' }, { txId: 'tx-123' });

      // Should still be suspended (1 of 2 done)
      const state2 = await storage.load('order/order-1');
      assert.ok(state2);
      assert.strictEqual(state2.status, 'suspended');

      // Fire second signal (shipping)
      await executor.emit('order.shipping', { orderId: 'order-1' }, { trackingId: 'ship-456' });

      // Now should be completed
      const result = await handle.wait();
      assert.deepStrictEqual(result, {
        payment: { txId: 'tx-123' },
        shipping: { trackingId: 'ship-456' },
      });
    });

    it('persists locals assigned before signal.all across suspension', async () => {
      // Tests that state.vars values set before the parallel survive suspension
      const process = createSwitchProcess({
        id: 'parallel-locals',
        path: '/order/:orderId',
        stepMap: { entry: 0, parallel_resume: 1 },
        signals: {
          'order.payment': { identity: ['orderId'], payloadType: 'object' },
          'order.shipping': { identity: ['orderId'], payloadType: 'object' },
        },
        execute: async (ctx) => {
          if (ctx.state.step === 0) {
            // Simulate a local variable assignment before signal.all
            // In compiled code: state.vars.tag = 'important'
            ctx.state.vars.tag = 'important';

            ctx.state.vars.__parallel_0 = {
              parallelId: 0,
              pending: 2,
              results: [],
              errors: [],
              isSettled: false,
              branches: [
                { id: 0, type: 'signal', expr: { signalName: 'order.payment' } },
                { id: 1, type: 'signal', expr: { signalName: 'order.shipping' } },
              ],
            };
            ctx.state.step = 1;
            return [SUSPEND, {
              parallel: ctx.state.vars.__parallel_0 as any,
            }];
          }
          // After resume, the 'tag' local should still be available
          const tag = ctx.state.vars.tag;
          const parallelState = ctx.state.vars.__parallel_0 as any;
          return [DONE, {
            tag,
            results: parallelState.results,
          }];
        },
      });

      const handle = await executor.start(process, ['order-2']);

      await executor.emit('order.payment', { orderId: 'order-2' }, { paid: true });
      await executor.emit('order.shipping', { orderId: 'order-2' }, { shipped: true });

      const result = await handle.wait();
      assert.strictEqual((result as any).tag, 'important');
      assert.deepStrictEqual((result as any).results, [{ paid: true }, { shipped: true }]);
    });
  });
});
