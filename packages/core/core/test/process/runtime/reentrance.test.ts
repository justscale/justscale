/**
 * Re-entrance and concurrency edge cases.
 *
 * These tests probe what the executor does when signals arrive while
 * another signal for the same instance is still being processed, and
 * when the same signal fires rapidly in succession.
 *
 * The InMemorySignalBus uses `processingInstances` to serialize
 * delivery per-instance: if a second race-branch match lands while the
 * first is still inside `notifyMatch`, it is queued and replayed after.
 * (See signal-bus.ts emit().) This test file documents what observable
 * behaviour that buys us.
 *
 * Also surfaces the "one emit re-delivers to a just-created sub" bug
 * in its race-based variant — complementary to the signal-dispatch
 * test file.
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
  countUntilKill,
  selfDispatch,
  EdgeSignals,
} from '../fixtures/runtime-edge-cases.process.js';

function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> }).__compiled;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Re-entrance and concurrency', () => {
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
  // countUntilKill: tick arrives N times, then kill. Process must see
  // all ticks in order.
  //
  // This is the clean-case for races because ticks cause the handler
  // to `continue` and re-subscribe — race branches (unlike simple subs)
  // DO get the processing/queuing protection in the signal bus.
  // --------------------------------------------------------------------------

  it('a loop with a race re-subscribes and counts every tick signal delivered sequentially', async () => {
    const handle = await executor.start(compiled(countUntilKill), ['c1']);

    // Five sequential ticks. Each must drive exactly one loop iteration.
    for (let i = 1; i <= 5; i++) {
      await executor.emit('edge.tick', { id: 'c1' }, { n: i });
      await tick();
    }

    await executor.emit('edge.kill', { id: 'c1' }, { reason: 'done' });

    const result = await handle.wait();
    assert.deepEqual(result, { id: 'c1', count: 5, reason: 'done' });
  });

  // --------------------------------------------------------------------------
  // Rapid-fire ticks: dispatched without yielding. The signal bus's
  // processingInstances gate should serialize them.
  // --------------------------------------------------------------------------

  it('rapid concurrent tick emits queue per-instance and drain in order', async () => {
    const handle = await executor.start(compiled(countUntilKill), ['c2']);

    // Fire 5 emits without awaiting between them.
    const emits = [
      executor.emit('edge.tick', { id: 'c2' }, { n: 1 }),
      executor.emit('edge.tick', { id: 'c2' }, { n: 2 }),
      executor.emit('edge.tick', { id: 'c2' }, { n: 3 }),
      executor.emit('edge.tick', { id: 'c2' }, { n: 4 }),
      executor.emit('edge.tick', { id: 'c2' }, { n: 5 }),
    ];
    await Promise.all(emits);
    await tick();

    await executor.emit('edge.kill', { id: 'c2' }, { reason: 'bye' });

    const result = (await handle.wait()) as { count: number; reason: string; id: string };
    assert.equal(
      result.count,
      5,
      `Expected 5 counted ticks from 5 rapid-fire emits, got ${result.count}. Signal bus is either dropping or doubling deliveries.`,
    );
  });

  // --------------------------------------------------------------------------
  // Two processes at different paths, same signal identity → both wake
  // --------------------------------------------------------------------------

  it('two separate processes subscribed on the same identity both receive the emit', async () => {
    const h1 = await executor.start(compiled(countUntilKill), ['same']);

    // Manually register a second waiter on the same signal+identity
    // via the bus to mimic "another process at a different path".
    const secondSub = await signalBus.subscribe(
      'fake/other-path/same',
      'edge.tick',
      { id: 'same' },
    );

    const matches = await executor.emit('edge.tick', { id: 'same' }, { n: 1 });
    assert.equal(
      matches,
      2,
      'Two subscribers on the same signal+identity must both match from one emit.',
    );

    // Clean up: kill the process, and the fake sub was already consumed.
    await executor.emit('edge.kill', { id: 'same' }, { reason: 'cleanup' });
    const r = (await h1.wait()) as { count: number; reason: string; id: string };
    assert.equal(r.reason, 'cleanup');

    // The fake subscription got matched alongside the process's race - both
    // sides received the same payload from the single emit.
    const secondMatch = await signalBus.checkSignal(secondSub);
    assert.ok(secondMatch, 'Manual subscription must have a recorded match alongside the process race.');
    assert.equal((secondMatch.payload as { n: number }).n, 1);
  });

  // --------------------------------------------------------------------------
  // Self-dispatch: a process that emits its own signal BEFORE the
  // race() registers a subscription. This is a no-op under current
  // semantics (pre-subscribe emits aren't queued). The race resolves
  // via the post-start emit from the test.
  // --------------------------------------------------------------------------

  it('self-dispatch before subscribing is a no-op, then post-start emit unblocks the process', async () => {
    const handle = await executor.start(compiled(selfDispatch), ['s1']);

    // The handler emitted once already during its own run. That emit
    // happened BEFORE the race subscription was registered — it went
    // to no one.
    // Give the process a beat to suspend.
    await tick();

    const state = await storage.load('edge/self-dispatch/s1');
    assert.equal(
      state?.status,
      'suspended',
      'Process must NOT have resolved from its own pre-subscribe emit.',
    );

    // Now actually deliver a tick from outside. This one lands.
    await executor.emit('edge.tick', { id: 's1' }, { n: 7 });

    const result = (await handle.wait()) as { id: string; n: number };
    assert.equal(
      result.n,
      7,
      'Observed payload must come from the post-start emit, not the self-emit.',
    );
  });

  // --------------------------------------------------------------------------
  // Many concurrent instances, same signal name, distinct identities.
  // No cross-talk.
  // --------------------------------------------------------------------------

  it('10 concurrent instances do not cross-talk', async () => {
    const handles = await Promise.all(
      Array.from({ length: 10 }, (_, i) => executor.start(compiled(countUntilKill), [`p${i}`])),
    );

    // Give each a couple of ticks.
    for (let i = 0; i < 10; i++) {
      await executor.emit('edge.tick', { id: `p${i}` }, { n: 1 });
      await executor.emit('edge.tick', { id: `p${i}` }, { n: 2 });
      await tick();
    }

    // Kill them all.
    for (let i = 0; i < 10; i++) {
      await executor.emit('edge.kill', { id: `p${i}` }, { reason: `r${i}` });
    }

    const results = (await Promise.all(handles.map((h) => h.wait()))) as Array<{
      id: string
      reason: string
      count: number
    }>;

    for (let i = 0; i < 10; i++) {
      assert.equal(results[i].id, `p${i}`);
      assert.equal(results[i].reason, `r${i}`);
      assert.equal(
        results[i].count,
        2,
        `Instance ${i} counted the wrong number of ticks — signals crossed between identities.`,
      );
    }
  });

  // --------------------------------------------------------------------------
  // Burst then pause: ensure the per-instance signalQueue drains fully
  // --------------------------------------------------------------------------

  it('a burst followed by a lone kill drains the queue entirely before running the kill branch', async () => {
    const handle = await executor.start(compiled(countUntilKill), ['b1']);

    // 20 rapid ticks.
    const ticks = Array.from({ length: 20 }, (_, i) =>
      executor.emit('edge.tick', { id: 'b1' }, { n: i }));
    await Promise.all(ticks);
    await tick();

    await executor.emit('edge.kill', { id: 'b1' }, { reason: 'enough' });

    const result = (await handle.wait()) as { count: number; reason: string; id: string };

    // The exact count is an observable of the delivery semantics —
    // pin the current behaviour down so we notice if it silently
    // changes. With race-based suspensions and the per-instance
    // queue, every tick should be delivered.
    assert.equal(
      result.count,
      20,
      `Burst of 20 ticks produced count=${result.count}. Expected 20; any other value signals lost or doubled deliveries in the race queue.`,
    );
    assert.equal(result.reason, 'enough');
  });
});
