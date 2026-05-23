/**
 * Regression guard for the "naked break inside if-body of a race branch"
 * bug. The compiler used to preserve the `break;` verbatim, which in the
 * emitted code exits the compiled `switch(step)` but leaves `step`
 * unchanged — the branch body then runs forever on the next `while(true)`
 * iteration.
 *
 * Source pattern (what the user writes):
 *
 *   while (true) {
 *     const r = race();
 *     switch (true) {
 *       case signal(r, deps.signals.tick): {
 *         if (r.skip) {
 *           await deps.signals.rejected({ reason: 'skipped' });
 *           break;  // ← user means "exit switch(true), re-race"
 *         }
 *         await deps.signals.handled({ value: r.value });
 *         break;
 *       }
 *     }
 *   }
 *
 * Buggy compiler output (before the fix): naked `break;` inside the
 * `if (r.skip) { ... break; }` branch falls out of the compiled
 * switch(step) leaving step=1 so case 1 runs again instantly, forever.
 *
 * Fixed compiler output (after the fix): the break is rewritten to
 * `step = <race-continuation>; continue main_loop;`. This test mirrors
 * the FIXED output to confirm the runtime handles it correctly.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProcessExecutor,
} from '../../../src/runtime/process/executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../../src/process/types.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

const createMockResolver = (): Resolver =>
  (async () => undefined) as Resolver;

const createSwitchProcess = (
  overrides: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> & {
    execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  },
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id: 'race-break-in-if',
  path: '/race-break-in-if/:id',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0, branch: 1, loopback: 2 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

describe('race branch: naked break inside nested if (compiler parity)', () => {
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

  it('fixed compiled output (break rewritten to step=continuation) does not infinite-loop', { timeout: 3000 }, async () => {
    let branchEnterCount = 0;

    const process = createSwitchProcess({
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;
        const __r: [number, unknown] = [0, undefined];
        let step = state.step;

         
        main_loop: while (true) {
          switch (step) {
            case 0: {
              // entry: register the race and suspend
              vars.__raceBranches = [
                { id: 'tick', signal: 'tick', resumeStep: 1 },
              ];
              __r[0] = 1;
              __r[1] = { race: vars.__raceBranches };
              state.step = 1;
              break main_loop;
            }
            case 1: {
              // race branch body (resumeStep = 1)
              branchEnterCount++;
              const r = vars.__raceResult as { skip: boolean };
              if (r.skip) {
                // THE FIX: rewritten `break;` goes to continuation, not
                // out of switch(step).
                step = 2;
                continue main_loop;
              }
              step = 2;
              continue main_loop;
            }
            case 2: {
              // continuation: loop back to entry to re-race
              step = 0;
              continue main_loop;
            }
            default:
              throw new Error(`Invalid step: ${step}`);
          }
        }
        return __r as ExecutionResult;
      },
    });

    await executor.start(process, ['t1']);
    await new Promise(r => setImmediate(r));

    await signalBus.emit('tick', { id: 't1' }, { skip: true });

    // Let things settle. With the fix, the branch body runs exactly once
    // per signal and the process re-suspends on the next race.
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));

    assert.equal(
      branchEnterCount,
      1,
      `branch body must execute exactly once per signal; got ${branchEnterCount}`,
    );

    // And the process must be back in suspended state waiting for the
    // next tick, not lodged at some weird pc.
    const storedState = await storage.load('race-break-in-if/t1');
    assert.ok(storedState, 'state should exist in storage');
    assert.equal(storedState.status, 'suspended', `process should be suspended; got status=${storedState.status}`);
  });

  it('buggy compiled output (naked break preserved) infinite-loops — demonstrates the pre-fix behaviour', { timeout: 3000 }, async () => {
    let branchEnterCount = 0;
    const LIMIT = 50;

    const process = createSwitchProcess({
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;
        const __r: [number, unknown] = [0, undefined];

         
        main_loop: while (true) {
          switch (state.step) {
            case 0: {
              state.step = 1;
              vars.__raceBranches = [
                { id: 'tick', signal: 'tick', resumeStep: 1 },
              ];
              __r[0] = 1;
              __r[1] = { race: vars.__raceBranches };
              break main_loop;
            }
            case 1: {
              branchEnterCount++;
              if (branchEnterCount > LIMIT) {
                __r[0] = 0;
                __r[1] = { infiniteLoop: true };
                break main_loop;
              }
              const r = vars.__raceResult as { skip: boolean };
              if (r.skip) {
                // BUG: the pre-fix compiler output — this break exits
                // switch(state.step) but leaves state.step=1, so the
                // while loop re-enters case 1 instantly.
                break;
              }
              state.step = 0;
              continue main_loop;
            }
            default:
              throw new Error(`Invalid step: ${state.step}`);
          }
        }
        return __r as ExecutionResult;
      },
    });

    await executor.start(process, ['t1']);
    await new Promise(r => setImmediate(r));
    await signalBus.emit('tick', { id: 't1' }, { skip: true });
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

    assert.ok(
      branchEnterCount > LIMIT,
      `the buggy pattern must infinite-loop (this test documents the bug); got ${branchEnterCount} entries`,
    );
  });
});
