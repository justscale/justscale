/**
 * Timer dispatch semantics for race branches.
 *
 * The runtime uses `InMemoryTimerScheduler`, which is driven by real
 * setTimeout under the hood. Tests here use `fireNext()` / `fireAll()`
 * to control dispatch deterministically rather than sleeping.
 *
 * Referenced memories:
 *  - memory/signal-delivery-model.md: races are lock-gated; losing
 *    branches MUST be cancelled once a winner is picked
 *  - memory/process-runtime-decisions.md: best-effort dispatch, no
 *    duplicate delivery
 *
 * The "two delays in one race, smaller wins" branch is asserted
 * behaviourally by firing `fireNext()`, which pops the oldest-scheduled
 * timer — and since the compiler registers branches in source order,
 * the shorter delay is scheduled first when it appears first in the
 * switch. This test pins down that ordering guarantee.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ProcessExecutor } from '../../../src/runtime/process/executor.js';
import {
  createInMemoryProcessStorage,
  type InMemoryProcessStorageInstance,
} from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import {
  setProcessExecutor,
  type CompiledSwitchProcess,
} from '../../../src/process/index.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

import {
  twoDelayRace,
  EdgeSignals,
} from '../fixtures/runtime-edge-cases.process.js';

function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> }).__compiled;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Timer dispatch — race branches', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;
  let serviceMap: Map<unknown, unknown>;

  const resolver: Resolver = (async (token: unknown) =>
    serviceMap.get(token)) as Resolver;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();
    serviceMap = new Map();

    executor = new ProcessExecutor({
      resolve: resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    serviceMap.set(EdgeSignals, {
      tick: executor.createSignal<[id: string], { n: number }>(
        'edge.tick',
        ['id'],
      ),
      kill: executor.createSignal<[id: string], { reason: string }>(
        'edge.kill',
        ['id'],
      ),
      ping: executor.createSignal<[id: string]>(
        'edge.ping',
        ['id'],
      ),
      pair: executor.createSignal<[a: string, b: string], { who: string }>(
        'edge.pair',
        ['a', 'b'],
      ),
    });

    setProcessExecutor(executor);
  });

  afterEach(() => {
    setProcessExecutor(null);
    timerScheduler.stop();
    timerScheduler.clear();
    signalBus.clear();
    storage.clear();
  });

  // --------------------------------------------------------------------------
  // Smaller delay wins when only timers race
  // --------------------------------------------------------------------------

  it('when two delay branches race and no signal fires, fireNext() wins the earliest-scheduled timer', async () => {
    const handle = await executor.start(compiled(twoDelayRace), ['d1']);

    // Race has one signal branch + two delay branches → 2 pending timers.
    assert.equal(
      timerScheduler.pendingCount,
      2,
      'Two delay branches in the race must register two distinct timers',
    );

    // `fireNext` pops the earliest-scheduled timer, which is the short
    // one because the compiler emits branches in source order.
    timerScheduler.fireNext();

    const result = await handle.wait();
    assert.deepEqual(result, { id: 'd1', which: 'short-timer' });

    // The losing timer must have been cancelled, not just left dangling.
    assert.equal(
      timerScheduler.pendingCount,
      0,
      'Losing timer branch must be cancelled when a race resolves.',
    );
  });

  // --------------------------------------------------------------------------
  // Signal beats timer
  // --------------------------------------------------------------------------

  it('when a signal arrives before any timer fires, the signal branch wins and all timers cancel', async () => {
    const handle = await executor.start(compiled(twoDelayRace), ['d2']);
    assert.equal(timerScheduler.pendingCount, 2);

    await executor.emit('edge.tick', { id: 'd2' }, { n: 4 });

    const result = await handle.wait();
    assert.deepEqual(result, { id: 'd2', which: 'tick', n: 4 });

    assert.equal(
      timerScheduler.pendingCount,
      0,
      'Both timers must be cancelled when the signal wins.',
    );
  });

  // --------------------------------------------------------------------------
  // Timer fires while process is already running (not yet suspended)
  //
  // We approximate this by firing a timer that DOESN'T belong to any
  // suspended instance — the scheduler should notify, the executor
  // should look up the instance, find it missing or non-suspended,
  // and silently no-op rather than crash.
  // --------------------------------------------------------------------------

  it('a completed instance is not re-driven by late-firing setTimeouts', { timeout: 3000 }, async () => {
    const handle = await executor.start(compiled(twoDelayRace), ['d3']);
    assert.equal(timerScheduler.pendingCount, 2);

    // Use a signal that is one of the race branches so the process
    // actually resumes. `edge.kill` is NOT a branch of twoDelayRace —
    // use `edge.tick` instead.
    await executor.emit('edge.tick', { id: 'd3' }, { n: 99 });
    await handle.wait();

    const before = await storage.load('edge/two-delay/d3');
    assert.equal(before?.status, 'completed');

    // Give any queued setTimeouts room to fire. The cancelled() code
    // path in scheduleTimeout's inner closure checks `this.timers.has`
    // and bails out, so the process must not be re-driven.
    await new Promise((r) => setTimeout(r, 30));

    const after = await storage.load('edge/two-delay/d3');
    assert.deepEqual(
      after?.result,
      before?.result,
      'Completed instance must not be re-driven by late-firing setTimeouts',
    );
  });

  // --------------------------------------------------------------------------
  // Multiple concurrent instances with overlapping delays
  // --------------------------------------------------------------------------

  it('timers scheduled by different instances are isolated', async () => {
    const h1 = await executor.start(compiled(twoDelayRace), ['m1']);
    const h2 = await executor.start(compiled(twoDelayRace), ['m2']);
    const h3 = await executor.start(compiled(twoDelayRace), ['m3']);

    // 3 instances × 2 timers each.
    assert.equal(timerScheduler.pendingCount, 6);

    // Only signal m2 — m1 and m3 must still have all their timers.
    await executor.emit('edge.tick', { id: 'm2' }, { n: 2 });

    const r2 = await h2.wait();
    assert.deepEqual(r2, { id: 'm2', which: 'tick', n: 2 });

    // m2's 2 timers should be gone; m1 and m3 still have 2 each.
    assert.equal(
      timerScheduler.pendingCount,
      4,
      'Winning a race on one instance must not cancel other instances\' timers.',
    );

    // Clean up: fire all remaining timers so the hanging handles resolve.
    while (timerScheduler.pendingCount > 0) timerScheduler.fireNext();
    await Promise.all([h1.wait(), h3.wait()]);
  });

  // --------------------------------------------------------------------------
  // Timer calculates correct duration from compile-time literals
  // --------------------------------------------------------------------------

  it('literal delay units are converted to milliseconds correctly', async () => {
    const handle = await executor.start(compiled(twoDelayRace), ['lit1']);

    // We don't know the exact timer IDs, but we can inspect the
    // scheduler's internal map.
    const timers = [...(timerScheduler as unknown as { timers: Map<string, { expiresAt: Date }> }).timers.values()];
    assert.equal(timers.length, 2);

    const now = Date.now();
    const durations = timers.map((t) => t.expiresAt.getTime() - now);
    durations.sort((a, b) => a - b);

    // twoDelayRace: delay.seconds(r, 1) + delay.minutes(r, 10)
    const short = durations[0];
    const long = durations[1];

    // Allow 200ms slop for setTimeout scheduling noise.
    assert.ok(
      short > 900 && short < 1200,
      `Expected ~1000ms for delay.seconds(1), got ${short}ms`,
    );
    assert.ok(
      long > 599000 && long < 601000,
      `Expected ~600000ms for delay.minutes(10), got ${long}ms`,
    );

    // Clean up
    while (timerScheduler.pendingCount > 0) timerScheduler.fireNext();
    await handle.wait();
  });

  // --------------------------------------------------------------------------
  // fireNext on empty scheduler is safe
  // --------------------------------------------------------------------------

  it('fireNext() on an empty scheduler is a no-op', () => {
    assert.equal(timerScheduler.pendingCount, 0);
    // Must not throw.
    timerScheduler.fireNext();
    timerScheduler.fireNext();
    assert.equal(timerScheduler.pendingCount, 0);
  });

  // --------------------------------------------------------------------------
  // Cancellation semantics — a cancelled timer is removed from the map
  // and does not fire if its already-scheduled setTimeout resolves.
  // --------------------------------------------------------------------------

  it('cancelled timer does not re-drive the process after its setTimeout eventually fires', async () => {
    const handle = await executor.start(compiled(twoDelayRace), ['c1']);

    // Signal the race — both timers get cancelled by the executor.
    await executor.emit('edge.tick', { id: 'c1' }, { n: 1 });
    await handle.wait();

    assert.equal(timerScheduler.pendingCount, 0);

    // Even if we wait a moment for setTimeouts to drain, the process
    // must remain completed with the signal result.
    await new Promise((r) => setTimeout(r, 20));

    const state = await storage.load('edge/two-delay/c1');
    assert.equal(state?.status, 'completed');
    assert.deepEqual(state?.result, { id: 'c1', which: 'tick', n: 1 });
  });
});
