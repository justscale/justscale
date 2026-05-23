/**
 * End-to-end tests for the durable process runtime.
 *
 * These tests verify complete workflows including:
 * - Process start and execution
 * - Signal-based suspension and resumption
 * - Timer-based suspension and resumption
 * - Race conditions between signals and timers
 * - Service injection throughout the process lifecycle
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { ProcessExecutor } from '../../../src/runtime/process/executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../../src/process/types.js';
import { DONE, SUSPEND } from '../../../src/process/types.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockResolver = (services: Record<string, unknown> = {}): Resolver =>
  (async (token: unknown) => services[String(token)]) as Resolver;

// Helper to create a switch-based compiled process
const createProcess = (
  id: string,
  path: string,
  execute: (ctx: ExecutionContext) => Promise<ExecutionResult>,
  options: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> = {}
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id,
  path,
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  execute,
  ...options,
});

// ============================================================================
// E2E Tests
// ============================================================================

describe('E2E: Process Lifecycle', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();

    executor = new ProcessExecutor({
      resolve: createMockResolver(),
      storage,
      signalBus,
      timerScheduler,
    });
  });

  afterEach(() => {
    timerScheduler.stop();
    timerScheduler.clear();
    signalBus.clear();
    storage.clear();
  });

  describe('Simple process execution', () => {
    it('executes a process that runs and returns a result', async () => {
      const executionLog: string[] = [];

      const process = createProcess(
        'order-create',
        '/order/:orderId',
        async (ctx) => {
          const identity = ctx.state.vars.__identity as Record<string, string>;
          executionLog.push('create-order');
          ctx.state.vars.order = { id: identity.orderId, status: 'created' };
          executionLog.push('confirm-order');
          ctx.state.vars.confirmed = true;
          executionLog.push('return-result');
          return [DONE, { order: ctx.state.vars.order, confirmed: ctx.state.vars.confirmed }];
        }
      );

      const handle = await executor.start(process, ['order-123']);
      const result = await handle.wait();

      assert.deepStrictEqual(executionLog, ['create-order', 'confirm-order', 'return-result']);
      assert.deepStrictEqual(result, {
        order: { id: 'order-123', status: 'created' },
        confirmed: true,
      });

      // Verify state is persisted
      const state = await storage.load('order/order-123');
      assert.ok(state);
      assert.strictEqual(state.status, 'completed');
    });
  });

  describe('Signal suspension and resumption', () => {
    it('suspends on signal and resumes when signal is emitted', async () => {
      const executionLog: string[] = [];
      let executionCount = 0;

      const process = createProcess(
        'payment-flow',
        '/payment/:paymentId',
        async (ctx) => {
          executionCount++;
          if (ctx.state.step === 0) {
            executionLog.push('before-signal');
            ctx.state.vars.amount = 100;
            ctx.state.step = 1;
            return [SUSPEND, { signal: 'payment.confirmed' }];
          } else {
            executionLog.push('after-signal');
            const payload = ctx.state.vars.__signalPayload as { transactionId: string };
            return [DONE, { amount: ctx.state.vars.amount, transactionId: payload.transactionId }];
          }
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      // Start process - should suspend
      const handle = await executor.start(process, ['pay-123']);

      assert.deepStrictEqual(executionLog, ['before-signal']);
      const state = await storage.load('payment/pay-123');
      assert.strictEqual(state?.status, 'suspended');

      // Emit signal - should resume and complete
      await executor.emit('payment.confirmed', { paymentId: 'pay-123' }, { transactionId: 'tx-456' });

      const result = await handle.wait();

      assert.deepStrictEqual(executionLog, ['before-signal', 'after-signal']);
      assert.strictEqual(executionCount, 2);
      assert.deepStrictEqual(result, { amount: 100, transactionId: 'tx-456' });
    });

    it('handles multiple processes waiting for different signals', async () => {
      const process = createProcess(
        'order-flow',
        '/order/:orderId',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { signal: 'order.shipped' }];
          } else {
            return [DONE, { shipped: true, orderId: (ctx.state.vars.__identity as Record<string, string>).orderId }];
          }
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      // Start three processes
      const handle1 = await executor.start(process, ['order-1']);
      const handle2 = await executor.start(process, ['order-2']);
      const handle3 = await executor.start(process, ['order-3']);

      // Emit signal only for order-2
      await executor.emit('order.shipped', { orderId: 'order-2' }, {});

      const result2 = await handle2.wait();
      assert.deepStrictEqual(result2, { shipped: true, orderId: 'order-2' });

      // Other processes should still be suspended
      const state1 = await storage.load('order/order-1');
      const state3 = await storage.load('order/order-3');
      assert.strictEqual(state1?.status, 'suspended');
      assert.strictEqual(state3?.status, 'suspended');
    });
  });

  describe('Timer suspension and resumption', () => {
    it('suspends on timer and resumes when timer fires', async () => {
      const executionLog: string[] = [];

      const process = createProcess(
        'delay-flow',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            executionLog.push('before-delay');
            ctx.state.step = 1;
            return [SUSPEND, { timer: { seconds: 5 } }];
          } else {
            executionLog.push('after-delay');
            return [DONE, { delayed: true }];
          }
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      // Start process - should suspend
      const handle = await executor.start(process, ['d-1']);

      assert.deepStrictEqual(executionLog, ['before-delay']);
      const state = await storage.load('delay/d-1');
      assert.strictEqual(state?.status, 'suspended');

      // Verify timer was scheduled
      assert.strictEqual(timerScheduler.pendingCount, 1);

      // Fire the timer
      timerScheduler.fireNext();

      // Process should complete
      const result = await handle.wait();
      assert.deepStrictEqual(result, { delayed: true });
      assert.deepStrictEqual(executionLog, ['before-delay', 'after-delay']);
    });
  });

  describe('Race conditions', () => {
    it('completes when first race branch wins (signal)', async () => {
      const executionLog: string[] = [];

      const process = createProcess(
        'race-flow',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            executionLog.push('setup-race');
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
          } else if (ctx.state.step === 1) {
            executionLog.push('payment-won');
            return [DONE, { winner: 'payment', payload: ctx.state.vars.__raceResult }];
          } else {
            executionLog.push('timeout-won');
            return [DONE, { winner: 'timeout' }];
          }
        },
        { stepMap: { entry: 0, payment: 1, timeout: 2 } }
      );

      const handle = await executor.start(process, ['r-1']);

      // Emit payment signal
      await executor.emit('payment.received', { id: 'r-1' }, { amount: 100 });

      const result = await handle.wait();
      assert.deepStrictEqual(executionLog, ['setup-race', 'payment-won']);
      assert.deepStrictEqual(result, { winner: 'payment', payload: { amount: 100 } });
    });

    it('completes when timer wins the race', async () => {
      const executionLog: string[] = [];

      const process = createProcess(
        'race-flow',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            executionLog.push('setup-race');
            ctx.state.vars.__raceBranches = [
              { id: 'payment', signal: 'payment.received', resumeStep: 1 },
              { id: 'timeout', timer: { seconds: 30 }, resumeStep: 2 },
            ];
            return [SUSPEND, {
              race: [
                { id: 'payment', signal: 'payment.received', resumeStep: 1 },
                { id: 'timeout', timer: { seconds: 30 }, resumeStep: 2 },
              ],
            }];
          } else if (ctx.state.step === 1) {
            executionLog.push('payment-won');
            return [DONE, { winner: 'payment' }];
          } else {
            executionLog.push('timeout-won');
            return [DONE, { winner: 'timeout' }];
          }
        },
        { stepMap: { entry: 0, payment: 1, timeout: 2 } }
      );

      const handle = await executor.start(process, ['r-1']);

      // Fire the timer (timeout wins)
      timerScheduler.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(executionLog, ['setup-race', 'timeout-won']);
      assert.deepStrictEqual(result, { winner: 'timeout' });
    });
  });

  describe('Error handling', () => {
    it('marks process as failed and captures error on exception', async () => {
      const process = createProcess(
        'error-flow',
        '/error/:id',
        async () => {
          throw new Error('Simulated failure');
        }
      );

      const handle = await executor.start(process, ['e-1']);

      const state = await storage.load('error/e-1');
      assert.strictEqual(state?.status, 'failed');
      assert.strictEqual(state?.error, 'Simulated failure');

      await assert.rejects(handle.wait(), /Simulated failure/);
    });
  });

  describe('Idempotency', () => {
    it('returns existing handle when starting the same process twice', async () => {
      const process = createProcess(
        'idempotent-flow',
        '/idem/:id',
        async () => [DONE, { created: true }]
      );

      const handle1 = await executor.start(process, ['i-1']);
      const handle2 = await executor.start(process, ['i-1']);

      assert.strictEqual(handle1.id, handle2.id);
    });
  });

  describe('Multiple instances', () => {
    it('manages multiple independent process instances', async () => {
      const process = createProcess(
        'multi-flow',
        '/multi/:id',
        async (ctx) => {
          const identity = ctx.state.vars.__identity as Record<string, string>;
          return [DONE, { id: identity.id, processed: true }];
        }
      );

      const [handle1, handle2, handle3] = await Promise.all([
        executor.start(process, ['m-1']),
        executor.start(process, ['m-2']),
        executor.start(process, ['m-3']),
      ]);

      const [result1, result2, result3] = await Promise.all([
        handle1.wait(),
        handle2.wait(),
        handle3.wait(),
      ]);

      assert.deepStrictEqual(result1, { id: 'm-1', processed: true });
      assert.deepStrictEqual(result2, { id: 'm-2', processed: true });
      assert.deepStrictEqual(result3, { id: 'm-3', processed: true });
    });
  });

  describe('Service injection', () => {
    it('injects services and they are available throughout execution', async () => {
      const mockOrderService = {
        findById: (id: string) => ({ id, status: 'pending' }),
        markPaid: (id: string) => ({ id, status: 'paid' }),
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

      const process = createProcess(
        'service-flow',
        '/service/:orderId',
        async (ctx) => {
          const services = ctx.services as { orders: typeof mockOrderService };
          const identity = ctx.state.vars.__identity as Record<string, string>;
          const order = services.orders.findById(identity.orderId);
          const paid = services.orders.markPaid(identity.orderId);
          return [DONE, { order, paid }];
        },
        { inject: { orders: 'OrderService' as unknown as ServiceToken } }
      );

      const handle = await injectionExecutor.start(process, ['ord-123']);
      const result = await handle.wait();

      assert.deepStrictEqual(result, {
        order: { id: 'ord-123', status: 'pending' },
        paid: { id: 'ord-123', status: 'paid' },
      });
    });
  });
});
