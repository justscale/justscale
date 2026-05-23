/**
 * Process lifecycle edge cases at the runtime boundary.
 *
 * Covers:
 *  - createProcess() stub behaviour when no executor is set
 *  - start-twice idempotency: the executor returns the SAME handle
 *  - cancel() semantics in every process status
 *  - signal subscriptions are torn down on cancel
 *
 * Referenced memories:
 *  - memory/signal-delivery-model.md: "signals sync with process state"
 *  - memory/architecture.md: "ProcessHandle is intentionally NOT a thenable"
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
  EdgeSignals,
} from '../fixtures/runtime-edge-cases.process.js';

function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> }).__compiled;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Process lifecycle', () => {
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
  // Stub behaviour when no executor is set
  // --------------------------------------------------------------------------

  it('calling a compiled process definition with no executor registered throws a clear error', async () => {
    setProcessExecutor(null);

    // awaitTick is the process definition callable (not the .__compiled
    // one — we want the user-facing stub that looks up the global
    // executor).
    await assert.rejects(
      () => awaitTick(['nobody']),
      /No ProcessExecutor available/,
      'The compiled-process stub must throw a clear "no executor" error rather than failing deep in the runtime.',
    );
  });

  // --------------------------------------------------------------------------
  // Idempotent start: same params → same handle
  // --------------------------------------------------------------------------

  it('starting the same process twice returns equivalent handles (idempotent)', async () => {
    const h1 = await executor.start(compiled(awaitTick), ['idem']);
    const h2 = await executor.start(compiled(awaitTick), ['idem']);

    assert.equal(h1.id, h2.id, 'Idempotent start must return the same instance id.');
    assert.equal(h1.path, h2.path);

    // Critically: only ONE subscription is registered, not two.
    assert.equal(
      signalBus.subscriptionCount,
      1,
      'Idempotent start must not double-subscribe to the signal.',
    );

    // Emitting once must complete both handles.
    await executor.emit('edge.tick', { id: 'idem' }, { n: 1 });

    const [r1, r2] = await Promise.all([h1.wait(), h2.wait()]);
    assert.deepEqual(r1, { id: 'idem', n: 1 });
    assert.deepEqual(r2, { id: 'idem', n: 1 });
  });

  // --------------------------------------------------------------------------
  // Starting a completed process returns the existing result immediately
  // --------------------------------------------------------------------------

  it('starting a process that already completed returns its persisted result', async () => {
    const h1 = await executor.start(compiled(awaitTick), ['done1']);
    await executor.emit('edge.tick', { id: 'done1' }, { n: 42 });
    await h1.wait();

    // Start again — should observe the already-completed state.
    const h2 = await executor.start(compiled(awaitTick), ['done1']);
    const r = await h2.wait();
    assert.deepEqual(r, { id: 'done1', n: 42 });
  });

  // --------------------------------------------------------------------------
  // Cancellation — suspended process
  // --------------------------------------------------------------------------

  it('cancel() on a suspended process cleans up subscriptions and rejects wait()', async () => {
    const handle = await executor.start(compiled(twoDelayRace), ['cancel1']);
    handle.wait().catch(() => {/* intentionally ignored */});

    assert.equal(signalBus.raceCount, 1);
    assert.equal(timerScheduler.pendingCount, 2);

    const ok = await handle.cancel();
    assert.equal(ok, true);

    const state = await storage.load('edge/two-delay/cancel1');
    assert.equal(state?.status, 'cancelled');

    // All sub/timer bookkeeping removed.
    assert.equal(signalBus.raceCount, 0, 'Race subscription must be removed on cancel.');
    assert.equal(
      timerScheduler.pendingCount,
      0,
      'Both delay timers must be cancelled on cancel.',
    );

    // Resume attempts are no-ops on a cancelled process.
    const matchCount = await executor.emit('edge.tick', { id: 'cancel1' }, { n: 1 });
    assert.equal(matchCount, 0);
  });

  // --------------------------------------------------------------------------
  // Cancellation — completed process returns false
  // --------------------------------------------------------------------------

  it('cancel() on a completed process returns false and does not change state', async () => {
    const handle = await executor.start(compiled(awaitTick), ['done2']);
    await executor.emit('edge.tick', { id: 'done2' }, { n: 5 });
    const result = await handle.wait();
    assert.deepEqual(result, { id: 'done2', n: 5 });

    const ok = await handle.cancel();
    assert.equal(ok, false);

    const state = await storage.load('edge/await-tick/done2');
    assert.equal(state?.status, 'completed');
  });

  // --------------------------------------------------------------------------
  // Cancellation — non-existent process returns false
  // --------------------------------------------------------------------------

  it('cancel() on a non-existent process returns false', async () => {
    const ok = await executor.cancel('does/not/exist');
    assert.equal(ok, false);
  });

  // --------------------------------------------------------------------------
  // status transitions are visible via storage snapshots
  // --------------------------------------------------------------------------

  it('status moves pending → suspended → completed as the process progresses', async () => {
    const handle = await executor.start(compiled(awaitTick), ['st1']);

    // After start(), the process either already suspended (common, since
    // execute runs synchronously to the first SUSPEND) or is still
    // running. Wait a microtask for it to settle.
    await tick();
    const mid = await storage.load('edge/await-tick/st1');
    assert.equal(
      mid?.status,
      'suspended',
      'Between start() and emit(), the process must be in the suspended state.',
    );

    await executor.emit('edge.tick', { id: 'st1' }, { n: 1 });
    const after = await storage.load('edge/await-tick/st1');
    assert.equal(after?.status, 'completed');

    await handle.wait();
  });

  // --------------------------------------------------------------------------
  // handle.wait() rejects cleanly on cancel, without unhandled rejection
  // --------------------------------------------------------------------------

  it('handle.wait() rejects with a Process cancelled error when cancelled mid-flight', async () => {
    const handle = await executor.start(compiled(awaitTick), ['rej1']);
    const waitPromise = handle.wait();

    const ok = await handle.cancel();
    assert.equal(ok, true);

    await assert.rejects(waitPromise, /Process cancelled/);
  });

  // --------------------------------------------------------------------------
  // BUG SURFACED: cancelled-then-restarted handle.wait() hangs.
  //
  // Today the executor.start() idempotency check looks at `existing`
  // state and, if present, reuses the completion deferred. For
  // `completed`/`failed` statuses it resolves/rejects the deferred.
  // But the `cancelled` branch is NOT handled — the new deferred is
  // never settled, and the handle's wait() hangs indefinitely.
  //
  // See executor.ts `start()` around the "let completion = …" block.
  // The fix is either:
  //   - reject the deferred with 'Process cancelled' for
  //     cancelled-existing, mirroring how `cancel()` does it, OR
  //   - silently rerun the process (revive semantics).
  //
  // This test documents the current (buggy) behaviour so any future
  // change is deliberate and noticed.
  // --------------------------------------------------------------------------

  it('rt-3 fixed: starting a previously-cancelled instance creates a fresh process that can complete', { timeout: 2000 }, async () => {
    const h1 = await executor.start(compiled(awaitTick), ['rev1']);
    h1.wait().catch(() => {/* ignore */});
    await h1.cancel();

    const s1 = await storage.load('edge/await-tick/rev1');
    assert.equal(s1?.status, 'cancelled');

    // Fresh start with the same params — must discard the cancelled state.
    const h2 = await executor.start(compiled(awaitTick), ['rev1']);
    const s2 = await storage.load('edge/await-tick/rev1');
    // After restart the process should be suspended (waiting for tick), not cancelled.
    assert.equal(s2?.status, 'suspended', `expected suspended after restart, got ${s2?.status}`);

    // Drive the process to completion via the edge.tick signal
    await executor.emit('edge.tick', { id: 'rev1' }, { n: 7 });
    const result = await h2.wait() as { id: string; n: number };
    assert.equal(result.n, 7, 'handle.wait() must settle with the new result after restart');
  });
});
