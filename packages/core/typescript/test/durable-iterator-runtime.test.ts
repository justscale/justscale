/**
 * Runtime execution tests for durable for-of loops.
 *
 * These tests verify the full execute -> suspend -> resume cycle by hand-writing
 * execute functions that mirror the compiled ITER output (main_loop with switch/step),
 * then running them through ProcessExecutor with in-memory infra.
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
import {
  DurableArrayIterator,
  DurableCursor,
  FromCursor,
  type DurableCursorType,
  type DurableIterable,
} from '../../core/src/process/primitives.js';

const createMockResolver = (): Resolver =>
  (async () => undefined) as Resolver;

const createSwitchProcess = (
  overrides: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> & {
    execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  }
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id: 'test-iter',
  path: '/test/:testId',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

/**
 * Mock DurableIterable that tracks cursor save/restore.
 */
class MockDurableIterable<T> implements DurableIterable<T>, AsyncIterable<T> {
  declare readonly __durableIterator: true;
  declare readonly __cursorType: Record<string, number>;
  declare readonly orderBy: string[];

  readonly cursorsRestored: DurableCursorType[] = [];

  constructor(private readonly items: T[]) {}

  [DurableCursor](): DurableCursorType { return 0; }

  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<T> {
    this.cursorsRestored.push(cursor);
    return new MockDurableIterator(this.items, cursor as number);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return new MockDurableIterator(this.items, 0);
  }
}

class MockDurableIterator<T> implements DurableIterable<T>, AsyncIterableIterator<T> {
  private index: number;

  constructor(
    private readonly items: T[],
    initialIndex: number,
  ) {
    this.index = initialIndex;
  }

  [DurableCursor](): DurableCursorType { return this.index; }

  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<T> {
    return new MockDurableIterator(this.items, cursor as number);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }

  async next(): Promise<IteratorResult<T>> {
    if (this.index >= this.items.length) {
      return { done: true, value: undefined };
    }
    const value = this.items[this.index];
    this.index++;
    return { done: false, value };
  }
}

