/**
 * Runtime execution tests for yield/generator patterns in the process compiler.
 *
 * These tests verify the full compile -> execute -> yield -> consume lifecycle
 * by hand-writing execute functions that use ctx.emit() to yield values,
 * then consuming them via ProcessContinuation (createContinuation).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProcessExecutor,
} from '../../core/src/runtime/process/executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../core/src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../core/src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../core/src/runtime/process/timer-scheduler.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../core/src/process/types.js';
import { DONE, SUSPEND } from '../../core/src/process/types.js';
import type { ServiceToken, Resolver } from '../../core/src/core/index.js';

const createMockResolver = (): Resolver =>
  (async () => undefined) as Resolver;

const createSwitchProcess = (
  overrides: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> & {
    execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  }
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id: 'test-yield',
  path: '/test/:testId',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

describe('Yield Runtime', () => {
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

  describe('simple yield + done', () => {
    it('yields a value then completes, consumer reads both', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, done: 1 },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                ctx.emit({ type: 'progress', value: 42 });
                state.step = 1;
                continue;
              }
              case 1: {
                return [DONE, { status: 'completed', total: 42 }];
              }
              default:
                throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      const handle = await executor.start(process, ['test-1']);

      // Process should have completed synchronously
      const finalState = await storage.load(handle.id);
      assert.strictEqual(finalState?.status, 'completed');

      // Create continuation to read yielded values
      const continuation = await executor.createContinuation<{ type: string; value: number }, { status: string; total: number }>(
        handle.id
      );

      // Read the yielded value
      const iterator = continuation[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.strictEqual(first.done, false);
      assert.deepStrictEqual(first.value, { type: 'progress', value: 42 });

      // Next read should signal done (process already completed)
      const second = await iterator.next();
      assert.strictEqual(second.done, true);

      // Final result accessible via continuation
      const result = await continuation.result;
      assert.deepStrictEqual(result, { status: 'completed', total: 42 });
    });
  });

  describe('multiple yields before signal', () => {
    it('yields values, suspends on signal, resumes and yields more', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, suspended: 1, afterSignal: 2, done: 3 },
        signals: { 'test.continue': { identity: ['testId'], payloadType: 'unknown' } },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                ctx.emit('value1');
                ctx.emit('value2');
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.continue', resumeStep: 2 }] }];
              }
              case 2: {
                ctx.emit('value3');
                state.step = 3;
                continue;
              }
              case 3: {
                return [DONE, { collected: 3 }];
              }
              default:
                throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      // Start the process - it yields value1, value2, then suspends
      const handle = await executor.start(process, ['test-1']);

      let state = await storage.load(handle.id);
      assert.strictEqual(state?.status, 'suspended');

      // Create continuation and read the two pre-signal yields
      const continuation = await executor.createContinuation<string, { collected: number }>(
        handle.id
      );
      const iterator = continuation[Symbol.asyncIterator]();

      const first = await iterator.next();
      assert.strictEqual(first.done, false);
      assert.strictEqual(first.value, 'value1');

      const second = await iterator.next();
      assert.strictEqual(second.done, false);
      assert.strictEqual(second.value, 'value2');

      // Fire signal - process resumes, yields value3, completes
      await executor.emit('test.continue', { testId: 'test-1' }, {});

      state = await storage.load(handle.id);
      assert.strictEqual(state?.status, 'completed');

      const third = await iterator.next();
      assert.strictEqual(third.done, false);
      assert.strictEqual(third.value, 'value3');

      // Next read should be done
      const fourth = await iterator.next();
      assert.strictEqual(fourth.done, true);

      const result = await continuation.result;
      assert.deepStrictEqual(result, { collected: 3 });
    });
  });

  describe('yield queue persistence', () => {
    it('persists yields in state.vars.__yields across suspend/resume', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, afterFirstSignal: 2, afterSecondSignal: 4, done: 5 },
        signals: { 'test.continue': { identity: ['testId'], payloadType: 'unknown' } },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                ctx.emit({ batch: 1, item: 'a' });
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.continue', resumeStep: 2 }] }];
              }
              case 2: {
                ctx.emit({ batch: 2, item: 'b' });
                ctx.emit({ batch: 2, item: 'c' });
                state.step = 3;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.continue', resumeStep: 4 }] }];
              }
              case 4: {
                ctx.emit({ batch: 3, item: 'd' });
                state.step = 5;
                continue;
              }
              case 5: {
                return [DONE, { total: 4 }];
              }
              default:
                throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      // Start - yields one item, then suspends
      const handle = await executor.start(process, ['test-1']);

      let state = await storage.load(handle.id);
      assert.strictEqual(state?.status, 'suspended');

      // Verify __yields persisted after first suspend
      const vars1 = state!.variables as Record<string, unknown>;
      const yields1 = vars1.__yields as unknown[];
      assert.strictEqual(yields1.length, 1);
      assert.deepStrictEqual(yields1[0], { batch: 1, item: 'a' });

      // Fire signal - yields two more items, suspends again
      await executor.emit('test.continue', { testId: 'test-1' }, {});

      state = await storage.load(handle.id);
      assert.strictEqual(state?.status, 'suspended');

      // Verify __yields grew
      const vars2 = state!.variables as Record<string, unknown>;
      const yields2 = vars2.__yields as unknown[];
      assert.strictEqual(yields2.length, 3);
      assert.deepStrictEqual(yields2[1], { batch: 2, item: 'b' });
      assert.deepStrictEqual(yields2[2], { batch: 2, item: 'c' });

      // Fire signal again - yields one more, completes
      await executor.emit('test.continue', { testId: 'test-1' }, {});

      state = await storage.load(handle.id);
      assert.strictEqual(state?.status, 'completed');

      // Verify final __yields array has all 4 items
      const vars3 = state!.variables as Record<string, unknown>;
      const yields3 = vars3.__yields as unknown[];
      assert.strictEqual(yields3.length, 4);
      assert.deepStrictEqual(yields3[3], { batch: 3, item: 'd' });
    });

    it('consumer cursor persists via cancel()', async () => {
      const process = createSwitchProcess({
        stepMap: { entry: 0, done: 1 },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          ctx.emit('a');
          ctx.emit('b');
          ctx.emit('c');
          ctx.state.step = 1;
          return [DONE, { ok: true }];
        },
      });

      const handle = await executor.start(process, ['test-1']);

      // Create a named continuation, read one value, then cancel
      const cont1 = await executor.createContinuation<string, { ok: boolean }>(
        handle.id,
        'my-consumer'
      );
      const iter1 = cont1[Symbol.asyncIterator]();

      const first = await iter1.next();
      assert.strictEqual(first.value, 'a');

      // Cancel persists the cursor at position 1
      await cont1.cancel();

      // Reconnect with same consumer ID - should resume from cursor 1
      const cont2 = await executor.createContinuation<string, { ok: boolean }>(
        handle.id,
        'my-consumer'
      );
      const iter2 = cont2[Symbol.asyncIterator]();

      const resumed = await iter2.next();
      assert.strictEqual(resumed.value, 'b');

      const next = await iter2.next();
      assert.strictEqual(next.value, 'c');

      const done = await iter2.next();
      assert.strictEqual(done.done, true);
    });
  });
});
