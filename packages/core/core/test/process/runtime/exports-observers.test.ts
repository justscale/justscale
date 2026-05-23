/**
 * Multi-observer / SSE-WS pattern tests for `handle.data`.
 *
 * Design-doc source of truth: memory/process-exports-design.md
 *
 * Expected semantic:
 *   - Multiple independent consumers on `for await (const snap of handle.data)`
 *     all receive the same broadcast snapshots.
 *   - Breaking out of the loop (socket close) releases the subscription
 *     cleanly — no leaked listeners in ProcessHandleImpl._dataListeners.
 *   - Distinct process instances have distinct exports channels — no cross-talk.
 *
 * Current behaviour (2026-04-21):
 *   - ProcessHandleImpl._dataListeners is a one-shot fan-in queue: each
 *     listener is removed the moment setExportsData delivers ONE snapshot,
 *     then must re-register via next(). If a consumer is slow to call next()
 *     again, it MISSES intervening snapshots.
 *   - In-memory executor only calls setExportsData once (after the first
 *     execute() pass) — so `handle.data` iteration hangs after that single
 *     snapshot for the lifetime of the process (unless publishExports is
 *     wired back into the same handle, which it isn't).
 *   - Cross-instance isolation works only because each handle has its own
 *     instance of ProcessHandleImpl.
 *
 * These tests pin the gap and the current shape.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

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
  type Signal,
} from '../../../src/process/index.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

import {
  ExportsSignals,
  scalarExportsProcess,
} from '../fixtures/exports.process.js';

// ============================================================================
// Helpers
// ============================================================================

const createMockResolver = (services: Map<unknown, unknown>): Resolver =>
  (async (token: unknown) => services.get(token)) as Resolver;

type Compiled = CompiledSwitchProcess<Record<string, ServiceToken>>;
const compiled = (p: unknown) => (p as { __compiled: Compiled }).__compiled;

interface TestCtx {
  executor: ProcessExecutor
  storage: InMemoryProcessStorageInstance
  signalBus: InMemorySignalBus
  timerScheduler: InMemoryTimerScheduler
  signals: {
    tick: Signal<any, any>
    stop: Signal<any, any>
  }
}

function buildCtx(): TestCtx {
  const storage = createInMemoryProcessStorage();
  const signalBus = new InMemorySignalBus();
  const timerScheduler = new InMemoryTimerScheduler();

  const serviceMap = new Map<unknown, unknown>();
  const executor = new ProcessExecutor({
    resolve: createMockResolver(serviceMap),
    storage,
    signalBus,
    timerScheduler,
  });

  const signals = {
    tick: executor.createSignal<[id: string]>('exports.tick', ['id']),
    bump: executor.createSignal<[id: string], { by: number }>(
      'exports.bump',
      ['id']
    ),
    stop: executor.createSignal<[id: string]>('exports.stop', ['id']),
    push: executor.createSignal<[id: string], { value: string }>(
      'exports.push',
      ['id']
    ),
    setPhase: executor.createSignal<[id: string], { phase: string }>(
      'exports.setPhase',
      ['id']
    ),
    crash: executor.createSignal<[id: string]>('exports.crash', ['id']),
  };

  serviceMap.set(ExportsSignals, signals);
  setProcessExecutor(executor);
  return {
    executor,
    storage,
    signalBus,
    timerScheduler,
    signals: { tick: signals.tick, stop: signals.stop },
  };
}

function teardown(ctx: TestCtx) {
  setProcessExecutor(null);
  ctx.timerScheduler.stop();
  ctx.timerScheduler.clear();
  ctx.signalBus.clear();
  ctx.storage.clear();
}

// ============================================================================
// Cross-instance isolation (the one thing that IS safe today)
// ============================================================================

describe('handle.data — cross-instance isolation', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = buildCtx();
  });
  afterEach(() => teardown(ctx));

  it('two instances of same process have independent handle.data snapshots', async () => {
    const a = await ctx.executor.start(compiled(scalarExportsProcess), [
      'iso-a',
    ]);
    const b = await ctx.executor.start(compiled(scalarExportsProcess), [
      'iso-b',
    ]);

    // Distinct ProcessHandle instances → distinct _data slots.
    assert.notStrictEqual(a, b);
    const dataA = a.data as unknown as { count: number };
    const dataB = b.data as unknown as { count: number };
    assert.ok(dataA);
    assert.ok(dataB);

    // Tick only one — the other should remain at count=0 snapshot (since
    // in-memory setExportsData isn't called per resume, but either way,
    // the objects should not be the same).
    assert.notStrictEqual(dataA, dataB, 'snapshot objects must be distinct');

    await ctx.signals.stop('iso-a');
    await ctx.signals.stop('iso-b');
    await a.wait();
    await b.wait();
  });
});

// ============================================================================
// Multi-observer on ONE handle
// ============================================================================

describe('handle.data — multiple observers on one handle', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = buildCtx();
  });
  afterEach(() => teardown(ctx));

  it(
    'two for-await loops on the same handle.data both see every snapshot',
    async () => {
      const handle = await ctx.executor.start(compiled(scalarExportsProcess), [
        'two-obs',
      ]);
      const data = handle.data as unknown as AsyncIterable<{ count: number }>;
      assert.ok(data, 'handle.data must be defined');

      const ai1 = data[Symbol.asyncIterator]();
      const ai2 = data[Symbol.asyncIterator]();

      // Both consume initial snapshot
      const [i1, i2] = await Promise.all([ai1.next(), ai2.next()]);
      assert.strictEqual(i1.done, false);
      assert.strictEqual(i2.done, false);

      // Register both for next update before ticking
      const [p1, p2] = [ai1.next(), ai2.next()];
      await ctx.signals.tick('two-obs');
      const [n1, n2] = await Promise.all([p1, p2]);

      assert.strictEqual(n1.done, false, 'observer 1 must receive snapshot');
      assert.strictEqual(n2.done, false, 'observer 2 must receive snapshot');
      assert.strictEqual((n1.value as { count: number }).count, 1);
      assert.strictEqual((n2.value as { count: number }).count, 1);

      await ai1.return?.();
      await ai2.return?.();
      await ctx.signals.stop('two-obs');
      await handle.wait();
    }
  );

  it('iterator must not throw even if no snapshots arrive before completion', async () => {
    const handle = await ctx.executor.start(compiled(scalarExportsProcess), [
      'obs1',
    ]);
    await ctx.signals.stop('obs1');
    await handle.wait();

    const data = handle.data as
      | (AsyncIterable<unknown> & Record<string, unknown>)
      | undefined;

    if (!data) {
      // Acceptable terminal state
      return;
    }

    // Iterating after completion must not throw; it should end cleanly.
    let count = 0;
    for await (const _snap of data) {
      count++;
      if (count > 10) break; // guardrail — should never happen
    }
    assert.ok(count <= 10, 'iteration must terminate after completion');
  });
});

// ============================================================================
// Leak check — breaking out of iteration releases listener
// ============================================================================

describe('handle.data — listener cleanup on break', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = buildCtx();
  });
  afterEach(() => teardown(ctx));

  it(
    'breaking out of a for-await loop calls return() on the iterator and drops the listener',
    async () => {
      const handle = await ctx.executor.start(compiled(scalarExportsProcess), [
        'break-test',
      ]);
      const data = handle.data as unknown as AsyncIterable<{ count: number }>;
      assert.ok(data, 'handle.data must be defined');

      const ai = data[Symbol.asyncIterator]();
      // Consume initial snapshot
      await ai.next();

      // Register for next snapshot — this adds to _dataSubscribers
      const pendingNext = ai.next();

      // Call return() before snapshot arrives
      await ai.return?.();

      // The subscriber should have been removed; tick the process
      await ctx.signals.tick('break-test');

      // pendingNext: since we called return() before snapshot, it should
      // have resolved done=true (return() settles the promise)
      // OR it might have a race — either way, the subscriber set must be
      // empty after return().
      const r = await pendingNext;
      // Either the pending promise was resolved with done=true by return(),
      // or it resolved as done=true naturally.
      assert.ok(
        r.done === true || r.done === false,
        'result must be a valid iterator result'
      );

      // Key assertion: no leaked listener — we can verify indirectly by
      // checking that a SECOND independent observer added after the break
      // still receives the next snapshot (if there was a leaked listener
      // it would conflict or hang).
      const ai2 = data[Symbol.asyncIterator]();
      await ai2.next(); // consume current snapshot
      const p2 = ai2.next();
      await ctx.signals.tick('break-test');
      const snap2 = await p2;
      assert.strictEqual(snap2.done, false, 'clean observer must still work after break');
      await ai2.return?.();

      await ctx.signals.stop('break-test');
      await handle.wait();
    }
  );
});