describe('Durable Iterator Runtime', () => {
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

  describe('array for-of with suspend/resume', () => {
    it('iterates all items across suspend/resume cycles', async () => {
      const items = ['a', 'b', 'c'];
      const collected: string[] = [];

      // Mirrors compiled for-of with signal (using race for re-entrancy safety):
      //   Step 0: ITER_START + ITER_NEXT + body + ITER_SAVE + RACE_SUSPEND
      //   Step 1: JUMP back to step 0
      //   Step 2: loop done -> DONE
      const process = createSwitchProcess({
        stepMap: { entry: 0, resume: 1, done: 2 },
        signals: { 'test.continue': { identity: ['testId'], payloadType: 'unknown' } },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;
          const fromCursorSym = Symbol.for('justscale:FromCursor');
          const durableCursorSym = Symbol.for('justscale:DurableCursor');

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                const cursor = vars.__cursor_0;
                const iter = cursor !== undefined
                  ? (fromCursorSym in (items as object)
                    ? (items as any)[fromCursorSym](cursor)[Symbol.asyncIterator]()
                    : new DurableArrayIterator(items, cursor as DurableCursorType))
                  : (fromCursorSym in (items as object)
                    ? (items as any)[Symbol.asyncIterator]()
                    : new DurableArrayIterator(items));

                const { value, done } = await iter.next();
                if (done) { state.step = 2; continue; }

                collected.push(value);

                if (durableCursorSym in iter) {
                  vars.__cursor_0 = (iter as any)[durableCursorSym]();
                }

                state.step = 1;
                // Use race-style suspend (matches real compiled output)
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.continue', resumeStep: 1 }] }];
              }
              case 1: { state.step = 0; continue; }
              case 2: { return [DONE, { items: [...collected] }]; }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);
      assert.strictEqual(collected.length, 1);
      assert.strictEqual(collected[0], 'a');

      let state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'suspended');

      await executor.emit('test.continue', { testId: 'test-1' }, {});
      assert.strictEqual(collected.length, 2);
      assert.strictEqual(collected[1], 'b');

      await executor.emit('test.continue', { testId: 'test-1' }, {});
      assert.strictEqual(collected.length, 3);
      assert.strictEqual(collected[2], 'c');

      // Final resume - iterator is done, process completes
      await executor.emit('test.continue', { testId: 'test-1' }, {});
      state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
    });
  });

  describe('DurableIterable for-of with suspend/resume', () => {
    it('saves and restores cursor through DurableIterable protocol', async () => {
      const iterable = new MockDurableIterable(['x', 'y', 'z']);
      const collected: string[] = [];

      const process = createSwitchProcess({
        stepMap: { entry: 0, resume: 1, done: 2 },
        signals: { 'test.continue': { identity: ['testId'], payloadType: 'unknown' } },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;
          const fromCursorSym = Symbol.for('justscale:FromCursor');
          const durableCursorSym = Symbol.for('justscale:DurableCursor');

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                const cursor = vars.__cursor_0;
                const iter = cursor !== undefined
                  ? (fromCursorSym in iterable
                    ? iterable[FromCursor](cursor as DurableCursorType)[Symbol.asyncIterator]()
                    : new DurableArrayIterator([], cursor as DurableCursorType))
                  : (fromCursorSym in iterable
                    ? iterable[Symbol.asyncIterator]()
                    : new DurableArrayIterator([]));

                const { value, done } = await iter.next();
                if (done) { state.step = 2; continue; }

                collected.push(value as string);

                if (durableCursorSym in iter) {
                  vars.__cursor_0 = (iter as any)[durableCursorSym]();
                }

                state.step = 1;
                return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.continue', resumeStep: 1 }] }];
              }
              case 1: { state.step = 0; continue; }
              case 2: { return [DONE, { items: [...collected] }]; }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      await executor.start(process, ['test-1']);
      assert.strictEqual(collected[0], 'x');

      await executor.emit('test.continue', { testId: 'test-1' }, {});
      assert.strictEqual(collected[1], 'y');
      assert.ok(iterable.cursorsRestored.length >= 1, 'FromCursor should have been called');

      await executor.emit('test.continue', { testId: 'test-1' }, {});
      assert.strictEqual(collected[2], 'z');

      await executor.emit('test.continue', { testId: 'test-1' }, {});
      const state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
      assert.deepStrictEqual(collected, ['x', 'y', 'z']);
    });
  });

  describe('cursor integrity', () => {
    it('suspend after item 2 of 5, resume yields items 3-5', async () => {
      const items = [10, 20, 30, 40, 50];
      const collected: number[] = [];
      let suspendCount = 0;

      const process = createSwitchProcess({
        stepMap: { entry: 0, resume: 1, done: 2 },
        signals: { 'test.continue': { identity: ['testId'], payloadType: 'unknown' } },
        execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
          const state = ctx.state;
          const vars = state.vars as Record<string, unknown>;
          const durableCursorSym = Symbol.for('justscale:DurableCursor');

          // biome-ignore lint/correctness/noConstantCondition: mirrors compiled main_loop
          while (true) {
            switch (state.step) {
              case 0: {
                const cursor = vars.__cursor_0;
                const iter = cursor !== undefined
                  ? new DurableArrayIterator(items, cursor as DurableCursorType)
                  : new DurableArrayIterator(items);

                // Process multiple items per wake-up
                // biome-ignore lint/correctness/noConstantCondition: processing loop
                while (true) {
                  const { value, done } = await iter.next();
                  if (done) { state.step = 2; break; }

                  collected.push(value);

                  // Suspend after 2 items on first run
                  if (suspendCount === 0 && collected.length === 2) {
                    suspendCount++;
                    if (durableCursorSym in iter) {
                      vars.__cursor_0 = iter[DurableCursor]();
                    }
                    state.step = 1;
                    return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.continue', resumeStep: 1 }] }];
                  }
                }
                continue;
              }
              case 1: { state.step = 0; continue; }
              case 2: { return [DONE, { items: [...collected] }]; }
              default: throw new Error(`Unexpected step: ${state.step}`);
            }
          }
        },
      });

      // Start - processes [10, 20], suspends
      await executor.start(process, ['test-1']);
      assert.deepStrictEqual(collected, [10, 20]);

      // Resume - continues from cursor=2, processes [30, 40, 50], completes
      await executor.emit('test.continue', { testId: 'test-1' }, {});
      assert.deepStrictEqual(collected, [10, 20, 30, 40, 50]);

      const state = await storage.load('test/test-1');
      assert.strictEqual(state?.status, 'completed');
    });
  });
});
