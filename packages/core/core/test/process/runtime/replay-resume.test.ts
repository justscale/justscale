/**
 * Replay & resume (adapter-agnostic) edge cases.
 *
 * Simulates executor restart by tearing down one ProcessExecutor and
 * building another against the SAME storage. Signal bus/timer
 * scheduler are rebuilt fresh (that's what happens on a real restart —
 * in-memory subs/timers are lost; storage survives).
 *
 * Pins down:
 *  - A suspended process's state survives
 *  - A second executor that calls start() with the same params
 *    re-subscribes on its new bus (via resubscribeSuspended)
 *  - Variables set BEFORE suspension are still there post-resume
 *  - Status stays 'suspended' across the transition (not 'failed' /
 *    'pending')
 *
 * Relevant memories:
 *  - memory/process-runtime-decisions.md: serialization via type registry
 *  - memory/signal-delivery-model.md: suspensions are restartable
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
  awaitTick,
  twoDelayRace,
  countUntilKill,
  EdgeSignals,
} from '../fixtures/runtime-edge-cases.process.js';

function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> }).__compiled;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Replay / resume (simulated executor restart)', () => {
  let storage: InMemoryProcessStorageInstance;

  // Helper: build an executor bound to a provided signal bus + scheduler.
  function buildExecutor(
    signalBus: InMemorySignalBus,
    timerScheduler: InMemoryTimerScheduler,
    serviceMap: Map<unknown, unknown>,
  ) {
    const resolver: Resolver = (async (token: unknown) =>
      serviceMap.get(token)) as Resolver;

    const executor = new ProcessExecutor({
      resolve: resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    // Populate the signal bundle against THIS executor so signal
    // emits go to THIS bus.
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
    return executor;
  }

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
  });

  afterEach(() => {
    setProcessExecutor(null);
    storage.clear();
  });

  // --------------------------------------------------------------------------
  // Baseline: persisted state survives across executor re-creation
  // --------------------------------------------------------------------------

  it('persisted suspended state survives across executor re-creation', async () => {
    const bus1 = new InMemorySignalBus();
    const sch1 = new InMemoryTimerScheduler();
    const map1 = new Map<unknown, unknown>();
    const exec1 = buildExecutor(bus1, sch1, map1);

    await exec1.start(compiled(awaitTick), ['r1']);

    const snap1 = await storage.load('edge/await-tick/r1');
    assert.equal(snap1?.status, 'suspended');
    const stepBefore = snap1?.pc;

    // Simulate restart: drop executor + transient state.
    bus1.clear();
    sch1.stop();
    sch1.clear();
    setProcessExecutor(null);

    // Build a brand-new executor on the SAME storage.
    const bus2 = new InMemorySignalBus();
    const sch2 = new InMemoryTimerScheduler();
    const map2 = new Map<unknown, unknown>();
    buildExecutor(bus2, sch2, map2);

    // State IS still there (storage is shared).
    const snap2 = await storage.load('edge/await-tick/r1');
    assert.equal(snap2?.status, 'suspended');
    assert.equal(snap2?.pc, stepBefore);
  });

  // --------------------------------------------------------------------------
  // BUG SURFACED: resubscribeSuspended() only handles __raceBranches.
  //
  // A process suspended on a plain `await signal(x)` (i.e. no race())
  // gets a SIMPLE subscription in the signal bus at suspend time. That
  // subscription lives only in memory. On executor restart,
  // resubscribeSuspended() looks for `state.variables.__raceBranches`,
  // finds nothing (it's a simple signal), and re-subscribes NOTHING.
  // The instance is effectively stuck — new emits on the new bus
  // don't find a subscriber, and the process never resumes.
  //
  // Race-based suspensions (via race()) work fine because their
  // branches are persisted in state.vars.__raceBranches.
  //
  // Fix direction: suspend() for plain signals should also persist
  // the signal name into state.vars, and resubscribeSuspended() should
  // re-subscribe on the simple-signal path when __raceBranches is
  // absent.
  // --------------------------------------------------------------------------

  it('plain `await signal(x)` (no race) re-subscribes correctly on restart', async () => {
    const bus1 = new InMemorySignalBus();
    const sch1 = new InMemoryTimerScheduler();
    const map1 = new Map<unknown, unknown>();
    const exec1 = buildExecutor(bus1, sch1, map1);

    await exec1.start(compiled(awaitTick), ['b1']);
    assert.equal(bus1.subscriptionCount, 1, 'Initial suspend registers one simple subscription.');

    // Restart.
    bus1.clear();
    sch1.stop();
    sch1.clear();
    setProcessExecutor(null);

    const bus2 = new InMemorySignalBus();
    const sch2 = new InMemoryTimerScheduler();
    const map2 = new Map<unknown, unknown>();
    const exec2 = buildExecutor(bus2, sch2, map2);

    // Re-start triggers resubscribeSuspended(). With the fix, the plain-signal
    // subscription is restored because suspend() now persists the signal name
    // in state.vars.__suspendSignal.
    const handle = await exec2.start(compiled(awaitTick), ['b1']);
    assert.equal(
      bus2.subscriptionCount,
      1,
      'Plain-signal suspension must be re-subscribed on restart.',
    );

    // Emitting on the new bus now wakes the process.
    const matched = await exec2.emit('edge.tick', { id: 'b1' }, { n: 1 });
    assert.equal(matched, 1, 'Signal must find the re-subscribed process.');

    const result = await handle.wait();
    assert.deepEqual(result, { id: 'b1', n: 1 });
  });

  // --------------------------------------------------------------------------
  // Race with delay: the timer ALSO gets re-scheduled on restart
  // --------------------------------------------------------------------------

  it('re-schedules delay branches when resuming a race across executor restart', async () => {
    const bus1 = new InMemorySignalBus();
    const sch1 = new InMemoryTimerScheduler();
    const map1 = new Map<unknown, unknown>();
    const exec1 = buildExecutor(bus1, sch1, map1);

    await exec1.start(compiled(twoDelayRace), ['r2']);
    assert.equal(sch1.pendingCount, 2);

    // Simulate restart.
    bus1.clear();
    sch1.stop();
    sch1.clear();
    setProcessExecutor(null);

    // Fresh scheduler starts with zero pending timers.
    const bus2 = new InMemorySignalBus();
    const sch2 = new InMemoryTimerScheduler();
    assert.equal(sch2.pendingCount, 0);

    const map2 = new Map<unknown, unknown>();
    const exec2 = buildExecutor(bus2, sch2, map2);

    const handle = await exec2.start(compiled(twoDelayRace), ['r2']);

    assert.equal(
      sch2.pendingCount,
      2,
      'Two delay branches must be re-scheduled on the new timer scheduler.',
    );
    assert.equal(
      bus2.raceCount,
      1,
      'Race subscription must be re-registered on the new bus.',
    );

    await exec2.emit('edge.tick', { id: 'r2' }, { n: 9 });
    const result = await handle.wait();
    assert.deepEqual(result, { id: 'r2', which: 'tick', n: 9 });
  });

  // --------------------------------------------------------------------------
  // Local variables set before a suspension survive across restart
  // --------------------------------------------------------------------------

  it('handler-local variables set before suspension survive the restart', async () => {
    const bus1 = new InMemorySignalBus();
    const sch1 = new InMemoryTimerScheduler();
    const map1 = new Map<unknown, unknown>();
    const exec1 = buildExecutor(bus1, sch1, map1);

    // countUntilKill sets `count` on each tick; we can use that to
    // observe that the counter survives executor restart.
    const h1 = await exec1.start(compiled(countUntilKill), ['rv1']);
    // We don't need the first handle's result.
    h1.wait().catch(() => {/* ignored across restart */});

    await exec1.emit('edge.tick', { id: 'rv1' }, { n: 1 });
    await exec1.emit('edge.tick', { id: 'rv1' }, { n: 2 });
    await tick();

    const snap1 = await storage.load('edge/count-until-kill/rv1');
    assert.equal(snap1?.status, 'suspended');
    const storedCount = (snap1?.variables as Record<string, unknown>)?.count;
    assert.equal(
      storedCount,
      2,
      'Process-local `count` must be in storage after two ticks.',
    );

    // Restart executor.
    bus1.clear();
    sch1.stop();
    sch1.clear();
    setProcessExecutor(null);

    const bus2 = new InMemorySignalBus();
    const sch2 = new InMemoryTimerScheduler();
    const map2 = new Map<unknown, unknown>();
    const exec2 = buildExecutor(bus2, sch2, map2);

    const h2 = await exec2.start(compiled(countUntilKill), ['rv1']);

    // Another tick, then kill.
    await exec2.emit('edge.tick', { id: 'rv1' }, { n: 3 });
    await exec2.emit('edge.kill', { id: 'rv1' }, { reason: 'done' });

    const result = (await h2.wait()) as { count: number; reason: string; id: string };
    assert.equal(
      result.count,
      3,
      `After restart-and-one-more-tick, count must be 3 (2 pre-restart + 1 post-restart). Got ${result.count}.`,
    );
    assert.equal(result.reason, 'done');
  });

  // --------------------------------------------------------------------------
  // A completed process loads back as completed on the new executor
  // --------------------------------------------------------------------------

  it('completed processes come back as completed with their result intact', async () => {
    const bus1 = new InMemorySignalBus();
    const sch1 = new InMemoryTimerScheduler();
    const map1 = new Map<unknown, unknown>();
    const exec1 = buildExecutor(bus1, sch1, map1);

    const h1 = await exec1.start(compiled(awaitTick), ['rc1']);
    await exec1.emit('edge.tick', { id: 'rc1' }, { n: 77 });
    const r1 = await h1.wait();
    assert.deepEqual(r1, { id: 'rc1', n: 77 });

    // Restart.
    bus1.clear();
    sch1.stop();
    sch1.clear();
    setProcessExecutor(null);

    const bus2 = new InMemorySignalBus();
    const sch2 = new InMemoryTimerScheduler();
    const map2 = new Map<unknown, unknown>();
    const exec2 = buildExecutor(bus2, sch2, map2);

    const h2 = await exec2.start(compiled(awaitTick), ['rc1']);
    const r2 = await h2.wait();
    assert.deepEqual(
      r2,
      { id: 'rc1', n: 77 },
      'Restart-after-completion must return the persisted result; no re-execution allowed.',
    );

    // And no new subscription should have been registered.
    assert.equal(
      bus2.subscriptionCount,
      0,
      'Completed process restart must NOT re-subscribe to its own signals.',
    );
  });

  // --------------------------------------------------------------------------
  // Double restart — state survives multiple cycles for race-based
  // suspensions (works today).
  // --------------------------------------------------------------------------

  it('two restarts in a row preserve state for race-based suspensions', async () => {
    let bus = new InMemorySignalBus();
    let sch = new InMemoryTimerScheduler();
    let map = new Map<unknown, unknown>();
    let exec = buildExecutor(bus, sch, map);

    // countUntilKill uses race() internally, so resubscribeSuspended
    // does pick it up.
    await exec.start(compiled(countUntilKill), ['dr1']);

    for (let i = 0; i < 2; i++) {
      bus.clear();
      sch.stop();
      sch.clear();
      setProcessExecutor(null);

      bus = new InMemorySignalBus();
      sch = new InMemoryTimerScheduler();
      map = new Map<unknown, unknown>();
      exec = buildExecutor(bus, sch, map);

      // Re-start each cycle so the new executor re-subscribes.
      await exec.start(compiled(countUntilKill), ['dr1']);

      const state = await storage.load('edge/count-until-kill/dr1');
      assert.equal(
        state?.status,
        'suspended',
        `After restart cycle ${i + 1}, status must still be 'suspended'.`,
      );
      assert.equal(
        bus.raceCount,
        1,
        `After restart cycle ${i + 1}, the race must be re-registered on the new bus.`,
      );
    }

    // Finally, emit a kill and complete.
    const h = await exec.start(compiled(countUntilKill), ['dr1']);
    await exec.emit('edge.kill', { id: 'dr1' }, { reason: 'dr-done' });
    const r = (await h.wait()) as { count: number; reason: string; id: string };
    assert.equal(r.reason, 'dr-done');
  });
});
