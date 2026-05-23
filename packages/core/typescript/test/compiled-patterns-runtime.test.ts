/**
 * Runtime execution tests for compiled process patterns.
 *
 * These tests verify the full suspend -> resume cycle for common patterns
 * that the process compiler produces. Each test hand-writes an execute
 * function mirroring compiled output and runs it through ProcessExecutor
 * with in-memory infra.
 *
 * Patterns covered:
 * 1. Early return after suspension
 * 2. Array destructuring across suspension
 * 3. Nested object access across suspension
 * 4. Multiple sequential suspensions
 * 5. While loop with conditional break after suspension
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
  id: 'test-patterns',
  path: '/test/:testId',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

describe('Compiled Patterns Runtime', () => {
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

  describe('early return after suspension', () => {
    // Source pattern:
    //   const result = await signal(deps.svc.check);
    //   if (result.skip) return { status: 'skipped' };
    //   await signal(deps.svc.confirm);
    //   return { status: 'confirmed' };

    const makeProcess = () => createSwitchProcess({
      id: 'test-early-return',
      stepMap: { entry: 0, afterCheck: 1, afterConfirm: 2 },
      signals: {
        'svc.check': { identity: ['testId'], payloadType: 'unknown' },
        'svc.confirm': { identity: ['testId'], payloadType: 'unknown' },
      },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
        while (true) {
          switch (state.step) {
            case 0: {
              // Suspend on first signal
              state.step = 1;
              return [SUSPEND, { race: [{ id: 'signal_0', signal: 'svc.check', resumeStep: 1 }] }];
            }
            case 1: {
              // Resume from race - payload stored by executor in state.vars.__raceResult
              const result = vars.__raceResult as { skip: boolean };
              vars.__checkResult = result;
              if (result.skip) {
                return [DONE, { status: 'skipped' }];
              }
              // Not skipping - suspend on confirm
              state.step = 2;
              return [SUSPEND, { race: [{ id: 'signal_1', signal: 'svc.confirm', resumeStep: 2 }] }];
            }
            case 2: {
              return [DONE, { status: 'confirmed' }];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    it('returns early when signal payload has skip=true', async () => {
      const process = makeProcess();
      const handle = await executor.start(process, ['test-1']);

      // Process should be suspended on check signal
      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Emit check with skip=true -> process should complete immediately
      await executor.emit('svc.check', { testId: 'test-1' }, { skip: true });

      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { status: 'skipped' });
    });

    it('continues to second suspension when skip=false', async () => {
      const process = makeProcess();
      const handle = await executor.start(process, ['test-1']);

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Emit check with skip=false -> should suspend again on confirm
      await executor.emit('svc.check', { testId: 'test-1' }, { skip: false });

      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Emit confirm -> process completes
      await executor.emit('svc.confirm', { testId: 'test-1' }, {});

      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { status: 'confirmed' });
    });
  });

  describe('array destructuring across suspension', () => {
    // Source pattern:
    //   const [first, second] = await signal(deps.svc.getData);
    //   await signal(deps.svc.confirm);
    //   return { first, second };

    it('preserves array destructured values across suspend/resume', async () => {
      const process = createSwitchProcess({
        id: 'test-array-destructure',
        stepMap: { entry: 0, afterGetData: 1, afterConfirm: 2 },
        signals: {
          'svc.getData': { identity: ['testId'], payloadType: 'unknown' },
          'svc.confirm': { identity: ['testId'], payloadType: 'unknown' },
        },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'svc.getData', resumeStep: 1 }] }];
              }
              case 1: {
                // Compiled destructuring: payload from race result, extract elements into vars
                const payload = vars.__raceResult as unknown[];
                vars.__first = payload[0];
                vars.__second = payload[1];
                state.step = 2;
                return [SUSPEND, { race: [{ id: 'signal_1', signal: 'svc.confirm', resumeStep: 2 }] }];
              }
              case 2: {
                return [DONE, { first: vars.__first, second: vars.__second }];
              }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Fire getData with array payload
      await executor.emit('svc.getData', { testId: 'test-1' }, ['a', 'b']);

      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Fire confirm
      await executor.emit('svc.confirm', { testId: 'test-1' }, {});

      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { first: 'a', second: 'b' });
    });
  });

  describe('nested object access across suspension', () => {
    // Source pattern:
    //   const data = { nested: { value: 42 } };
    //   await signal(deps.svc.wait);
    //   return { result: data.nested.value };

    it('preserves nested object in state.vars across suspend/resume', async () => {
      const process = createSwitchProcess({
        id: 'test-nested-object',
        stepMap: { entry: 0, afterWait: 1 },
        signals: {
          'svc.wait': { identity: ['testId'], payloadType: 'unknown' },
        },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                // Local object assigned before suspension
                vars.__data = { nested: { value: 42 } };
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'svc.wait', resumeStep: 1 }] }];
              }
              case 1: {
                // After resume, access nested property from vars
                const data = vars.__data as { nested: { value: number } };
                return [DONE, { result: data.nested.value }];
              }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      await executor.emit('svc.wait', { testId: 'test-1' }, {});

      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { result: 42 });
    });
  });

  describe('multiple sequential suspensions', () => {
    // Source pattern:
    //   const a = await signal(deps.svc.step1);
    //   const b = await signal(deps.svc.step2);
    //   const c = await signal(deps.svc.step3);
    //   return { a: a.v, b: b.v, c: c.v };

    it('accumulates payloads from 3 sequential signals', async () => {
      const process = createSwitchProcess({
        id: 'test-sequential',
        stepMap: { entry: 0, afterStep1: 1, afterStep2: 2, afterStep3: 3 },
        signals: {
          'svc.step1': { identity: ['testId'], payloadType: 'unknown' },
          'svc.step2': { identity: ['testId'], payloadType: 'unknown' },
          'svc.step3': { identity: ['testId'], payloadType: 'unknown' },
        },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'svc.step1', resumeStep: 1 }] }];
              }
              case 1: {
                vars.__a = (vars.__raceResult as { v: unknown }).v;
                state.step = 2;
                return [SUSPEND, { race: [{ id: 'signal_1', signal: 'svc.step2', resumeStep: 2 }] }];
              }
              case 2: {
                vars.__b = (vars.__raceResult as { v: unknown }).v;
                state.step = 3;
                return [SUSPEND, { race: [{ id: 'signal_2', signal: 'svc.step3', resumeStep: 3 }] }];
              }
              case 3: {
                vars.__c = (vars.__raceResult as { v: unknown }).v;
                return [DONE, { a: vars.__a, b: vars.__b, c: vars.__c }];
              }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Fire step1
      await executor.emit('svc.step1', { testId: 'test-1' }, { v: 'alpha' });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Fire step2
      await executor.emit('svc.step2', { testId: 'test-1' }, { v: 'beta' });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Fire step3
      await executor.emit('svc.step3', { testId: 'test-1' }, { v: 'gamma' });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { a: 'alpha', b: 'beta', c: 'gamma' });
    });
  });

  describe('while loop with conditional break after suspension', () => {
    // Source pattern:
    //   let count = 0;
    //   while (true) {
    //     const result = await signal(deps.svc.tick);
    //     count++;
    //     if (result.done) break;
    //   }
    //   return { count };

    it('loops through 3 ticks then breaks on done=true', async () => {
      const process = createSwitchProcess({
        id: 'test-while-break',
        stepMap: { entry: 0, afterTick: 1, done: 2 },
        signals: {
          'svc.tick': { identity: ['testId'], payloadType: 'unknown' },
        },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                // Initialize loop variable
                if (vars.__count === undefined) {
                  vars.__count = 0;
                }
                // Suspend on tick signal
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'svc.tick', resumeStep: 1 }] }];
              }
              case 1: {
                // Resume from tick
                const result = vars.__raceResult as { done: boolean };
                vars.__count = (vars.__count as number) + 1;
                if (result.done) {
                  // Break out of while loop
                  state.step = 2;
                  continue;
                }
                // Loop back - suspend on next tick
                state.step = 0;
                continue;
              }
              case 2: {
                return [DONE, { count: vars.__count }];
              }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Tick 1 - not done
      await executor.emit('svc.tick', { testId: 'test-1' }, { done: false });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Tick 2 - not done
      await executor.emit('svc.tick', { testId: 'test-1' }, { done: false });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Tick 3 - not done
      await executor.emit('svc.tick', { testId: 'test-1' }, { done: false });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // Tick 4 - done!
      await executor.emit('svc.tick', { testId: 'test-1' }, { done: true });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { count: 4 });
    });

    it('breaks immediately on first tick if done=true', async () => {
      const process = createSwitchProcess({
        id: 'test-while-break-immediate',
        stepMap: { entry: 0, afterTick: 1, done: 2 },
        signals: {
          'svc.tick': { identity: ['testId'], payloadType: 'unknown' },
        },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                if (vars.__count === undefined) {
                  vars.__count = 0;
                }
                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'svc.tick', resumeStep: 1 }] }];
              }
              case 1: {
                const result = vars.__raceResult as { done: boolean };
                vars.__count = (vars.__count as number) + 1;
                if (result.done) {
                  state.step = 2;
                  continue;
                }
                state.step = 0;
                continue;
              }
              case 2: {
                return [DONE, { count: vars.__count }];
              }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      // First tick with done=true
      await executor.emit('svc.tick', { testId: 'test-1' }, { done: true });
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(state?.result, { count: 1 });
    });
  });
});
