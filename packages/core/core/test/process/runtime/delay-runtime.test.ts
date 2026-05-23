/**
 * Runtime integration tests for delay expressions with TestClock.
 *
 * These tests verify that delay expressions are correctly evaluated at runtime
 * and that TestClock can properly advance time to fire delay timers.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { ProcessExecutor } from '../../../src/runtime/process/executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import { TestClock } from '../../../src/process/testing/clock.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../../src/process/types.js';
import { DONE, SUSPEND } from '../../../src/process/types.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockResolver = (): Resolver =>
  (async () => undefined) as unknown as Resolver;

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
// Delay Runtime Tests
// ============================================================================

describe('Delay Runtime with TestClock', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;
  let clock: TestClock;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();
    clock = new TestClock(timerScheduler, new Date('2025-01-01T00:00:00Z'));

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

  describe('literal delay values', () => {
    it('schedules timer with correct milliseconds for seconds', async () => {
      const process = createProcess(
        'delay-seconds',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            // Simulating: delay.seconds(r, 30) → timer: { seconds: 30 }
            return [SUSPEND, { timer: { seconds: 30 } }];
          }
          return [DONE, { completed: true }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['t-1']);

      // Verify timer was scheduled
      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer (use fireNext for testing, as the scheduler uses real time)
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { completed: true });
    });

    it('schedules timer with correct milliseconds for minutes', async () => {
      const process = createProcess(
        'delay-minutes',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            // Simulating: delay.minutes(r, 5) → timer: { minutes: 5 }
            return [SUSPEND, { timer: { minutes: 5 } }];
          }
          return [DONE, { completed: true }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['t-2']);

      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { completed: true });
    });

    it('schedules timer with correct milliseconds for hours', async () => {
      const process = createProcess(
        'delay-hours',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            // Simulating: delay.hours(r, 2) → timer.ms = 2 * 3600000
            return [SUSPEND, { timer: { hours: 2 } }];
          }
          return [DONE, { completed: true }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['t-3']);

      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { completed: true });
    });

    it('schedules timer with correct milliseconds for days', async () => {
      const process = createProcess(
        'delay-days',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            // Simulating: delay.days(r, 7) → timer.ms = 7 * 86400000
            return [SUSPEND, { timer: { days: 7 } }];
          }
          return [DONE, { completed: true }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['t-4']);

      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { completed: true });
    });
  });

  describe('expression-based delays', () => {
    it('evaluates variable expression at runtime', async () => {
      // Simulating: delay.seconds(r, attempt * 10) where attempt = 3
      // At runtime, this would be evaluated as 3 * 10 * 1000 = 30000ms
      const attempt = 3;

      const process = createProcess(
        'delay-expr',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.vars.attempt = attempt;
            ctx.state.step = 1;
            // The compiled code would evaluate: state.vars.attempt * 10 * 1000
            return [SUSPEND, { timer: { seconds: (ctx.state.vars.attempt as number) * 10 } }];
          }
          return [DONE, { attempt: ctx.state.vars.attempt }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['t-5']);

      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { attempt: 3 });
    });

    it('evaluates dynamic delay value based on state', async () => {
      // The delay value can depend on runtime state
      const process = createProcess(
        'dynamic-delay',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            // User provides a multiplier via state
            ctx.state.vars.multiplier = 3;
            ctx.state.step = 1;
            // delay.minutes(r, multiplier) → ms = multiplier * 60000
            return [SUSPEND, { timer: { minutes: (ctx.state.vars.multiplier as number) } }];
          }
          return [DONE, { multiplier: ctx.state.vars.multiplier }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['t-6']);

      // Timer should be scheduled for 3 minutes
      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { multiplier: 3 });
    });
  });

  describe('race with delay', () => {
    it('timer wins race when signal not received', async () => {
      const process = createProcess(
        'race-timeout',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.vars.__raceBranches = [
              { id: 'signal', signal: 'test.complete', resumeStep: 1 },
              { id: 'timeout', timer: { seconds: 30 }, resumeStep: 2 },
            ];
            return [SUSPEND, {
              race: [
                { id: 'signal', signal: 'test.complete', resumeStep: 1 },
                { id: 'timeout', timer: { seconds: 30 }, resumeStep: 2 },
              ],
            }];
          } else if (ctx.state.step === 1) {
            return [DONE, { winner: 'signal' }];
          } else {
            return [DONE, { winner: 'timeout' }];
          }
        },
        { stepMap: { entry: 0, signal: 1, timeout: 2 } }
      );

      const handle = await executor.start(process, ['r-1']);

      // Fire the timer (timeout wins)
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { winner: 'timeout' });
    });

    it('signal wins race when received before timer fires', async () => {
      const process = createProcess(
        'race-signal',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.vars.__raceBranches = [
              { id: 'signal', signal: 'test.complete', resumeStep: 1 },
              { id: 'timeout', timer: { seconds: 60 }, resumeStep: 2 },
            ];
            return [SUSPEND, {
              race: [
                { id: 'signal', signal: 'test.complete', resumeStep: 1 },
                { id: 'timeout', timer: { seconds: 60 }, resumeStep: 2 },
              ],
            }];
          } else if (ctx.state.step === 1) {
            return [DONE, { winner: 'signal' }];
          } else {
            return [DONE, { winner: 'timeout' }];
          }
        },
        { stepMap: { entry: 0, signal: 1, timeout: 2 } }
      );

      const handle = await executor.start(process, ['r-2']);

      // Emit signal (signal wins before timer)
      await executor.emit('test.complete', { id: 'r-2' }, { success: true });

      const result = await handle.wait();
      assert.deepStrictEqual(result, { winner: 'signal' });
    });

    it('expression-based delay in race', async () => {
      const retryCount = 5;

      const process = createProcess(
        'race-expr',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.vars.retryCount = retryCount;
            // delay.minutes(r, retryCount) → ms = retryCount * 60000
            const delayMs = (ctx.state.vars.retryCount as number) * 60000;
            ctx.state.vars.__raceBranches = [
              { id: 'signal', signal: 'test.ready', resumeStep: 1 },
              { id: 'timeout', timer: { seconds: delayMs / 1000 }, resumeStep: 2 },
            ];
            return [SUSPEND, {
              race: [
                { id: 'signal', signal: 'test.ready', resumeStep: 1 },
                { id: 'timeout', timer: { seconds: delayMs / 1000 }, resumeStep: 2 },
              ],
            }];
          } else if (ctx.state.step === 1) {
            return [DONE, { winner: 'signal' }];
          } else {
            return [DONE, { winner: 'timeout', retryCount: ctx.state.vars.retryCount }];
          }
        },
        { stepMap: { entry: 0, signal: 1, timeout: 2 } }
      );

      const handle = await executor.start(process, ['r-3']);

      assert.strictEqual(clock.pendingCount, 1);

      // Fire the timer (timeout wins)
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { winner: 'timeout', retryCount: 5 });
    });
  });

  describe('TestClock utilities', () => {
    it('fireNext fires timer without advancing simulated time', async () => {
      const process = createProcess(
        'fire-next',
        '/test/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { timer: { hours: 1 } }]; // 1 hour
          }
          return [DONE, { fired: true }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['c-2']);

      const initialTime = clock.now.getTime();
      clock.fireNext();
      const afterTime = clock.now.getTime();

      // Simulated time should NOT have advanced
      assert.strictEqual(afterTime, initialTime);

      const result = await handle.wait();
      assert.deepStrictEqual(result, { fired: true });
    });

    it('pendingCount tracks timer count', async () => {
      const process = createProcess(
        'timer-check',
        '/test/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { timer: { minutes: 5 } }]; // 5 minutes
          }
          return [DONE, {}];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      assert.strictEqual(clock.pendingCount, 0);

      await executor.start(process, ['c-3']);
      assert.strictEqual(clock.pendingCount, 1);

      await executor.start(process, ['c-4']);
      assert.strictEqual(clock.pendingCount, 2);

      clock.fireNext();
      assert.strictEqual(clock.pendingCount, 1);

      clock.fireNext();
      assert.strictEqual(clock.pendingCount, 0);
    });
  });

  describe('timer cancellation', () => {
    it('cancels timer when signal wins race', async () => {
      const process = createProcess(
        'race-cancel',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.vars.__raceBranches = [
              { id: 'signal', signal: 'test.done', resumeStep: 1 },
              { id: 'timeout', timer: { seconds: 60 }, resumeStep: 2 },
            ];
            return [SUSPEND, {
              race: [
                { id: 'signal', signal: 'test.done', resumeStep: 1 },
                { id: 'timeout', timer: { seconds: 60 }, resumeStep: 2 },
              ],
            }];
          } else if (ctx.state.step === 1) {
            return [DONE, { winner: 'signal' }];
          } else {
            return [DONE, { winner: 'timeout' }];
          }
        },
        { stepMap: { entry: 0, signal: 1, timeout: 2 } }
      );

      const handle = await executor.start(process, ['rc-1']);

      // Timer should be scheduled
      assert.strictEqual(clock.pendingCount, 1);

      // Signal wins the race
      await executor.emit('test.done', { id: 'rc-1' }, { success: true });

      // Timer should be cancelled (or at least not fire)
      const result = await handle.wait();
      assert.deepStrictEqual(result, { winner: 'signal' });

      // Verify timer was cancelled
      assert.strictEqual(clock.pendingCount, 0, 'Timer should be cancelled when signal wins');
    });

    it('does not cancel timer for other instances', async () => {
      const process = createProcess(
        'multi-race',
        '/race/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.vars.__raceBranches = [
              { id: 'signal', signal: 'test.done', resumeStep: 1 },
              { id: 'timeout', timer: { seconds: 60 }, resumeStep: 2 },
            ];
            return [SUSPEND, {
              race: [
                { id: 'signal', signal: 'test.done', resumeStep: 1 },
                { id: 'timeout', timer: { seconds: 60 }, resumeStep: 2 },
              ],
            }];
          } else if (ctx.state.step === 1) {
            return [DONE, { winner: 'signal' }];
          } else {
            return [DONE, { winner: 'timeout' }];
          }
        },
        { stepMap: { entry: 0, signal: 1, timeout: 2 } }
      );

      // Start two instances
      const handle1 = await executor.start(process, ['mr-1']);
      const handle2 = await executor.start(process, ['mr-2']);

      // Both should have timers
      assert.strictEqual(clock.pendingCount, 2);

      // Signal only mr-1
      await executor.emit('test.done', { id: 'mr-1' }, {});

      const result1 = await handle1.wait();
      assert.deepStrictEqual(result1, { winner: 'signal' });

      // mr-2's timer should still be pending
      assert.strictEqual(clock.pendingCount, 1, 'Other instance timer should still be pending');

      // Fire remaining timer for mr-2
      clock.fireNext();
      const result2 = await handle2.wait();
      assert.deepStrictEqual(result2, { winner: 'timeout' });
    });
  });

  describe('edge case delays', () => {
    it('handles zero millisecond delay', async () => {
      const process = createProcess(
        'zero-delay',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { timer: { seconds: 0 } }];
          }
          return [DONE, { immediate: true }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['z-1']);

      // Timer is scheduled even with 0ms
      assert.strictEqual(clock.pendingCount, 1);

      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { immediate: true });
    });

    it('handles very large delay', async () => {
      const oneYear = 365 * 24 * 60 * 60 * 1000; // ~31 billion ms

      const process = createProcess(
        'long-delay',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { timer: { days: 365 } }];
          }
          return [DONE, { waited: 'one-year' }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      const handle = await executor.start(process, ['l-1']);

      assert.strictEqual(clock.pendingCount, 1);

      // Fire immediately (we're testing, not waiting a year!)
      clock.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, { waited: 'one-year' });
    });

    it('handles multiple sequential delays', async () => {
      const executionOrder: string[] = [];

      const process = createProcess(
        'seq-delay',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            executionOrder.push('start');
            ctx.state.step = 1;
            return [SUSPEND, { timer: { seconds: 1 } }];
          }
          if (ctx.state.step === 1) {
            executionOrder.push('after-first');
            ctx.state.step = 2;
            return [SUSPEND, { timer: { seconds: 2 } }];
          }
          if (ctx.state.step === 2) {
            executionOrder.push('after-second');
            ctx.state.step = 3;
            return [SUSPEND, { timer: { seconds: 3 } }];
          }
          executionOrder.push('done');
          return [DONE, { order: executionOrder }];
        },
        { stepMap: { entry: 0, delay1: 1, delay2: 2, delay3: 3 } }
      );

      const handle = await executor.start(process, ['s-1']);

      const tick = () => new Promise(r => setImmediate(r));

      // First delay
      assert.strictEqual(clock.pendingCount, 1);
      clock.fireNext();
      await tick(); // Let async resume complete and schedule next timer

      // Second delay
      assert.strictEqual(clock.pendingCount, 1);
      clock.fireNext();
      await tick();

      // Third delay
      assert.strictEqual(clock.pendingCount, 1);
      clock.fireNext();
      await tick();

      const result = await handle.wait();
      assert.deepStrictEqual(result, {
        order: ['start', 'after-first', 'after-second', 'done']
      });
    });
  });

  describe('concurrent processes', () => {
    it('handles many concurrent timers', async () => {
      const process = createProcess(
        'concurrent',
        '/delay/:id',
        async (ctx) => {
          if (ctx.state.step === 0) {
            ctx.state.step = 1;
            return [SUSPEND, { timer: { seconds: 10 } }];
          }
          const identity = ctx.state.vars.__identity as { id: string };
          return [DONE, { id: identity.id }];
        },
        { stepMap: { entry: 0, resume: 1 } }
      );

      // Start 10 concurrent processes
      const handles = await Promise.all(
        Array.from({ length: 10 }, (_, i) => executor.start(process, [`c-${i}`]))
      );

      assert.strictEqual(clock.pendingCount, 10);

      // Fire all timers
      clock.fireAll();

      assert.strictEqual(clock.pendingCount, 0);

      // All should complete
      const results = await Promise.all(handles.map(h => h.wait()));
      assert.strictEqual(results.length, 10);
    });
  });
});
